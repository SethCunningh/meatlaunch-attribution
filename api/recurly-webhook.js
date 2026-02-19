import { createClient } from "@supabase/supabase-js";

async function fetchRecurlySubscription(uuid) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY");

  const url = `https://v3.recurly.com/subscriptions/${uuid}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Recurly-Version": "2021-02-25",
    },
  });

  const text = await resp.text();
  console.log("Recurly GET", url, "status", resp.status, "body_snippet", text.slice(0, 200));

  if (!resp.ok) throw new Error(`Recurly fetch failed ${resp.status}: ${text}`);

  return JSON.parse(text);
}

export default async function handler(req, res) {
  // Recurly may validate endpoint with GET/HEAD
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(200).send("ok");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).send("Missing Supabase env vars");
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};

    const eventType = payload?.event_type || payload?.type || "unknown";
    const eventId = payload?.id || payload?.event_id || null;

    // 1) Always log raw webhook payload
    const { error: logErr } = await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload,
    });

    if (logErr) console.error("Supabase webhook_events insert error:", logErr);

    // 2) Slim Recurly JSON webhook gives us subscription uuid
    const subUuid = payload?.uuid;
    console.log("Webhook eventType:", eventType, "subUuid:", subUuid);

    if (!subUuid) return res.status(200).send("ok");

    // 3) Fetch full subscription details from Recurly API
    const sub = await fetchRecurlySubscription(subUuid);

    const provider_subscription_id = sub?.uuid || subUuid;
    const plan_code = sub?.plan?.code || null;
    const status = sub?.state || sub?.status || null;
    const current_period_end = sub?.current_period_ends_at || sub?.current_term_ends_at || null;

    const email =
      sub?.account?.email ||
      sub?.account?.bill_to?.email ||
      null;

    const account_code = sub?.account?.code || null;

    // Map shop by plan_code (shops.plan_code should match recurly plan code)
    let shop_id = null;
    if (plan_code) {
      const { data: shopRow, error: shopErr } = await supabase
        .from("shops")
        .select("id")
        .eq("plan_code", plan_code)
        .maybeSingle();

      if (shopErr) console.error("Shop lookup error:", shopErr);
      shop_id = shopRow?.id || null;
    }

    console.log("Parsed subscription:", {
      provider_subscription_id,
      plan_code,
      status,
      email,
      account_code,
      shop_id,
      current_period_end,
    });

    // 4) Upsert into subscriptions
    if (provider_subscription_id && email && plan_code) {
      const { error: upsertErr } = await supabase.from("subscriptions").upsert(
        {
          provider: "recurly",
          provider_subscription_id,
          account_code,
          email,
          plan_code,
          shop_id,
          status: status || (eventType === "canceled" ? "canceled" : "active"),
          current_period_end,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "provider_subscription_id" }
      );

      if (upsertErr) console.error("Subscriptions upsert error:", upsertErr);
    } else {
      console.log("Skipping upsert (missing one of):", {
        provider_subscription_id: !!provider_subscription_id,
        email: !!email,
        plan_code: !!plan_code,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    // Still return 200 so Recurly doesn't retry spam
    return res.status(200).send("ok");
  }
}
