import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";

// NOVO SDK OFICIAL (v2)
import MercadoPagoConfig from "mercadopago";
import Preference from "mercadopago/dist/clients/preference.js";
import Payment from "mercadopago/dist/clients/payment.js";

dotenv.config();

console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "Carregado" : "NÃO CARREGOU");

const { createClient } = pkg;

// -------------------------------------------------------------
// SUPABASE
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------
// MERCADO PAGO (SDK NOVO V2)
// -------------------------------------------------------------
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceClient = new Preference(mpClient);
const paymentClient = new Payment(mpClient);

const app = express();
app.use(cors());
app.use(express.json());

// UUID helper
const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// CREATE CHECKOUT PIX – PRO
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan)
      return res.status(400).json({ error: "user_id e plan são obrigatórios" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "UUID inválido" });

    if (String(plan).toLowerCase() !== "pro")
      return res.status(400).json({ error: "Plano inválido" });

    const preferenceBody = {
      items: [
        {
          title: "Assinatura Guied – PRO (Mensal)",
          quantity: 1,
          currency_id: "BRL",
          unit_price: 9.9,
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
      metadata: {
        user_id,
        plan: "pro",
      },
    };

    const mpRes = await preferenceClient.create({
      body: preferenceBody,
    });

    const preferenceId = mpRes.id;
    const initPoint = mpRes.init_point;

    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: preferenceId,
      })
      .select()
      .single();

    return res.json({
      init_point: initPoint,
      preference_id: preferenceId,
      subscription: data,
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

    if (!isUuid(user_id))
      return res.status(400).json({ error: "UUID inválido" });

    const { data } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data)
      return res.json({ premium: false, plan: "free", status: "none" });

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
    const paymentId = req.body?.data?.id;

    if (!paymentId) return res.status(200).send("ok");

    const paymentInfo = await paymentClient.get({ id: paymentId });

    if (paymentInfo.status === "approved") {
      const preferenceId =
        paymentInfo.order?.id ||
        paymentInfo.metadata?.preference_id ||
        paymentInfo.metadata?.external_preference_id;

      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_preference_id", preferenceId)
        .maybeSingle();

      if (data) {
        const started = new Date();
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);

        await supabase
          .from("subscriptions")
          .update({
            status: "active",
            started_at: started.toISOString(),
            expires_at: expires.toISOString(),
            external_payment_id: String(paymentId),
          })
          .eq("id", data.id);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
    res.status(200).send("ok");
  }
});

// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Guied subscriptions API rodando na porta", PORT);
});
