import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

import MercadoPagoConfig from "mercadopago";
import Preference from "mercadopago/dist/clients/preference.js";
import Payment from "mercadopago/dist/clients/payment.js";

dotenv.config();

const { createClient } = pkg;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceClient = new Preference(mpClient);
const paymentClient = new Payment(mpClient);

const app = express();
app.use(cors());
app.use(express.json());

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

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
    console.error("Erro ao localizar benefício ativo para consumo:", fetchError);
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
  }
}

// ======================================================
// CREATE CHECKOUT PIX – PRO / PRO+
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan) {
      return res
        .status(400)
        .json({ error: "user_id e plan são obrigatórios" });
    }

    if (!isUuid(user_id)) {
      return res.status(400).json({ error: "UUID inválido" });
    }

    const normalizedPlan = String(plan).toLowerCase().trim();

    const planConfig = {
      pro: {
        title: "Assinatura Guied – PRO (Mensal)",
        price: 11.99,
      },
      "pro+": {
        title: "Assinatura Guied – PRO+ (Mensal)",
        price: 34.99,
      },
    };

    if (!planConfig[normalizedPlan]) {
      return res.status(400).json({ error: "Plano inválido" });
    }

    const selectedPlan = planConfig[normalizedPlan];

    let finalPrice = selectedPlan.price;
    let appliedDiscountPercent = 0;
    let benefitId = null;

    const activeBenefit = await getActiveReferralBenefit(user_id);

    if (activeBenefit && Number(activeBenefit.discount_percent) > 0) {
      appliedDiscountPercent = Number(activeBenefit.discount_percent);
      const discountedPrice =
        selectedPlan.price * (1 - appliedDiscountPercent / 100);

      finalPrice = roundMoney(discountedPrice);
      benefitId = activeBenefit.id;
    }

    const externalReferencePayload = {
      user_id,
      plan: normalizedPlan,
      discount_percent: appliedDiscountPercent,
      benefit_id: benefitId,
    };

    const preferenceBody = {
      items: [
        {
          title:
            appliedDiscountPercent > 0
              ? `${selectedPlan.title} (${appliedDiscountPercent}% OFF)`
              : selectedPlan.title,
          quantity: 1,
          currency_id: "BRL",
          unit_price: finalPrice,
        },
      ],
      payment_methods: {
        default_payment_method_id: "pix",
        excluded_payment_types: [
          { id: "credit_card" },
          { id: "debit_card" },
          { id: "ticket" },
        ],
      },
      notification_url:
        "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
      back_urls: {
        success: "https://guied.app/success",
        pending: "https://guied.app/pending",
        failure: "https://guied.app/failure",
      },
      auto_return: "approved",
      external_reference: JSON.stringify(externalReferencePayload),
    };

    const mpRes = await preferenceClient.create({
      body: preferenceBody,
    });

    const preferenceId = mpRes.id;
    const initPoint = mpRes.init_point;

    const { data, error } = await supabase
      .from("user_subscriptions")
      .insert({
        user_id,
        plan: normalizedPlan,
        status: "pending",
        external_preference_id: preferenceId,
        price_paid: finalPrice,
        original_price: selectedPlan.price,
        discount_percent: appliedDiscountPercent,
        referral_benefit_id: benefitId,
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      init_point: initPoint,
      preference_id: preferenceId,
      subscription: data,
      pricing: {
        original_price: selectedPlan.price,
        final_price: finalPrice,
        discount_percent: appliedDiscountPercent,
        has_referral_discount: appliedDiscountPercent > 0,
      },
    });
  } catch (err) {
    console.error("Erro create-checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// GET STATUS
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    if (!isUuid(user_id)) {
      return res.status(400).json({ error: "UUID inválido" });
    }

    const { data } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      return res.json({ premium: false, plan: "free", status: "none" });
    }

    const now = new Date();
    const exp = data.expires_at ? new Date(data.expires_at) : null;
    const active = exp && exp > now && data.status === "active";

    return res.json({
      premium: active,
      plan: active ? data.plan : "free",
      status: data.status,
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error("Erro:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK MERCADO PAGO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    console.log("WEBHOOK RECEBIDO:", req.body);

    if (req.body.topic === "merchant_order") {
      const orderId = req.body.resource.split("/").pop();

      const order = await fetch(
        `https://api.mercadolibre.com/merchant_orders/${orderId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          },
        }
      ).then((r) => r.json());

      const payment = order.payments?.find((p) => p.status === "approved");

      if (!payment) return res.status(200).send("ok");

      await activateSubscription(payment.id);
      return res.status(200).send("ok");
    }

    if (req.body?.data?.id) {
      await activateSubscription(req.body.data.id);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
    return res.status(200).send("ok");
  }
});

async function activateSubscription(paymentId) {
  try {
    const paymentInfo = await paymentClient.get({ id: paymentId });

    if (paymentInfo.status !== "approved") return;

    const externalRefRaw = paymentInfo.external_reference;
    if (!externalRefRaw) return;

    let parsedRef = null;

    try {
      parsedRef = JSON.parse(externalRefRaw);
    } catch (_) {
      parsedRef = null;
    }

    if (!parsedRef?.user_id || !parsedRef?.plan) {
      console.error("external_reference inválido:", externalRefRaw);
      return;
    }

    const user_id = parsedRef.user_id;
    const plan = parsedRef.plan;

    const expires = new Date();
    expires.setDate(expires.getDate() + 30);

    await supabase
      .from("user_subscriptions")
      .update({ status: "inactive" })
      .eq("user_id", user_id);

    const { error: insertError } = await supabase
      .from("user_subscriptions")
      .insert({
        user_id,
        plan,
        status: "active",
        expires_at: expires.toISOString(),
        renews: false,
        mercado_pago_payment_id: String(paymentId),
      });

    if (insertError) {
      console.error("Erro ao ativar assinatura:", insertError);
      return;
    }

    if (Number(parsedRef.discount_percent || 0) > 0) {
      await markReferralBenefitAsUsed(user_id);
    }

    console.log("Assinatura ativada corretamente:", user_id, plan);
  } catch (err) {
    console.error("Erro activateSubscription:", err);
  }
}

// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Guied subscriptions API rodando na porta", PORT);
});