// api/recurly-webhook.js
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

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

function recurlyAuth() {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY env var");
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

async function recurlyGet(path) {
  const url = `https://v3.recurly.com${path}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.recurly.v2021-02-25+json",
      Authorization: recurlyAuth(),
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Recurly API ${resp.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET")
    return res.status(200).send("OK (GET) - recurly webhook endpoint alive");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  const rawBody = await readRawBody(req);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    console.error("Webhook JSON parse error:", e);
    return res.status(400).send("invalid json");
  }

  console.log("Recurly webhook payload (short):", payload);

  const eventUuid = payload.uuid || null;
  const objectType = payload.object_type || null; // "payment"
  const eventType = payload.event_type || null;   // "succeeded"
  const paymentId = payload.id || null;           // yghskgngqynb1

  // dedupe by event uuid
  if (eventUuid) {
    const { data: existing } = await supabase
      .from("signup_attempts")
      .select("recurly_event_id")
      .eq("recurly_event_id", eventUuid)
      .maybeSingle();

    if (existing) return res.status(200).send("ok (duplicate)");
  }

  // Only handle payment.succeeded
  if (objectType !== "payment" || eventType !== "succeeded" || !paymentId) {
    return res.status(200).send("ok (ignored)");
  }

  // 1) Fetch payment details
  let payment;
  try {
    payment = await recurlyGet(`/api/v2021-02-25/payments/${paymentId}`);
  } catch (e) {
    console.error("Failed to fetch payment:", e);
    return res.status(200).send("ok (payment fetch failed)");
  }

  // 2) Fetch account for email (most reliable)
  const accountId =
    payment?.account?.id ||
    payment?.account_id ||
    null;

  let email = payment?.account?.email || null;

  if (!email && accountId) {
    try {
      const acct = await recurlyGet(`/api/v2021-02-25/accounts/${accountId}`);
      email = acct?.email || null;
    } catch (e) {
      console.error("Failed to fetch account:", e);
    }
  }

  if (!email) {
    console.warn("No email found from payment/account.");
    return res.status(200).send("ok (no email)");
  }

  email = String(email).trim().toLowerCase();

  const invoiceId = payment?.invoice?.id || payment?.invoice_id || null;
  const amount = payment?.amount ?? null;
  const currency = payment?.currency ?? null;

  // 3) Find latest PENDING attempt for email in last 6 hours
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
    console.warn("No matching pending attempt for:", email);
    return res.status(200).send("ok (no matching attempt)");
  }

  // 4) Mark paid
  const { error: updErr } = await supabase
    .from("signup_attempts")
    .update({
      status: "PAID",
      completed_at: new Date().toISOString(),
      recurly_event_id: eventUuid,
      recurly_invoice_id: invoiceId,
      recurly_transaction_id: paymentId, // store paymentId here if your column name is txn_id
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
