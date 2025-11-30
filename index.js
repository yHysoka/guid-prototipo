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
app.use(express.json());

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// CREATE CHECKOUT — PIX
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    console.log("📩 create-checkout body:", req.body);

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    let normalizedPlan = "pro";
    if (typeof plan === "string") {
      const p = plan.toLowerCase();
      if (p === "pro_plus") normalizedPlan = "pro_plus";
      if (p === "pro") normalizedPlan = "pro";
    }

    const price = 1.0;

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
          external_reference: `${user_id}|${normalizedPlan}`,
          notification_url:
            "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
          auto_return: "approved",
          back_urls: {
            success: "https://guied.app/sucesso",
            pending: "https://guied.app/pendente",
            failure: "https://guied.app/erro",
          },
          metadata: {
            user_id,
            plan: normalizedPlan,
          },
        }),
      }
    );

    const json = await mpRes.json();
    console.log("📦 CRIAR CHECKOUT MP:", json);

    if (!json.init_point) {
      return res.status(400).json({ error: "Falha ao criar checkout PIX", json });
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
// WEBHOOK MERCADO PAGO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  console.log("🟪 WEBHOOK RECEBIDO");
  console.log("📩 BODY:", req.body);

  try {
    // 1) Verifica se é webhook direto de pagamento (melhor caso)
    let paymentId = req.body?.data?.id;

    // 2) Se for merchant_order → buscar pagamentos dentro da ordem
    if (!paymentId && req.body?.resource?.includes("merchant_orders")) {
      const orderUrl = req.body.resource;

      const orderRes = await fetch(orderUrl, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });

      const orderJson = await orderRes.json();

      if (orderJson?.payments?.length > 0) {
        paymentId = orderJson.payments[0].id;
      }
    }

    if (!paymentId) {
      console.log("⚠️ Webhook sem paymentId → ignorado");
      return res.status(200).send("ok");
    }

    // 3) Buscar pagamento real no Mercado Pago
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
      console.log("⏳ Pagamento não aprovado → ignorado");
      return res.status(200).send("ok");
    }

    // 4) Extrair user_id e plano
    let user_id =
      info?.metadata?.user_id || info?.external_reference?.split("|")[0];

    let plan =
      info?.metadata?.plan || info?.external_reference?.split("|")[1];

    if (!user_id || !isUuid(user_id)) {
      console.log("❌ user_id inválido:", user_id);
      return res.status(200).send("ok");
    }

    if (!plan) plan = "pro";

    // 5) Criar datas
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // 6) Verificar se já existe assinatura
    const { data: existing } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .maybeSingle();

    if (existing) {
      // Atualizar assinatura existente
      await supabase
        .from("user_subscriptions")
        .update({
          plan,
          status: "active",
          current_period_end: expires.toISOString(),
          expires_at: expires.toISOString(),
          mp_preference_id: info.external_reference,
          renews: false,
        })
        .eq("id", existing.id);

      console.log("🔥 Assinatura atualizada para", user_id);
    } else {
      // Criar nova assinatura
      await supabase.from("user_subscriptions").insert({
        user_id,
        plan,
        status: "active",
        current_period_end: expires.toISOString(),
        expires_at: expires.toISOString(),
        mp_preference_id: info.external_reference,
        renews: false,
      });

      console.log("🔥 Nova assinatura criada para", user_id);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    return res.status(200).send("ok");
  }
});


// ======================================================
// STATUS ASSINATURA
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    console.log("📥 STATUS user_id:", user_id);

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
      return res.json({ status: "free", plan: "free" });
    }

    const now = new Date();
    const exp = data.expires_at ? new Date(data.expires_at) : null;

    const isActive = data.status === "active" && exp && exp > now;

    return res.json({
      status: isActive ? "active" : "free",
      plan: isActive ? data.plan : "free",
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error("❌ Erro STATUS:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// CANCELAR ASSINATURA
// ======================================================
app.post("/cancel-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    await supabase
      .from("subscriptions")
      .update({ status: "canceled", renews: false })
      .eq("user_id", user_id)
      .eq("status", "active");

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Erro cancelar assinatura:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🔥 Guied Subscriptions API rodando na porta", PORT));
