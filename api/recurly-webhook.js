import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // Recurly may "validate" the endpoint with GET/HEAD before saving
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).send("ok");
  }

  // Webhooks will be POST
  if (req.method !== "POST") {
    return res.status(200).send("ok"); // be permissive so Recurly can save
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).send("Missing Supabase env vars");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Handle cases where Recurly sends an empty body during validation
    const payload =
      req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
        ? req.body
        : {};

    const eventType = payload?.type || payload?.event_type || "validation";
    const eventId = payload?.id || payload?.event_id || null;

    // Log webhook event (best-effort; don't block Recurly)
    const { error } = await supabase.from("webhook_events").insert({
      provider: "recurly",
      event_type: eventType,
      event_id: eventId,
      payload, // always an object at minimum
    });

    if (error) {
      console.error("Supabase insert error:", error);
      // Still return 200 so Recurly doesn't reject saving / retry forever
      return res.status(200).send("ok");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    // Return 200 to avoid Recurly save/test failures; logs will show the issue
    return res.status(200).send("ok");
  }
}
