import { createClient } from "@supabase/supabase-js";

async function fetchRecurlySubscription(uuid) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY");

  const url = `https://v3.recurly.com/subscriptions/${uuid}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      // ✅ Recurly requires versioned Accept header
      Accept: "application/vnd.recurly.v2021-02-25",
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
  });

  const text = await resp.text();
  console.log("Recurly GET", url, "status", resp.status, "body_snippet", text.slice(0, 200));

  if (!resp.ok) throw new Error(`Recurly fetch failed ${resp.status}: ${text}`);

  return JSON.parse(text);
}

export default async function handler(req, res) {
  // ✅ This must be inside the handler
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok-v2");
  if (req.method !== "POST") return res.status(200).send("ok-v2");

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

    // 1) Log raw webhook payload
    const { error: logErr } = await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload,
    });
    if (logErr) console.error("Supabase webhook_events insert error:", logErr);

    // 2) Slim payload contains subscription uuid
    const subUuid = payload?.uuid;
    console.log("Webhook eventType:", eventType, "subUuid:", subUuid);
    if (!subUuid) return res.status(200).send("ok");

    // 3) Fetch full subscription from Recurly
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

    // 4) Map shop by plan_code
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

    // 5) Upsert into subscriptions
    if (provider_subscription_id && email && plan_code) {
      const { error: upsertErr } = await supabase.from("subscriptions").upsert(
        {
          provider: "recurly",
          provider_subscription_id,
          account_code,
          email,
          plan_code,
          shop_id,
          status: status || "active",
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
    return res.status(200).send("ok");
  }
}
