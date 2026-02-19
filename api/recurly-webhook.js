import { createClient } from "@supabase/supabase-js";

async function fetchRecurlySubscription(uuid) {
  const apiKey = process.env.RECURLY_API_KEY;
  if (!apiKey) throw new Error("Missing RECURLY_API_KEY");

  const url = `https://v3.recurly.com/subscriptions/${uuid}`;

const resp = await fetch(url, {
  method: "GET",
  headers: {
    Accept: "application/vnd.recurly.v2021-02-25",
    "Accept-Language": "en-US",
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
  },
});

  });

  const text = await resp.text();

  // 🔥 ONE LINE THAT'S EASY TO FIND
  console.log(
    `### RECURLY_FETCH uuid=${uuid} status=${resp.status} snippet=${text.slice(0, 300).replace(/\s+/g, " ")}`
  );

  if (!resp.ok) throw new Error(`Recurly fetch failed ${resp.status}: ${text}`);

  return JSON.parse(text);
}

export default async function handler(req, res) {
  // Debug endpoint: /api/recurly-webhook?debug_uuid=XYZ
  if (req.method === "GET" && req.query?.debug_uuid) {
    try {
      const uuid = String(req.query.debug_uuid);
      const sub = await fetchRecurlySubscription(uuid);
      return res.status(200).json({
        ok: true,
        uuid,
        plan_code: sub?.plan?.code ?? null,
        state: sub?.state ?? sub?.status ?? null,
        account_code: sub?.account?.code ?? null,
        account_email: sub?.account?.email ?? sub?.account?.bill_to?.email ?? null,
        keys: Object.keys(sub || {}),
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok-v3");
  if (req.method !== "POST") return res.status(200).send("ok-v3");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).send("Missing Supabase env vars");

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const eventType = payload?.event_type || payload?.type || "unknown";
    const eventId = payload?.id || payload?.event_id || null;
    const subUuid = payload?.uuid || null;

    console.log(`### WEBHOOK_RECEIVED type=${eventType} uuid=${subUuid}`);

    // log raw webhook
    await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload,
    });

    if (!subUuid) return res.status(200).send("ok");

    const sub = await fetchRecurlySubscription(subUuid);

    const provider_subscription_id = sub?.uuid || subUuid;
    const plan_code = sub?.plan?.code || null;
    const status = sub?.state || sub?.status || null;
    const current_period_end = sub?.current_period_ends_at || sub?.current_term_ends_at || null;

    const email = sub?.account?.email || sub?.account?.bill_to?.email || null;
    const account_code = sub?.account?.code || null;

    console.log(
      `### PARSED provider_subscription_id=${provider_subscription_id} plan_code=${plan_code} status=${status} email=${email} account_code=${account_code}`
    );

    // shop lookup
    let shop_id = null;
    if (plan_code) {
      const { data: shopRow } = await supabase
        .from("shops")
        .select("id")
        .eq("plan_code", plan_code)
        .maybeSingle();
      shop_id = shopRow?.id || null;
    }

    if (!provider_subscription_id || !email || !plan_code) {
      console.log(`### SKIP_UPSERT missing provider_subscription_id/email/plan_code`);
      return res.status(200).send("ok");
    }

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
    else console.log(`### UPSERT_OK uuid=${provider_subscription_id}`);

    return res.status(200).send("ok");
  } catch (err) {
    console.log(`### WEBHOOK_ERROR ${String(err?.message || err)}`);
    return res.status(200).send("ok");
  }
}
