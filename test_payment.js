import { MercadoPagoConfig, Preference } from 'mercadopago';

const client = new MercadoPagoConfig({
  accessToken: "SEU_ACCESS_TOKEN_AQUI"  // coloque o token de produção!
});

const preference = new Preference(client);

async function run() {
  try {
    const result = await preference.create({
      body: {
        items: [
          {
            title: "Pagamento de Teste Guied (Produção)",
            quantity: 1,
            unit_price: 3.0
          }
        ],
        payment_methods: {
          default_payment_method_id: "pix"
        }
      }
    });

    console.log("\n====================================");
    console.log("Link de pagamento (init_point):");
    console.log(result.init_point);
    console.log("====================================\n");

  } catch (err) {
    console.error("Erro:", err);
  }
}

run();
