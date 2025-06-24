require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static("public"));

// Inventory tracking - EXACT titles as they appear in frontend
const inventory = {
    "White collared baby. *wah wah* I know your daddy is in jail.": 5,
    "omg Mr.Rorschach please, PLEASE psychoanalyze me.": 3,
    "Classical art? Classical Architecure? the VIRGIN MARY WITH JESUS!?!?!?": 4,
    "now, tell me you DON'T want to have a capitalistic pig on ur back. omg jk! hes already there.": 2,
    "the nightterrors logo showing off ur SEXI bod. jk only with it on are u sexi.": 6,
    "this one is open, white space, lets the images BREATHE": 3
};

app.get('/', (req, res) => {
    res.render('index.ejs');
});

app.get('/check-inventory', (req, res) => {
    const title = req.query.title;
    
    // Debug logging
    console.log('Inventory check request for:', title);
    console.log('Available inventory keys:', Object.keys(inventory));
    
    // Trim whitespace and check inventory
    const cleanTitle = title ? title.trim() : '';
    const quantity = inventory[cleanTitle] || 0;
    
    console.log('Clean title:', cleanTitle);
    console.log('Found quantity:', quantity);
    
    res.json({ inStock: quantity });
});

app.post('/checkout', async (req, res) => {
    const items = req.body.items;
    
    console.log('Checkout request received with items:', items);
    
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No items provided' });
    }

    // Validate all items exist and have required properties
    for (const item of items) {
        if (!item.title_wa || !item.price_wa || !item.quantity_wa) {
            console.log('Invalid item data:', item);
            return res.status(400).json({ error: 'Invalid item data' });
        }
        
        // Clean the title and check inventory availability
        const cleanTitle = item.title_wa.trim();
        const availableStock = inventory[cleanTitle] || 0;
        
        console.log(`Checking stock for "${cleanTitle}": ${availableStock} available, ${item.quantity_wa} requested`);
        
        if (item.quantity_wa > availableStock) {
            return res.status(400).json({ 
                error: `Not enough stock for ${cleanTitle}. Available: ${availableStock}` 
            });
        }
    }

    // Create line items for Stripe
    const lineItems = items.map(item => ({
        price_data: {
            currency: 'usd',
            product_data: {
                name: item.title_wa.trim(),
                images: item.imageUrl ? [item.imageUrl] : [],
            },
            unit_amount: Math.round(item.price_wa * 100), // Convert to cents
        },
        quantity: item.quantity_wa,
    }));

    try {
        const session = await stripe.checkout.sessions.create({
            line_items: lineItems,
            mode: 'payment',
            shipping_address_collection: {
                allowed_countries: ['US', 'BR']
            },
            success_url: `${process.env.BASE_URL}/complete?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/cancel`,
            metadata: {
                items: JSON.stringify(items.map(item => ({
                    title: item.title_wa.trim(),
                    quantity: item.quantity_wa
                })))
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe Error:', error);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

app.get('/complete', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
        if (session.payment_status === 'paid') {
            // Parse items from metadata and update inventory
            const items = JSON.parse(session.metadata.items);
            
            console.log('Payment completed, updating inventory for:', items);
            
            items.forEach(item => {
                const cleanTitle = item.title.trim();
                if (inventory[cleanTitle] !== undefined) {
                    const oldQuantity = inventory[cleanTitle];
                    inventory[cleanTitle] = Math.max(0, inventory[cleanTitle] - item.quantity);
                    console.log(`Updated inventory for "${cleanTitle}": ${oldQuantity} -> ${inventory[cleanTitle]}`);
                }
            });
            
            console.log('Updated inventory:', inventory);
        }

        res.send(`
            <html>
                <head><title>Payment Successful</title></head>
                <body>
                    <h1>Payment Successful!</h1>
                    <p>Thank you for your purchase. Your order has been confirmed.</p>
                    <a href="/">Return to Shop</a>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error retrieving session:', error);
        res.status(500).send('Error completing payment');
    }
});

app.get('/cancel', (req, res) => {
    res.redirect('/');
});

// Debug route to check inventory
app.get('/debug-inventory', (req, res) => {
    res.json({
        inventory: inventory,
        keys: Object.keys(inventory)
    });
});

app.listen(3000, () => console.log('Server started on port 3000'));