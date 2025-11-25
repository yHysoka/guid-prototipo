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
// CREATE CHECKOUT — GUIED PRO / PRO+
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    // Plano vindo do app: "pro" ou "pro_plus"
    let normalizedPlan = "pro";
    if (typeof plan === "string") {
      const p = plan.toLowerCase();
      if (p === "pro_plus") normalizedPlan = "pro_plus";
      if (p === "pro") normalizedPlan = "pro";
    }

    console.log("🟦 Criando checkout para:", user_id, "Plano:", normalizedPlan);

    const price = 9.9; // por enquanto fixo p/ PRO

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
          metadata: {
            user_id,
            plan: normalizedPlan,
          },
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
      return res.status(400).json({
        error: "Falha ao criar checkout",
        mp: json,
      });
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
// WEBHOOK MERCADO PAGO — PRODUÇÃO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.status(200).send("ok");

    const r = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      }
    );

    const info = await r.json();
    console.log("🔎 WEBHOOK PAYMENT INFO:", info);

    if (info.status !== "approved") {
      return res.status(200).send("ok");
    }

    // user_id + plano vindos do metadata ou external_reference
    let user_id = info?.metadata?.user_id;
    let plan = info?.metadata?.plan;

    if (!user_id || !plan) {
      const [u, p] = (info.external_reference || "").split("|");
      user_id = user_id || u;
      plan = plan || p;
    }

    if (!user_id || !isUuid(user_id)) {
      console.log("🚫 user_id inválido no webhook");
      return res.status(200).send("ok");
    }

    if (!plan) {
      plan = "pro";
    }

    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Cria registro de assinatura ativa
    const { error: insertError } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan,
        status: "active",
        started_at: now.toISOString(),
        expires_at: expires.toISOString(),
        mp_preference_id: info?.order?.id || null,
        payment_id: info.id,
        preference_id: info.external_reference,
        renews: false,
      });


    if (insertError) {
      console.error("❌ Erro ao inserir assinatura:", insertError);
    } else {
      console.log("🔥 Assinatura ativada para", user_id, "plano:", plan);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
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

    const { data, error } = await supabase
      .from("subscriptions")

      .select("status, plan, expires_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Erro Supabase /subscription-status:", error);
    }

    if (!data) {
      return res.json({
        status: "free",
        plan: "free",
        expires_at: null,
      });
    }

    const now = new Date();
    const exp = data.expires_at ? new Date(data.expires_at) : null;
    const notExpired = exp && exp > now;
    const isActive = data.status === "active";

    if (!isActive || !notExpired) {
      return res.json({
        status: "free",
        plan: "free",
        expires_at: data.expires_at,
      });
    }

    return res.json({
      status: data.status,
      plan: data.plan || "free",
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error("Erro em /subscription-status:", err);
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

    console.log("🟥 Cancelando assinatura do usuário:", user_id);

    const { error } = await supabase
      .from("subscriptions")

      .update({
        status: "canceled",
        renews: false,
      })
      .eq("user_id", user_id)
      .eq("status", "active");

    if (error) {
      console.error("Erro ao cancelar assinatura:", error);
      return res.status(400).json({ error: error.message });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Erro em /cancel-subscription:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// DELETE ACCOUNT — ADMIN API (Service Role Required)
// ======================================================
app.post("/delete-account", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id || !isUuid(user_id)) {
      return res.status(400).json({ error: "user_id inválido" });
    }

    console.log("🟥 Excluindo conta do usuário:", user_id);

    const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(
      user_id
    );

    if (deleteAuthError) {
      console.error("Erro deleteUser:", deleteAuthError);
      return res.status(400).json({ error: deleteAuthError.message });
    }

    await supabase.from("subscriptions").delete().eq("user_id", user_id);


    console.log("🟥 Conta excluída com sucesso:", user_id);

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Erro em /delete-account:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("Guied Subscriptions REST rodando na porta", PORT)
);
