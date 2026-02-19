import { createClient } from "@supabase/supabase-js";

/**
 * Fetch a Recurly subscription by SUBSCRIPTION ID (this is payload.id from webhook),
 * NOT the webhook uuid (payload.uuid is the event uuid).
 */
async function fetchRecurlySubscription(subscriptionId) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY");

  const url = `https://v3.recurly.com/subscriptions/${subscriptionId}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      // Recurly wants API version in Accept header like this:
      Accept: "application/vnd.recurly.v2021-02-25",
      // optional but safe:
      "Accept-Language": "en-US",
      // Recurly uses HTTP Basic, username = API key, password blank
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
  });

  const text = await resp.text();

  // easy-to-find log line
  console.log(
    `### RECURLY_FETCH id=${subscriptionId} status=${resp.status} snippet=${text
      .slice(0, 300)
      .replace(/\s+/g, " ")}`
  );

  if (!resp.ok) {
    throw new Error(`Recurly fetch failed ${resp.status}: ${text}`);
  }

  return JSON.parse(text);
}

export default async function handler(req, res) {
  // ✅ Debug endpoint:
  // https://YOURDOMAIN.vercel.app/api/recurly-webhook?debug_id=SUBSCRIPTION_ID
  if (req.method === "GET" && req.query?.debug_id) {
    try {
      const id = String(req.query.debug_id);
      const sub = await fetchRecurlySubscription(id);

      return res.status(200).json({
        ok: true,
        id,
        plan_code: sub?.plan?.code ?? null,
        state: sub?.state ?? sub?.status ?? null,
        account_code: sub?.account?.code ?? null,
        email: sub?.account?.email ?? sub?.account?.bill_to?.email ?? null,
        keys: Object.keys(sub || {}),
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e?.message || e) });
    }
  }

  // healthcheck
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok-v4");
  if (req.method !== "POST") return res.status(200).send("ok-v4");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).send("Missing Supabase env vars");

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};

    // Recurly webhook event info
    const eventType = payload?.event_type || payload?.type || "unknown";
    const eventId = payload?.id || payload?.event_id || null; // NOTE: for subscription.created this is the subscription ID
    const objectType = payload?.object_type || null;
    const eventUuid = payload?.uuid || null;

    console.log(`### WEBHOOK_RECEIVED type=${eventType} object=${objectType} id=${eventId} uuid=${eventUuid}`);

    // 1) Always store raw webhook
    const { error: whErr } = await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload,
    });

    if (whErr) console.log(`### WEBHOOK_INSERT_ERROR ${JSON.stringify(whErr)}`);

    // 2) Only proceed if this is a subscription object and we have an ID
    // IMPORTANT: subscription id is payload.id
    const subscriptionId = payload?.id || null;
    if (!subscriptionId) {
      console.log("### SKIP no subscriptionId in payload.id");
      return res.status(200).send("ok");
    }

    // 3) Fetch full subscription from Recurly
    const sub = await fetchRecurlySubscription(subscriptionId);

    const provider_subscription_id = sub?.id || subscriptionId; // Recurly v3 subscription id
    const plan_code = sub?.plan?.code || null;
    const status = sub?.state || sub?.status || null;
    const current_period_end =
      sub?.current_period_ends_at || sub?.current_term_ends_at || null;

    const email = sub?.account?.email || sub?.account?.bill_to?.email || null;
    const account_code = sub?.account?.code || null;

    console.log(
      `### PARSED provider_subscription_id=${provider_subscription_id} plan_code=${plan_code} status=${status} email=${email} account_code=${account_code}`
    );

    // 4) Shop lookup by plan_code
    let shop_id = null;
    if (plan_code) {
      const { data: shopRow, error: shopErr } = await supabase
        .from("shops")
        .select("id")
        .eq("plan_code", plan_code)
        .maybeSingle();

      if (shopErr) console.log(`### SHOP_LOOKUP_ERROR ${JSON.stringify(shopErr)}`);
      shop_id = shopRow?.id || null;
    }

    if (!provider_subscription_id || !email || !plan_code) {
      console.log(`### SKIP_UPSERT missing provider_subscription_id/email/plan_code`);
      return res.status(200).send("ok");
    }

    // 5) Upsert subscription
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

    if (upsertErr) console.log(`### UPSERT_ERROR ${JSON.stringify(upsertErr)}`);
    else console.log(`### UPSERT_OK id=${provider_subscription_id}`);

    return res.status(200).send("ok");
  } catch (err) {
    console.log(`### WEBHOOK_ERROR ${String(err?.message || err)}`);
    // Always 200 so Recurly doesn't keep retrying forever while you're testing
    return res.status(200).send("ok");
  }
}
