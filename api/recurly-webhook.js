// api/recurly-webhook.js
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false },
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

function getRecurlyAuthHeader() {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY env var");
  // Recurly v3 uses Basic auth where username=API_KEY and password is blank
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

// Always use v3.recurly.com for the v2021 API
async function recurlyGet(path) {
  const url = `https://v3.recurly.com${path}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.recurly.v2021-02-25+json",
      Authorization: getRecurlyAuthHeader(),
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
  const bodyText = rawBody.toString("utf8");

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    console.error("Webhook JSON parse error:", e);
    return res.status(400).send("invalid json");
  }

  console.log("Recurly webhook payload (short):", payload);

  const eventUuid = payload.uuid || null;          // event uuid (dedupe)
  const objectType = payload.object_type || null;  // "payment"
  const eventType = payload.event_type || null;    // "succeeded"
  const transactionId = payload.id || null;        // IMPORTANT: use this for /transactions/{id}

  // Dedupe
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
  if (objectType !== "payment" || eventType !== "succeeded" || !transactionId) {
    return res.status(200).send("ok (ignored)");
  }

  // 1) Fetch transaction details
  let txn;
  try {
    txn = await recurlyGet(`/api/v2021-02-25/transactions/${transactionId}`);
  } catch (e) {
    console.error("Failed to fetch transaction:", e);
    return res.status(200).send("ok (txn fetch failed)");
  }

  // 2) Get account + email (most reliable)
  const accountId = txn?.account?.id || txn?.account_id || null;

  let email = txn?.account?.email || null;
  if (!email && accountId) {
    try {
      const acct = await recurlyGet(`/api/v2021-02-25/accounts/${accountId}`);
      email = acct?.email || null;
    } catch (e) {
      console.error("Failed to fetch account:", e);
    }
  }

  if (!email) {
    console.warn("Could not determine email from transaction/account.");
    return res.status(200).send("ok (no email)");
  }

  email = String(email).trim().toLowerCase();

  const amount = txn?.amount ?? null;
  const currency = txn?.currency ?? null;
  const invoiceId = txn?.invoice?.id || txn?.invoice_id || null;
  const subscriptionId =
    txn?.subscription?.id || txn?.subscription_id || txn?.invoice?.subscription?.id || null;

  // 3) Find most recent pending attempt for that email (last 6 hours)
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

  // 4) Mark paid
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
