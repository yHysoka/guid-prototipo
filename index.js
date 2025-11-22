import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const { createClient } = pkg;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// CREATE CHECKOUT (PIX) — REST API MP
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!isUuid(user_id))
      return res.status(400).json({ error: "UUID inválido" });

    if (String(plan).toLowerCase() !== "pro")
      return res.status(400).json({ error: "Plano inválido" });

    const mpRes = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              title: "Assinatura Guied – PRO (Mensal)",
              quantity: 1,
              unit_price: 9.9,
              currency_id: "BRL",
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
          back_urls: {
            success: "https://guied.app/success",
            failure: "https://guied.app/failure",
            pending: "https://guied.app/pending",
          },
          auto_return: "approved",
          notification_url:
            "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
          metadata: {
            user_id,
            plan: "pro",
          },
        }),
      }
    );

    const json = await mpRes.json();

    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: json.id,
      })
      .select()
      .single();

    return res.json({
      init_point: json.init_point,
      preference_id: json.id,
      subscription: data,
    });
  } catch (err) {
    console.error("Erro checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK — MERCADO PAGO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.status(200).send("ok");

    const r = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      }
    );

    const info = await r.json();

    if (info.status === "approved") {
      const preferenceId =
        info.order?.id ||
        info.metadata?.preference_id ||
        info.metadata?.external_preference_id;

      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_preference_id", preferenceId)
        .maybeSingle();

      if (data) {
        const start = new Date();
        const exp = new Date();
        exp.setDate(exp.getDate() + 30);

        await supabase
          .from("subscriptions")
          .update({
            status: "active",
            started_at: start.toISOString(),
            expires_at: exp.toISOString(),
            external_payment_id: String(paymentId),
          })
          .eq("id", data.id);
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
    return res.status(200).send("ok");
  }
});

// ======================================================
// CONSULTAR STATUS DA ASSINATURA (NOVO!)
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    // Aceita as duas formas: user_id e userId
    const user_id = req.query.user_id || req.query.userId;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    const { data, error } = await supabase
      .from("subscriptions")
      .select("status, plan, expires_at")
      .eq("user_id", user_id)
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (!data) {
      return res.json({
        status: "free",
        plan: "free",
        expires_at: null,
      });
    }

    return res.json({
      status: data.status || "free",
      plan: data.plan || "free",
      expires_at: data.expires_at,
    });
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
