import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

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
// CHECKOUT PRO REAL — PRODUÇÃO
// ======================================================
app.post("/create-checkout", async (req, res) => {
    try {
        const { user_id } = req.body;

        if (!user_id || !isUuid(user_id))
            return res.status(400).json({ error: "user_id inválido" });

        console.log("🟦 Criando checkout PRO para:", user_id);

        const price = 9.90;

        const mpRes = await fetch(
            "https://api.mercadopago.com/checkout/preferences",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    items: [
                        {
                            title: "Assinatura Guied PRO",
                            quantity: 1,
                            unit_price: price
                        }
                    ],
                    statement_descriptor: "GUIED PRO",
                    external_reference: `${user_id}|pro`,
                    back_urls: {
                        success: "https://guied.app/sucesso",
                        pending: "https://guied.app/pendente",
                        failure: "https://guied.app/erro"
                    },
                    auto_return: "approved",
                    notification_url:
                        "https://guied-subscriptions-api.onrender.com/webhook/mercadopago"
                }),
            }
        );

        const json = await mpRes.json();
        console.log("🟦 RESPOSTA CHECKOUT PRO:", json);

        if (!json.init_point) {
            return res.status(400).json({
                error: "Falha ao criar checkout PRO",
                mp: json
            });
        }

        return res.json({
            init_point: json.init_point,
            preference_id: json.id
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

        if (info.status !== "approved") 
            return res.status(200).send("ok");

        const [user_id, plan] = (info.external_reference || "").split("|");

        if (!user_id || !isUuid(user_id)) {
            console.log("🚫 user_id inválido no webhook");
            return res.status(200).send("ok");
        }

        const expires = new Date();
        expires.setDate(expires.getDate() + 30);

        await supabase.from("subscriptions").insert({
            user_id,
            plan,
            status: "active",
            expires_at: expires.toISOString()
        });

        console.log("🔥 Assinatura ativada para", user_id);
        return res.status(200).send("ok");

    } catch (err) {
        console.error("Erro webhook:", err);
        return res.status(200).send("ok");
    }
});

// ======================================================
// STATUS DA ASSINATURA — PRODUÇÃO
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
