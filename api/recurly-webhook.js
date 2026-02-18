// api/recurly-webhook.js
// deploy bump

export const config = {
  api: { bodyParser: false }, // keep raw body (needed later for signature verification)
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Recurly-Signature");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Optional GET for testing in browser
  if (req.method === "GET") return res.status(200).send("OK (GET) - recurly webhook endpoint alive");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const rawBody = await readRawBody(req);
  const bodyText = rawBody.toString("utf8");

  console.log("=== RECURRY WEBHOOK RECEIVED ===");
  console.log("Headers:", req.headers);
  console.log("Raw body:", bodyText);
  console.log("=== END WEBHOOK ===");

  return res.status(200).send("ok");
}
