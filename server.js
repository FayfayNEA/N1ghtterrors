
require('dotenv').config();
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is missing from environment variables');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Supabase environment variables are missing');
  process.exit(1);
}
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = 3000;


app.use('/webhook/stripe', express.raw({type: 'application/json'}));
app.use(express.json());
app.use(express.static('public')); 


app.set('view engine', 'ejs');
app.set('views', './views');


app.get('/', (req, res) => {
  res.render('index'); 
});

app.get('/frontpage', (req, res) => {
  res.render('frontpage');
});


const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);


app.get('/check-inventory', async (req, res) => {
  try {
    const { title } = req.query;
    console.log('Checking inventory for:', title);

    if (!title) {
      return res.json({ inStock: 0 });
    }

    
    const { data: product, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('title', shortenTitle(title))
      .single();

    if (error || !product) {
      console.log('Product not found:', title);
      return res.json({ inStock: 0 });
    }

    console.log('Found product:', product.title, 'Stock:', product.quantity);
    
    res.json({ 
      inStock: product.quantity || 0,
      id: product.id 
    });

  } catch (error) {
    console.error('Inventory check error:', error);
    res.json({ inStock: 0 });
  }
});


app.post('/checkout', async (req, res) => {
  try {
    console.log('=== CHECKOUT STARTED ===');
    console.log('Cart items:', req.body.items);

    const { items } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    
    const orderItems = [];
    const lineItems = [];

    for (const item of items) {
      const { title_wa, quantity_wa, price_wa } = item;
      
      
      const { data: product, error } = await supabaseAdmin
        .from('inventory')
        .select('*')
        .eq('title', title_wa)
        .single();

      if (error || !product) {
        return res.status(400).json({ 
          error: `Product "${title_wa}" not found` 
        });
      }

      if (product.quantity < quantity_wa) {
        return res.status(400).json({ 
          error: `Only ${product.quantity} of "${title_wa}" available` 
        });
      }

      const unitAmount = Number(product.price_cents);
      if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
        return res.status(400).json({ error: `Invalid price for "${product.title}"` });
      }

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: title_wa,
          }, 
          unit_amount: unitAmount,
        },
        quantity: quantity_wa,
      });

      

      
      orderItems.push({
        title: title_wa,
        quantity: quantity_wa,
        price: unitAmount,
        productId: product.id,
        currentStock: product.quantity
      });
    }

    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'DK', 'SE', 'NO', 'FI'],
      },

      shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 500, // in cents ($5.00)
            currency: 'usd',
          },
          display_name: 'Standard Shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 5 },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 2500, // $25.00
            currency: 'usd',
          },
          display_name: 'UK/Europe International Shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 7 },
            maximum: { unit: 'business_day', value: 14 },
          },
        },
      },
    ],
      success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/`,
      metadata: {
        orderData: JSON.stringify(orderItems)
      }
    });

    console.log('Stripe session created:', session.id);
    
    res.json({ url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ 
      error: 'Checkout failed: ' + error.message 
    });
  }
});

app.post('/webhook/stripe', async (req, res) => {
  let event;
  
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('Payment successful! Processing order...');

    try {
      const orderItems = JSON.parse(session.metadata.orderData);
      
      // Reduce inventory for each item
      for (const item of orderItems) {
        const newStock = item.currentStock - item.quantity;
        
        await supabaseAdmin
          .from('inventory')
          .update({ quantity: Math.max(0, newStock) })
          .eq('id', item.productId);
          
        console.log(`Reduced ${item.title}: ${item.currentStock} → ${newStock}`);
      }
      
      console.log('Order completed successfully');
      
    } catch (error) {
      console.error('Error processing order:', error);
    }
  }

  res.json({received: true});
});


app.get('/success', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>you bought it bby</title>
        <link rel="stylesheet" href="https://use.typekit.net/art4fxf.css">
        <style>
          body { 
            font-family: "chandler-42-regular", sans-serif;
            text-align: center; 
            padding: 50px; 
            background: #111; 
            color: white; 
          }
          .container { 
            max-width: 600px; 
            margin: 0 auto; 
            padding: 40px; 
            font-family: "chandler-42-regular", sans-serif;
          }
          h1 { 
          color: #ffffffff; 
          font-family: "chandler-42-regular", sans-serif;
          }
          a { 
          color: #ffffffff;
           text-decoration: none; 
           font-size: 18px; 
           font-family: "chandler-42-regular", sans-serif;
           }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🖤 COMPLETE 🖤</h1>
          <p>you won't regret this....</p>
          <p>can't wait to see you sexi ass in these CLOTHES</p>
          <br><br>
          <a href="/">buy more!?!?</a>
        </div>
      </body>
    </html>
  `);
});


app.get('/debug', async (req, res) => {
  try {
    const { data: inventory } = await supabaseAdmin.from('inventory').select('*');
    
    res.json({
      inventory: inventory,
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
      environment: {
        supabase: !!process.env.SUPABASE_URL,
        stripeSecret: !!process.env.STRIPE_SECRET_KEY,
        webhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/inventory-status', async (req, res) => {
  try {
    const { data: inventory, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .order('title');
    
    if (error) throw error;
    
    res.json({
      timestamp: new Date().toISOString(),
      inventory: inventory
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function shortenTitle(displayTitle, maxLength = 15) {
    if (!displayTitle) return '';
    
    if (displayTitle.length <= maxLength) {
        return displayTitle;
    }
    
    const truncated = displayTitle.substring(0, maxLength);
    const lastSpaceIndex = truncated.lastIndexOf(' ');
    
    if (lastSpaceIndex > maxLength * 0.7) {
        return truncated.substring(0, lastSpaceIndex).trim();
    }
    
    return truncated.trim();
}

app.get('/test-shortened-titles', async (req, res) => {
    try {
        const { data: inventory } = await supabaseAdmin.from('inventory').select('*');
        
        if (!inventory) {
            return res.json({ message: 'No inventory found' });
        }
        
        const results = inventory.map(item => ({
            id: item.id,
            original: item.title,
            shortened: shortenTitle(item.title),
            length_before: item.title ? item.title.length : 0,
            length_after: shortenTitle(item.title).length
        }));
        
        res.json(results);
    } catch (error) {
        console.error('Test endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});




app.listen(port, () => {
  console.log(`🚀 N1GHTTERRORS shop running on http://localhost:${port}`);
  console.log(`💳 Stripe checkout: ${process.env.STRIPE_SECRET_KEY ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  console.log(`📦 Inventory: Connected to Supabase`);
});