// server.js
const path = require("path");
require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const stripeLib = require("stripe");
const { Resend } = require("resend");

const app = express();
app.set("trust proxy", 1);

// ---- ENV ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) console.warn("Missing STRIPE_WEBHOOK_SECRET (webhook will fail)");
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
if (!RESEND_API_KEY) console.warn("Missing RESEND_API_KEY (receipt emails will be skipped)");

// ---- Clients ----
const stripe = stripeLib(STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---- STATIC ----
app.use("/css", express.static(path.join(__dirname, "public/css")));
app.use("/images", express.static(path.join(__dirname, "public/images")));
app.use("/fonts", express.static(path.join(__dirname, "public/fonts")));

// Block direct access to specific html files while keeping them on disk
app.use((req, res, next) => {
  const blockedPaths = ["/index.html", "/whosthisfreak.html", "/whoisthisfreak.html"];
  if (blockedPaths.includes(req.path.toLowerCase())) {
    return res.status(404).send("Not found");
  }
  return next();
});

app.use(express.static(path.join(__dirname, "public"))); // for favicon files, html, pdf, etc.

// ---- Views ----
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ---- Receipt Email ----
function buildReceiptHtml(name, items, totalCents) {
  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:12px 0;color:#ccc;font-size:14px;border-bottom:1px solid #1a1a1a;">
            ${i.image_url ? `<img src="${i.image_url}" alt="" width="64" height="64" style="object-fit:cover;border-radius:4px;margin-right:12px;vertical-align:middle;">` : ""}
            <span style="vertical-align:middle;">${i.title}${i.quantity > 1 ? ` <span style="color:#555;">&times;${i.quantity}</span>` : ""}</span>
          </td>
          <td align="right" style="padding:12px 0;color:#fff;font-size:14px;border-bottom:1px solid #1a1a1a;">
            $${((i.price_cents * i.quantity) / 100).toFixed(2)}
          </td>
        </tr>`
    )
    .join("");

  const total = (totalCents / 100).toFixed(2);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#000;font-family:Georgia,'Times New Roman',serif;color:#fff;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;">
<tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <tr><td style="text-align:center;padding:36px 0;border-bottom:1px solid #222;">
    <h1 style="font-size:26px;letter-spacing:8px;margin:0;color:#fff;font-weight:400;">N1GHTTERRORS</h1>
    <p style="color:#555;font-size:11px;letter-spacing:3px;margin:10px 0 0;text-transform:uppercase;">Order Receipt</p>
  </td></tr>

  <tr><td style="padding:28px 0 20px;">
    <p style="color:#999;font-size:14px;line-height:1.7;margin:0;">
      hey ${name},<br>your order went through. here's what you got:
    </p>
  </td></tr>

  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;color:#555;font-size:11px;letter-spacing:2px;text-transform:uppercase;border-bottom:1px solid #222;">Item</td>
        <td align="right" style="padding:8px 0;color:#555;font-size:11px;letter-spacing:2px;text-transform:uppercase;border-bottom:1px solid #222;">Price</td>
      </tr>
      ${rows}
      <tr>
        <td style="padding:16px 0;color:#888;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Total</td>
        <td align="right" style="padding:16px 0;color:#fff;font-size:20px;font-weight:bold;">$${total}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:32px 0;text-align:center;border-top:1px solid #222;">
    <p style="color:#555;font-size:12px;line-height:1.6;margin:0;">
      questions, concerns, or fears?<br>
      <a href="mailto:orders@n1ghtterrors.com" style="color:#888;text-decoration:underline;">orders@n1ghtterrors.com</a>
      &nbsp;&middot;&nbsp;
      <a href="https://instagram.com/n1ghtterrors" style="color:#888;text-decoration:underline;">@n1ghtterrors</a>
    </p>
    <p style="color:#333;font-size:10px;margin:18px 0 0;font-style:italic;">
      ill hold your hand and tell you what mom could never. (im proud of you.)
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

async function sendReceipt(session, orderItems) {
  if (!resend) return;
  const email = session.customer_details?.email;
  if (!email) return;

  const name = session.customer_details?.name || "friend";

  const enriched = [];
  for (const item of orderItems) {
    const { data } = await supabaseAdmin
      .from("inventory")
      .select("title, price_cents, image_url")
      .eq("id", item.productId)
      .single();

    enriched.push({
      title: data?.title || `Item #${item.productId}`,
      price_cents: data?.price_cents || 0,
      quantity: item.quantity,
      image_url: data?.image_url || null,
    });
  }

  const totalCents =
    session.amount_total ||
    enriched.reduce((s, i) => s + i.price_cents * i.quantity, 0);

  await resend.emails.send({
    from: "N1GHTTERRORS <orders@n1ghtterrors.com>",
    to: email,
    subject: "your n1ghtterrors order receipt",
    html: buildReceiptHtml(name, enriched, totalCents),
  });

  console.log(`Receipt sent to ${email}`);
}

// IMPORTANT: Webhook must be BEFORE express.json()
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status === "paid" && session.metadata?.orderData) {
        const orderItems = JSON.parse(session.metadata.orderData);

        try {
          // 1. Decrement inventory for each item (awaited)
          for (const item of orderItems) {
            const { error } = await supabaseAdmin.rpc("decrement_inventory", {
              p_id: item.productId,
              p_qty: item.quantity,
            });
            if (error) throw error;
          }

          // 2. Send receipt email (awaited so Vercel keeps the function alive)
          await sendReceipt(session, orderItems);
        } catch (processingErr) {
          console.error("Stripe webhook processing error:", processingErr.message || processingErr);
        }
      }
    }

    // Always acknowledge the webhook at the very end so background work can complete first
    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// JSON for everything else
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  // redirect homepage to main shop page
  res.redirect(302, "/shop");
});

app.get("/shop", (req, res) => {
  res.render("shopping");
});

app.get("/check-inventory", async (req, res) => {
  try {
    const { id, title } = req.query;

    let query = supabaseAdmin.from("inventory").select("id,title,quantity,price_cents");

    if (id) query = query.eq("id", Number(id));
    else if (title) query = query.eq("title", title.trim());
    else return res.json({ inStock: 0 });

    const { data, error } = await query.single();
    if (error || !data) return res.json({ inStock: 0 });

    res.json({ inStock: data.quantity || 0, id: data.id, price_cents: data.price_cents });
  } catch (e) {
    console.error(e);
    res.json({ inStock: 0 });
  }
});

app.post("/checkout", async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ error: "Cart is empty" });

    const lineItems = [];
    const orderItems = [];

    for (const item of items) {
      const inventoryId = item.inventoryId;
      const qty = item.quantity_wa;

      const { data: product, error } = await supabaseAdmin
        .from("inventory")
        .select("*")
        .eq("id", inventoryId)
        .single();

      if (error || !product) return res.status(400).json({ error: `Product not found (${inventoryId})` });
      if (product.quantity < qty) return res.status(400).json({ error: `Only ${product.quantity} left` });

      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: product.title, images: product.image_url ? [product.image_url] : [] },
          unit_amount: Number(product.price_cents),
        },
        quantity: qty,
      });

      orderItems.push({ productId: product.id, quantity: qty });
    }

    // Hybrid shipping: still collect address in Checkout, but charge a flat
    // shipping line based on the inferred country from the request.
    // - US (x-vercel-ip-country === "US") -> 600 cents ($6)
    // - Everyone else -> 1500 cents ($15)
    const countryHeader = (req.headers["x-vercel-ip-country"] || req.headers["cf-ipcountry"] || "US")
      .toString()
      .toUpperCase();
    const isUS = countryHeader === "US";
    const shippingAmount = isUS ? 600 : 1500;
    if (shippingAmount > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: isUS ? "Shipping (US)" : "Shipping (International)" },
          unit_amount: shippingAmount,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: `${req.protocol}://${req.get("host")}/success`,
      cancel_url: `${req.protocol}://${req.get("host")}/shop`,
      shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU", "NZ", "MX", "JP", "KR", "BR", "NO", "SE", "DK", "FI", "IE", "ES", "IT", "NL", "BE", "CH", "PT", "PL", "DE", "FR"] },
      metadata: { orderData: JSON.stringify(orderItems) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

app.get("/success", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>N1GHTTERRORS - Order Complete</title>
  <link rel="icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/favicon-48.png" sizes="48x48">
  <link rel="preload" href="/fonts/Ogilvie.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="https://use.typekit.net/art4fxf.css">
  <style>
    @font-face { font-family: 'Ogilvie'; src: url('/fonts/Ogilvie.woff2') format('woff2'); font-display: swap; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: #fff;
      font-family: Georgia, 'Times New Roman', serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 40px 20px;
    }
    h1 {
      font-family: 'Ogilvie', Georgia, serif;
      font-size: clamp(28px, 6vw, 52px);
      letter-spacing: 8px;
      font-weight: 400;
      margin-bottom: 16px;
    }
    .subtitle {
      color: #888;
      font-size: 14px;
      line-height: 1.8;
      max-width: 400px;
      margin-bottom: 40px;
    }
    .back-btn {
      display: inline-block;
      padding: 14px 40px;
      border: 1px solid #fff;
      color: #fff;
      text-decoration: none;
      font-family: "chandler-42-regular", sans-serif;
      font-size: 14px;
      letter-spacing: 4px;
      text-transform: uppercase;
      transition: background 0.3s, color 0.3s;
      margin-bottom: 50px;
    }
    .back-btn:hover { background: #fff; color: #000; }
    .contact {
      color: #555;
      font-size: 12px;
      line-height: 1.8;
    }
    .contact a { color: #888; text-decoration: underline; }
    .contact a:hover { color: #fff; }
    .whisper {
      color: #333;
      font-size: 10px;
      font-style: italic;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <h1>N1GHTTERRORS</h1>
  <p class="subtitle">
    order complete. your receipt is on its way.<br>
    thank you for supporting something real.
  </p>
  <a href="/shop" class="back-btn">back to shop</a>
  <div class="contact">
    <a href="mailto:orders@n1ghtterrors.com">orders@n1ghtterrors.com</a>
    &nbsp;&middot;&nbsp;
    <a href="https://instagram.com/n1ghtterrors" target="_blank" rel="noopener">@n1ghtterrors</a>
    <br>questions, concerns, or fears? hit my line.
  </div>
  <p class="whisper">ill hold your hand and tell you what mom could never. (im proud of you.)</p>
</body>
</html>`);
});

// ---- Vercel handler export (NO app.listen) ----
module.exports = app;
