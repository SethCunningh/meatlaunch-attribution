import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Allow Wix to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { shopId, employeeCode, email } = req.body || {};

  if (!shopId || !employeeCode || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { error } = await supabase
    .from("signup_attempts")
    .insert([
      {
        shop_id: shopId.toUpperCase().trim(),
        employee_code: employeeCode.toUpperCase().trim(),
        email: email.toLowerCase().trim(),
        status: "PENDING"
      }
    ]);

  if (error) {
    console.error("Supabase insert error:", error);
    return res.status(500).json({ error: "Database error" });
  }

  return res.status(200).json({ success: true });
}
