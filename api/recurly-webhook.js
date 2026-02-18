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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Recurly-Signature");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function recurlyFetch(path) {
  const subdomain = process.env.RECURLY_SUBDOMAIN; // e.g. "meatlaunch"
  const apiKey = process.env.RECURLY_API_KEY;

  if (!subdomain || !apiKey) {
    throw new Error("Missing RECURLY_SUBDOMAIN or RECURLY_API_KEY env var");
  }

  const url = `https://${subdomain}.recurly.com${path}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/vnd.recurly.v2021-02-25+json",
      "Authorization": "Basic " + Buffer.from(`${apiKey}:`).toString("base64"),
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Recurly API ${resp.status}: ${text}`);
  }

  return JSON.parse(text);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).send("OK (GET) - recurly webhook endpoint alive");
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

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

  const eventUuid = payload.uuid || null;          // use as recurly_event_id
  const objectType = payload.object_type || null;  // "payment"
  const paymentId = payload.id || null;            // payment id like "ygh8acybbvey"
  const eventType = payload.event_type || null;    // "succeeded"

  // Dedupe: if we've already processed this event uuid, exit cleanly
  if (eventUuid) {
    const { data: existing, error: existErr } = await supabase
      .from("signup_attempts")
      .select("recurly_event_id")
      .eq("recurly_event_id", eventUuid)
      .maybeSingle();

    if (existErr) console.warn("Dedupe lookup error:", existErr);
    if (existing) return res.status(200).send("ok (duplicate)");
  }

  // We only care about successful payment events
  if (objectType !== "payment" || eventType !== "succeeded" || !paymentId) {
    return res.status(200).send("ok (ignored)");
  }

  // 1) Fetch full payment details from Recurly
  let payment;
  try {
    payment = await recurlyFetch(`/api/v2021-02-25/payments/${paymentId}`);
  } catch (e) {
    console.error("Failed to fetch payment details:", e);
    return res.status(200).send("ok (payment fetch failed)"); // keep 200 to avoid retries storm
  }

  console.log("Recurly payment details:", payment);

  // Extract email + invoice/subscription/transaction ids where available
  const email =
    payment?.account?.email ||
    payment?.billing_info?.email ||
    null;

  const invoiceId = payment?.invoice?.id || null;
  const transactionId = payment?.id || paymentId; // payment id is useful regardless
  // subscription might not be directly on payment; often via invoice line items
  const subscriptionId =
    payment?.subscription?.id ||
    payment?.invoice?.subscription?.id ||
    null;

  const amount = payment?.amount ?? null;
  const currency = payment?.currency ?? null;

  if (!email) {
    console.warn("Could not determine email from payment; cannot attribute.");
    return res.status(200).send("ok (no email)");
  }

  // 2) Find most recent pending attempt for that email (last 6 hours)
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

  // 3) Mark paid
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
