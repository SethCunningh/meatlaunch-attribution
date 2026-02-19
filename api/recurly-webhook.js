// api/recurly-webhook.js
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false }, // keep raw body for signature verification later
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
 * Recurly v3 JSON API helper
 * Host MUST be v3.recurly.com (not your subdomain admin host)
 */
async function recurlyFetch(path) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY env var");

  const url = `https://v3.recurly.com${path}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.recurly.v2021-02-25+json",
      Authorization: "Basic " + Buffer.from(`${apiKey}:`).toString("base64"),
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    // Recurly returns JSON on errors sometimes, but can return HTML too.
    throw new Error(`Recurly API ${resp.status}: ${text}`);
  }

  return JSON.parse(text);
}

export default async function handler(req, res) {
  setCors(res);

  // Preflight / debug
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET")
    return res.status(200).send("OK (GET) - recurly webhook endpoint alive");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  // Read raw body
  const rawBody = await readRawBody(req);
  const bodyText = rawBody.toString("utf8");

  // Parse JSON payload (short payload when Recurly endpoint set to "JSON")
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    console.error("Webhook JSON parse error:", e);
    return res.status(400).send("invalid json");
  }

  console.log("Recurly webhook payload (short):", payload);

  // Recurly short payload fields
  const eventUuid = payload.uuid || null; // great for dedupe
  const objectType = payload.object_type || null; // "payment"
  const paymentId = payload.id || null; // payment id like "ygh8acybbvey"
  const eventType = payload.event_type || null; // "succeeded"

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

  // Only handle successful payment events
  if (objectType !== "payment" || eventType !== "succeeded" || !paymentId) {
    return res.status(200).send("ok (ignored)");
  }

  // Fetch full payment details from Recurly (v3 API)
  let payment;
  try {
    const txnUuid = payload.uuid;

// Query transactions by uuid (works even when /uuid-... routes don’t)
const txns = await recurlyFetch(`/api/v2021-02-25/transactions?uuid=${txnUuid}`);
const txn = Array.isArray(txns?.data) ? txns.data[0] : null;

if (!txn) {
  throw new Error(`No transaction found for uuid ${txnUuid}`);
}

payment = txn; // keep the rest of your code unchanged


  } catch (e) {
    console.error("Failed to fetch payment details:", e);
    // Return 200 so Recurly doesn't hammer retries while we debug
    return res.status(200).send("ok (payment fetch failed)");
  }

  console.log("Recurly payment details:", payment);

  // Extract attribution fields (best-effort)
 const email =
  payment?.account?.email ||
  payment?.account?.billing_info?.email ||
  payment?.billing_info?.email ||
  null;


  const invoiceId = payment?.invoice?.id || null;
  const transactionId = payment?.id || paymentId;

  // subscription may or may not be present on payment; keep best-effort
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

  // Find most recent pending attempt for that email in last 6 hours
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

  // Mark PAID
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
