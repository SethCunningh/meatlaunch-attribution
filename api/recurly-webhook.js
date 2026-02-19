import { createClient } from "@supabase/supabase-js";

function pickSubscription(payload) {
  // Recurly JSON webhooks can vary a bit depending on version/config
  return (
    payload?.data?.subscription ||
    payload?.subscription ||
    payload?.data?.object ||
    payload?.object ||
    null
  );
}

export default async function handler(req, res) {
  // Keep Recurly validation happy
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(200).send("ok");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).send("Missing Supabase env vars");

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = (req.body && typeof req.body === "object") ? req.body : {};

    // 1) Always log the webhook (debugging lifesaver)
    const eventType = payload?.type || payload?.event_type || "unknown";
    const eventId = payload?.id || payload?.event_id || null;

    await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload,
    });

    // 2) Try to upsert subscription row
    const sub = pickSubscription(payload);
    if (sub) {
      const provider_subscription_id = sub?.uuid || sub?.id || sub?.subscription_id || null;
      const plan_code = sub?.plan?.code || sub?.plan_code || null;

      // email/account_code can appear in a few places
      const email =
        sub?.account?.email ||
        sub?.account?.bill_to?.email ||
        payload?.data?.account?.email ||
        payload?.account?.email ||
        null;

      const account_code =
        sub?.account?.code ||
        payload?.data?.account?.code ||
        payload?.account?.code ||
        null;

      const status =
        sub?.state ||
        sub?.status ||
        (eventType.includes("canceled") ? "canceled" : "active");

      const current_period_end =
        sub?.current_period_ends_at ||
        sub?.current_term_ends_at ||
        sub?.current_period_end ||
        null;

      // Map shop by plan_code
      let shop_id = null;
      if (plan_code) {
        const { data: shopRow } = await supabase
          .from("shops")
          .select("id")
          .eq("plan_code", plan_code)
          .maybeSingle();
        shop_id = shopRow?.id || null;
      }

      // Upsert into subscriptions
      if (provider_subscription_id && email && plan_code) {
        await supabase.from("subscriptions").upsert(
          {
            provider: "recurly",
            provider_subscription_id,
            account_code,
            email,
            plan_code,
            shop_id,
            status,
            current_period_end,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "provider_subscription_id" }
        );
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook handler error:", err);
    // Return 200 so Recurly doesn't freak out / block saving
    return res.status(200).send("ok");
  }
}
