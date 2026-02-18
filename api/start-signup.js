import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // or your Wix domain later
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

export default async function handler(req, res) {
  setCors(res);

  // ✅ Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Optional GET for “alive”
  if (req.method === "GET") {
    return res.status(200).send("OK (GET) - endpoint alive");
  }

  // ✅ Real call must be POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { shopId, employeeCode, email } = req.body || {};

    if (!shopId || !employeeCode || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("signup_attempts")
      .insert([
        {
          shop_id: String(shopId).toUpperCase().trim(),
          employee_code: String(employeeCode).toUpperCase().trim(),
          email: String(email).toLowerCase().trim(),
          status: "PENDING",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Database error", details: error.message });
    }

    return res.status(200).json({ ok: true, row: data });
  } catch (e) {
    console.error("Server crash:", e);
    return res.status(500).json({ error: "Server error", details: e?.message || String(e) });
  }
}
