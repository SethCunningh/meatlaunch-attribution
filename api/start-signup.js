import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  console.log("HIT /api/start-signup", req.method);

  // ✅ If GET, just respond so we can tell it was hit
  if (req.method === "GET") {
    return res.status(200).send("OK (GET) - endpoint alive");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const { shopId, employeeCode, email } = req.body || {};
    console.log("BODY", { shopId, employeeCode, email });

    if (!shopId || !employeeCode || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("signup_attempts")
      .insert([
        {
          shop_id: shopId,
          employee_code: employeeCode,
          email,
          status: "PENDING"
        }
      ])
      .select("id, created_at")
      .single();

    if (error) {
      console.log("SUPABASE ERROR", error);
      return res.status(500).json({ error: error.message });
    }

    console.log("INSERT OK", data);
    return res.status(200).json({ ok: true, attemptId: data.id, createdAt: data.created_at });
  } catch (e) {
    console.log("SERVER ERROR", e);
    return res.status(500).json({ error: "Server error" });
  }
}
