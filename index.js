import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const { createClient } = pkg;

// ======================================================
// SUPABASE CLIENTE COM SERVICE ROLE
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

// ======================================================
// VALIDADOR
// ======================================================
const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// NORMALIZADOR DE PLANO
// ======================================================
function normalizePlan(plan) {
  const value = String(plan || "").trim().toLowerCase();

  if (value === "pro+" || value === "pro_plus" || value === "proplus") {
    return "pro+";
  }

  return "pro";
}

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

// ======================================================
// BENEFÍCIO DE INDICAÇÃO
// ======================================================
async function getActiveReferralBenefit(userId) {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("referral_benefits")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar referral_benefits:", error);
    return null;
  }

  return data ?? null;
}

async function markReferralBenefitAsUsed(userId) {
  const nowIso = new Date().toISOString();

  const { data: activeBenefit, error: fetchError } = await supabase
    .from("referral_benefits")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    console.error("Erro ao localizar benefício ativo:", fetchError);
    return;
  }

  if (!activeBenefit) return;

  const { error: updateError } = await supabase
    .from("referral_benefits")
    .update({
      status: "used",
      used_at: new Date().toISOString(),
    })
    .eq("id", activeBenefit.id);

  if (updateError) {
    console.error("Erro ao marcar benefício como usado:", updateError);
  } else {
    console.log("✅ Benefício de indicação marcado como usado:", activeBenefit.id);
  }
}

// ======================================================
// MERCADO PAGO — CHECKOUT PIX
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    console.log("📩 create-checkout body:", req.body);

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    const normalizedPlan = normalizePlan(plan);
    const basePrice = normalizedPlan === "pro+" ? 34.99 : 11.99;

    let finalPrice = basePrice;
    let appliedDiscountPercent = 0;

    const activeBenefit = await getActiveReferralBenefit(user_id);

    if (activeBenefit && Number(activeBenefit.discount_percent) > 0) {
      appliedDiscountPercent = Number(activeBenefit.discount_percent);
      finalPrice = roundMoney(basePrice * (1 - appliedDiscountPercent / 100));
    }

    console.log("💰 Plano:", normalizedPlan);
    console.log("💰 Preço base:", basePrice);
    console.log("💰 Desconto:", appliedDiscountPercent);
    console.log("💰 Preço final:", finalPrice);

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
                normalizedPlan === "pro+"
                  ? appliedDiscountPercent > 0
                    ? `Assinatura Guied PRO+ (${appliedDiscountPercent}% OFF)`
                    : "Assinatura Guied PRO+"
                  : appliedDiscountPercent > 0
                    ? `Assinatura Guied PRO (${appliedDiscountPercent}% OFF)`
                    : "Assinatura Guied PRO",
              quantity: 1,
              currency_id: "BRL",
              unit_price: finalPrice,
            },
          ],

          external_reference: `${user_id}|${normalizedPlan}|${appliedDiscountPercent}`,

          back_urls: {
            success: "https://guied.app/sucesso",
            pending: "https://guied.app/pendente",
            failure: "https://guied.app/erro",
          },
          auto_return: "approved",
          statement_descriptor: "GUIED.APP",
          notification_url:
            "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",

          metadata: {
            user_id,
            plan: normalizedPlan,
            discount_percent: appliedDiscountPercent,
            original_price: basePrice,
            final_price: finalPrice,
          },
        }),
      }
    );

    const json = await mpRes.json();

    console.log("📦 Mercado Pago create:", json);

    if (!json.init_point) {
      return res.status(400).json({
        error: "Falha ao criar checkout PIX",
        details: json,
      });
    }

    return res.json({
      init_point: json.init_point,
      preference_id: json.id,
      plan: normalizedPlan,
      original_price: basePrice,
      final_price: finalPrice,
      discount_percent: appliedDiscountPercent,
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
  console.log("\n🟪 WEBHOOK RECEBIDO");
  console.log("📩 BODY:", req.body);

  try {
    let paymentId = req.body?.data?.id;

    if (!paymentId && req.body?.resource?.includes("merchant_orders")) {
      const orderRes = await fetch(req.body.resource, {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
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

    const r = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      }
    );

    const info = await r.json();

    console.log("🔎 PAYMENT INFO COMPLETA:", info);

    if (info.status !== "approved") {
      console.log("⏳ Pagamento ainda não aprovado → ignorado");
      return res.status(200).send("ok");
    }

    let user_id =
      info?.metadata?.user_id || info?.external_reference?.split("|")[0];

    let plan =
      info?.metadata?.plan || info?.external_reference?.split("|")[1];

    const discountPercent = Number(
      info?.metadata?.discount_percent ||
        info?.external_reference?.split("|")[2] ||
        0
    );

    if (!user_id || !isUuid(user_id)) {
      console.log("❌ user_id inválido:", user_id);
      return res.status(200).send("ok");
    }

    plan = normalizePlan(plan);

    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 86400000);

    const { data: existing } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .maybeSingle();

    if (existing) {
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

      console.log("🔥 Assinatura atualizada para", user_id, "| plano:", plan);
    } else {
      await supabase.from("user_subscriptions").insert({
        user_id,
        plan,
        status: "active",
        current_period_end: expires.toISOString(),
        expires_at: expires.toISOString(),
        mp_preference_id: info.external_reference,
        renews: false,
      });

      console.log("🔥 Nova assinatura criada para", user_id, "| plano:", plan);
    }

    if (discountPercent > 0) {
      await markReferralBenefitAsUsed(user_id);
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
      .from("user_subscriptions")
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
      plan: isActive ? normalizePlan(data.plan) : "free",
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
      .from("user_subscriptions")
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
// START SERVER
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 Guied Subscriptions API rodando na porta ${PORT}`)
);