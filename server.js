// server.js
const path = require("path");
require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const stripeLib = require("stripe");

const app = express();
app.set("trust proxy", 1);

// ---- ENV ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) console.warn("Missing STRIPE_WEBHOOK_SECRET (webhook will fail)");
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");

// ---- Clients ----
const stripe = stripeLib(STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- STATIC ----
app.use("/css", express.static(path.join(__dirname, "public/css")));
app.use("/images", express.static(path.join(__dirname, "public/images")));
app.use("/fonts", express.static(path.join(__dirname, "public/fonts")));
app.use(express.static(path.join(__dirname, "public"))); // for favicon files, html, pdf, etc.

// ---- Views ----
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// IMPORTANT: Webhook must be BEFORE express.json()
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status === "paid" && session.metadata?.orderData) {
        const orderItems = JSON.parse(session.metadata.orderData);

        for (const item of orderItems) {
          const { error } = await supabaseAdmin.rpc("decrement_inventory", {
            p_id: item.productId,
            p_qty: item.quantity,
          });
          if (error) throw error;
        }
      }
    }

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
  // serve static index.html
  res.sendFile(path.join(__dirname, "public", "index.html"));
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${req.protocol}://${req.get("host")}/success`,
      cancel_url: `${req.protocol}://${req.get("host")}/`,
      metadata: { orderData: JSON.stringify(orderItems) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

app.get("/success", (req, res) => {
  res.send("<h1>🖤 COMPLETE 🖤</h1>");
});

// ---- Vercel handler export (NO app.listen) ----
module.exports = app;
