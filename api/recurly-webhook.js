// api/recurly-webhook.js
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false }, // keep raw body
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Recurly-Signature"
  );
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Recurly v3 API GET helper with strong logging
 */
async function recurlyGet(path, query = {}) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY env var");

  const url = new URL(`https://v3.recurly.com${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
  });

  // IMPORTANT: Some Recurly setups accept Basic auth, others accept Bearer.
  // We'll try Bearer first; if it fails with 401/403, we'll try Basic.
  const headersBase = {
    Accept: "application/vnd.recurly.v2021-02-25+json",
    "User-Agent": "meatlaunch-attribution-webhook/1.0",
  };

  async function doFetch(authHeader) {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { ...headersBase, Authorization: authHeader },
    });
    const text = await resp.text();

    // log only a small snippet to avoid noise
    console.log("Recurly GET:", url.toString(), "status:", resp.status);
    if (!resp.ok) console.log("Recurly error snippet:", text.slice(0, 200));

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // if HTML comes back, this will fail, which is fine
    }

    return { resp, text, json };
  }

  // Try Bearer
  let r = await doFetch(`Bearer ${apiKey}`);
  if (r.resp.ok) return r.json;

  // If unauthorized/forbidden, try Basic auth
  if (r.resp.status === 401 || r.resp.status === 403) {
    r = await doFetch(
      "Basic " + Buffer.from(`${apiKey}:`).toString("base64")
    );
    if (r.resp.ok) return r.json;
  }

  throw new Error(`Recurly API ${r.resp.status}`);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET")
    return res.status(200).send("OK (GET) - recurly webhook endpoint alive");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  const rawBody = await readRawBody(req);
  const bodyText = rawBody.toString("utf8");

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    console.error("Webhook JSON parse error:", e);
    return res.status(400).send("invalid json");
  }

  console.log("Recurly webhook payload (short):", payload);

  const eventUuid = payload.uuid || null;
  const objectType = payload.object_type || null; // "payment"
  const eventType = payload.event_type || null;   // "succeeded"
  const paymentId = payload.id || null;

  // Dedupe
  if (eventUuid) {
    const { data: existing } = await supabase
      .from("signup_attempts")
      .select("recurly_event_id")
      .eq("recurly_event_id", eventUuid)
      .maybeSingle();

    if (existing) return res.status(200).send("ok (duplicate)");
  }

  // Only act on payment succeeded
  if (objectType !== "payment" || eventType !== "succeeded") {
    return res.status(200).send("ok (ignored)");
  }

  // ---- Fetch details from Recurly ----
  let payment = null;

  try {
    // Most reliable: find transaction by "ids=uuid-<uuid>"
    if (eventUuid) {
      const txnsByIds = await recurlyGet(
        "/api/v2021-02-25/transactions",
        { ids: `uuid-${eventUuid}`, limit: "1" }
      );
      const txn = Array.isArray(txnsByIds?.data) ? txnsByIds.data[0] : null;
      if (txn) payment = txn;
    }

    // Fallback: try query by uuid directly (some accounts support it)
    if (!payment && eventUuid) {
      const txnsByUuid = await recurlyGet(
        "/api/v2021-02-25/transactions",
        { uuid: eventUuid, limit: "1" }
      );
      const txn = Array.isArray(txnsByUuid?.data) ? txnsByUuid.data[0] : null;
      if (txn) payment = txn;
    }

    // Fallback: hit payments/<id> if we have a paymentId
    if (!payment && paymentId) {
      payment = await recurlyGet(`/api/v2021-02-25/payments/${paymentId}`);
    }

    if (!payment) throw new Error("Could not resolve payment/transaction from webhook");
  } catch (e) {
    console.error("Failed to fetch payment details:", e);
    return res.status(200).send("ok (payment fetch failed)");
  }

  console.log("Recurly resolved payment/transaction:", payment);

  // ---- Extract email ----
  const email =
    payment?.account?.email ||
    payment?.billing_info?.email ||
    payment?.account?.bill_to?.email ||
    null;

  if (!email) {
    console.warn("Could not determine email from payment; cannot attribute.");
    return res.status(200).send("ok (no email)");
  }

  // Optional IDs you may want
  const invoiceId = payment?.invoice?.id || payment?.invoice_id || null;
  const transactionId = payment?.id || null;
  const subscriptionId =
    payment?.subscription?.id ||
    payment?.invoice?.subscription?.id ||
    null;

  const amount = payment?.amount ?? null;
  const currency = payment?.currency ?? null;

  // ---- Find latest pending attempt for that email ----
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: attempt, error: attemptErr } = await supabase
    .from("signup_attempts")
    .select("*")
    .eq("email", email)
    .eq("status", "PENDING")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (attemptErr) {
    console.error("Attempt lookup error:", attemptErr);
    return res.status(200).send("ok (attempt lookup failed)");
  }

  if (!attempt) {
    console.warn("No matching pending attempt found for email:", email);
    return res.status(200).send("ok (no matching attempt)");
  }

  // ---- Mark paid ----
  const { error: updErr } = await supabase
    .from("signup_attempts")
    .update({
      status: "PAID",
      completed_at: new Date().toISOString(),
      recurly_event_id: eventUuid,
      recurly_invoice_id: invoiceId,
      recurly_transaction_id: transactionId,
      recurly_subscription_id: subscriptionId,
      amount,
      currency,
    })
    .eq("id", attempt.id);

  if (updErr) {
    console.error("Supabase update error:", updErr);
    return res.status(200).send("ok (update failed)");
  }

  console.log("Marked signup_attempt PAID:", attempt.id, email);
  return res.status(200).send("ok");
}
