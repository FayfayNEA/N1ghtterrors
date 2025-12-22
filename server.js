const path = require("path");
require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set("trust proxy", 1);

const port = process.env.PORT || 3000;

// ---------- ENV checks ----------
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is missing");
  process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error("STRIPE_WEBHOOK_SECRET is missing");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("Supabase environment variables are missing");
  process.exit(1);
}

// ---------- Supabase ----------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------- Static files (favicon, css, images, pdf) ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Stripe webhook (RAW body must be BEFORE express.json) ----------
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      try {
        const session = event.data.object;

        // ignore unpaid
        if (session.payment_status !== "paid") {
          return res.json({ received: true });
        }

        if (!session.metadata?.orderData) {
          console.error("Missing orderData in metadata");
          return res.status(400).send("Missing orderData");
        }

        let orderItems;
        try {
          orderItems = JSON.parse(session.metadata.orderData);
        } catch (e) {
          console.error("orderData JSON parse failed:", e);
          return res.status(400).send("Invalid orderData JSON");
        }

        for (const item of orderItems) {
          const { error } = await supabaseAdmin.rpc("decrement_inventory", {
            p_id: item.productId,
            p_qty: item.quantity,
          });

          if (error) {
            console.error("decrement_inventory failed:", item, error);
            return res.status(500).send("Inventory decrement failed");
          }
        }
      } catch (err) {
        console.error("Webhook processing failed:", err);
        return res.status(500).send("Webhook processing failed");
      }
    }

    return res.json({ received: true });
  }
);

// ---------- JSON parser for everything else ----------
app.use(express.json());

// ---------- Views ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ---------- Routes ----------
app.get("/", (req, res) => {
  // serves /public/index.html
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/shop", (req, res) => {
  res.render("shopping");
});

// Inventory check
app.get("/check-inventory", async (req, res) => {
  try {
    const { id, title } = req.query;

    let query = supabaseAdmin
      .from("inventory")
      .select("id, title, quantity, price_cents");

    if (id) query = query.eq("id", Number(id));
    else if (title) query = query.eq("title", String(title).trim());
    else return res.json({ inStock: 0 });

    const { data, error } = await query.single();
    if (error || !data) return res.json({ inStock: 0 });

    return res.json({
      inStock: data.quantity ?? 0,
      id: data.id,
      price_cents: data.price_cents,
    });
  } catch (err) {
    console.error("check-inventory error:", err);
    return res.json({ inStock: 0 });
  }
});

// Checkout
app.post("/checkout", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const lineItems = [];
    const orderItems = [];

    for (const item of items) {
      const inventoryId = item.inventoryId;
      const qty = item.quantity_wa;

      if (!inventoryId || !Number.isFinite(Number(qty)) || Number(qty) <= 0) {
        return res.status(400).json({ error: "Bad cart item data" });
      }

      const { data: product, error } = await supabaseAdmin
        .from("inventory")
        .select("*")
        .eq("id", inventoryId)
        .single();

      if (error || !product) {
        return res.status(400).json({ error: `Product not found (${inventoryId})` });
      }

      if ((product.quantity ?? 0) < qty) {
        return res.status(400).json({
          error: `Only ${product.quantity ?? 0} of "${product.title}" available`,
        });
      }

      const unitAmount = Number(product.price_cents);
      if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
        return res.status(400).json({ error: `Invalid price for "${product.title}"` });
      }

      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: product.title,
            images: product.image_url ? [product.image_url] : [],
          },
          unit_amount: unitAmount,
        },
        quantity: qty,
      });

      orderItems.push({ productId: product.id, quantity: qty });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      billing_address_collection: "required",
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/shop`,
      metadata: { orderData: JSON.stringify(orderItems) },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("checkout error:", err);
    return res.status(500).json({ error: "Checkout failed" });
  }
});

// Success page
app.get("/success", (req, res) => {
  res.send("<h1>🖤 COMPLETE 🖤</h1>");
});

// ---------- Local dev only ----------
app.listen(port, () => {
  console.log(`🚀 Running on port ${port}`);
});
