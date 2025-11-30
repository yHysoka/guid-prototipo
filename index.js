import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const { createClient } = pkg;

// ======================================================
// SUPABASE
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ======================================================
// APP
// ======================================================
const app = express();
app.use(cors());

// PRECISA vir antes do express.json
app.use(express.text({ type: "*/*" }));
app.use(express.json({ strict: false }));

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// CREATE CHECKOUT — GUIED PRO / PRO+
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    let normalizedPlan = "pro";
    if (plan && plan.toLowerCase() === "pro_plus") normalizedPlan = "pro_plus";

    console.log("🟦 Criando checkout para:", user_id, "Plano:", normalizedPlan);

    const price = 9.9;

    const mpRes = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              title:
                normalizedPlan === "pro_plus"
                  ? "Assinatura Guied PRO+"
                  : "Assinatura Guied PRO",
              quantity: 1,
              unit_price: price,
            },
          ],
          statement_descriptor: "GUIED",
          external_reference: `${user_id}|${normalizedPlan}`,
          metadata: { user_id, plan: normalizedPlan },
          back_urls: {
            success: "https://guied.app/sucesso",
            pending: "https://guied.app/pendente",
            failure: "https://guied.app/erro",
          },
          auto_return: "approved",
          notification_url:
            "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
        }),
      }
    );

    const json = await mpRes.json();
    console.log("🟦 RESPOSTA CHECKOUT:", json);

    if (!json.init_point) {
      return res.status(400).json({ error: "Falha ao criar checkout", mp: json });
    }

    return res.json({
      init_point: json.init_point,
      preference_id: json.id,
    });
  } catch (err) {
    console.error("❌ Erro create-checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK MERCADO PAGO — SUPORTA QUALQUER FORMATO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    console.log("🟪 WEBHOOK RECEBIDO");

    let body = req.body;

    // Caso o Mercado Pago envie como texto puro
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.log("📩 BODY RAW STRING:", body);
      }
    }

    console.log("📩 BODY PARSED:", body);

    let paymentId = null;

    // Suporta todos os formatos do MP
    if (body?.data?.id) paymentId = body.data.id;
    if (!paymentId && body["data.id"]) paymentId = body["data.id"];
    if (!paymentId && body.id) paymentId = body.id;
    if (!paymentId && body.resource) paymentId = body.resource;

    if (!paymentId) {
      console.log("🚫 BODY NÃO TEM ID → ignorando");
      return res.status(200).send("ok");
    }

    console.log("🔎 PaymentId extraído:", paymentId);

    const r = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      }
    );

    const info = await r.json();
    console.log("🔎 PAYMENT FULL INFO:", info);

    if (info.status !== "approved") {
      console.log("⏳ Pagamento pendente → ignorando");
      return res.status(200).send("ok");
    }

    let user_id = info?.metadata?.user_id;
    let plan = info?.metadata?.plan;

    if (!user_id || !plan) {
      const [u, p] = (info.external_reference || "").split("|");
      if (!user_id) user_id = u;
      if (!plan) plan = p;
    }

    if (!user_id || !isUuid(user_id)) {
      console.log("🚫 user_id inválido no webhook");
      return res.status(200).send("ok");
    }

    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const { error: insertError } = await supabase.from("subscriptions").insert({
      user_id,
      plan,
      status: "active",
      started_at: now.toISOString(),
      expires_at: expires.toISOString(),
      payment_id: info.id,
      preference_id: info.external_reference,
    });

    if (insertError) {
      console.error("❌ Erro ao inserir assinatura:", insertError);
    } else {
      console.log("🔥 ASSINATURA ATIVADA:", user_id, plan);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro webhook:", err);
    return res.status(200).send("ok");
  }
});

// ======================================================
// STATUS DA ASSINATURA
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id || req.query.userId;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    const { data } = await supabase
      .from("subscriptions")
      .select("status, plan, expires_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      return res.json({ status: "free", plan: "free", expires_at: null });
    }

    const now = new Date();
    const exp = data.expires_at ? new Date(data.expires_at) : null;

    const active =
      data.status === "active" && exp && exp > now;

    return res.json(
      active
        ? { status: data.status, plan: data.plan, expires_at: data.expires_at }
        : { status: "free", plan: "free", expires_at: data.expires_at }
    );
  } catch (err) {
    console.error("Erro em /subscription-status:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("Guied Subscriptions REST rodando na porta", PORT)
);
