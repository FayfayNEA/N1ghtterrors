const path = require('path');
require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;

// ENV checks
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is missing');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Supabase environment variables are missing');
  process.exit(1);
}

// Supabase
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Stripe webhook (RAW body first)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    try {
      const session = event.data.object;

      if (session.payment_status !== 'paid') {
        return res.json({ received: true });
      }

      if (!session.metadata?.orderData) {
        return res.status(500).send('Missing orderData');
      }

      const orderItems = JSON.parse(session.metadata.orderData);

      for (const item of orderItems) {
        const { error } = await supabaseAdmin.rpc('decrement_inventory', {
          p_id: item.productId,
          p_qty: item.quantity,
        });

        if (error) {
          console.error('decrement_inventory failed:', error);
          return res.status(500).send('Inventory decrement failed');
        }
      }
    } catch (error) {
      console.error('Error processing order:', error);
      return res.status(500).send('Webhook processing failed');
    }
  }

  res.json({ received: true });
});

// JSON for everything else
app.use(express.json());

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/shop', (req, res) => {
  res.render('shopping');
});

// Inventory check
app.get('/check-inventory', async (req, res) => {
  const { id, title } = req.query;

  let query = supabaseAdmin
    .from('inventory')
    .select('id, title, quantity, price_cents');

  if (id) query = query.eq('id', Number(id));
  else if (title) query = query.eq('title', title.trim());
  else return res.json({ inStock: 0 });

  const { data, error } = await query.single();
  if (error || !data) return res.json({ inStock: 0 });

  res.json({
    inStock: data.quantity,
    id: data.id,
    price_cents: data.price_cents
  });
});

// Checkout
app.post('/checkout', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });

    const lineItems = [];
    const orderItems = [];

    for (const item of items) {
      const { data: product } = await supabaseAdmin
        .from('inventory')
        .select('*')
        .eq('id', item.inventoryId)
        .single();

      if (!product || product.quantity < item.quantity_wa) {
        return res.status(400).json({ error: 'Not enough inventory' });
      }

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.title,
            images: product.image_url ? [product.image_url] : []
          },
          unit_amount: product.price_cents
        },
        quantity: item.quantity_wa
      });

      orderItems.push({ productId: product.id, quantity: item.quantity_wa });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      billing_address_collection: 'required',
      success_url: `${req.protocol}://${req.get('host')}/success`,
      cancel_url: `${req.protocol}://${req.get('host')}/`,
      metadata: { orderData: JSON.stringify(orderItems) }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Success
app.get('/success', (req, res) => {
  res.send('<h1>🖤 COMPLETE 🖤</h1>');
});

app.listen(port, () => {
  console.log(`🚀 Running on port ${port}`);
});
