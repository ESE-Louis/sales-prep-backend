/**
 * Sales Call Prep — Backend API
 * Deploy to Vercel (free tier) — runs as serverless functions
 *
 * Routes:
 *   POST /api/verify-licence    → Check if a licence key is active
 *   POST /api/webhook           → Stripe webhook (creates licence on payment)
 *   POST /api/cancel            → Customer cancels subscription
 *   GET  /api/checkout-session  → Create a Stripe Checkout session
 */

const express = require('express');
const Stripe = require('stripe');
const crypto = require('crypto');
const app = express();

// ─────────────────────────────────────────────
// CONFIG — set these as environment variables in Vercel
// ─────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // your $9/mo price ID
const APP_SECRET = process.env.APP_SECRET || 'change-this-secret'; // salt for licence keys

const stripe = Stripe(STRIPE_SECRET_KEY);

// In-memory store for demo — replace with a real DB (Vercel KV, PlanetScale, etc.)
// Structure: { licenceKey: { email, customerId, subscriptionId, status, createdAt } }
const licenceStore = {};

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

// Raw body needed for Stripe webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// CORS — allow Chrome extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-licence-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function generateLicenceKey(email) {
  const hash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(`${email}:${Date.now()}`)
    .digest('hex');
  // Format: SCPX-XXXX-XXXX-XXXX (readable, 16 hex chars)
  return `SCP-${hash.slice(0, 4).toUpperCase()}-${hash.slice(4, 8).toUpperCase()}-${hash.slice(8, 12).toUpperCase()}-${hash.slice(12, 16).toUpperCase()}`;
}

// ─────────────────────────────────────────────
// ROUTE: Create Stripe Checkout Session
// GET /api/checkout-session?email=user@example.com
// ─────────────────────────────────────────────
app.get('/api/checkout-session', async (req, res) => {
  try {
    const { email } = req.query;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
      metadata: { source: 'chrome-extension' }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Verify Licence Key
// POST /api/verify-licence
// Body: { licenceKey }
// ─────────────────────────────────────────────
app.post('/api/verify-licence', (req, res) => {
  const { licenceKey } = req.body;

  if (!licenceKey) {
    return res.status(400).json({ valid: false, reason: 'No licence key provided' });
  }

  const record = licenceStore[licenceKey.toUpperCase()];

  if (!record) {
    return res.json({ valid: false, reason: 'Licence key not found' });
  }

  if (record.status !== 'active') {
    return res.json({ valid: false, reason: `Subscription ${record.status}` });
  }

  res.json({
    valid: true,
    email: record.email,
    plan: 'pro',
    renewsAt: record.renewsAt || null
  });
});

// ─────────────────────────────────────────────
// ROUTE: Stripe Webhook
// POST /api/webhook
// ─────────────────────────────────────────────
app.post('/api/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event:', event.type);

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (email) {
        const key = generateLicenceKey(email);
        licenceStore[key] = {
          email,
          customerId,
          subscriptionId,
          status: 'active',
          createdAt: new Date().toISOString()
        };
        console.log(`Licence created for ${email}: ${key}`);

        // TODO: Email the licence key to the customer
        // sendLicenceEmail(email, key);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const status = sub.status; // active, past_due, canceled, etc.

      // Find licence by subscriptionId and update status
      for (const key in licenceStore) {
        if (licenceStore[key].subscriptionId === sub.id) {
          licenceStore[key].status = status === 'active' ? 'active' : 'inactive';
          licenceStore[key].renewsAt = new Date(sub.current_period_end * 1000).toISOString();
          console.log(`Licence ${key} status → ${licenceStore[key].status}`);
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      for (const key in licenceStore) {
        if (licenceStore[key].subscriptionId === sub.id) {
          licenceStore[key].status = 'canceled';
          console.log(`Licence ${key} canceled`);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      for (const key in licenceStore) {
        if (licenceStore[key].customerId === invoice.customer) {
          licenceStore[key].status = 'past_due';
          console.log(`Licence ${key} past_due`);
        }
      }
      break;
    }
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────
// SUCCESS / CANCEL PAGES (for Stripe redirect)
// ─────────────────────────────────────────────
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  let licenceKey = '';

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const email = session.customer_details?.email;
    // Find the licence key for this email
    for (const key in licenceStore) {
      if (licenceStore[key].email === email) {
        licenceKey = key;
        break;
      }
    }
  } catch (e) { /* ignore */ }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Successful — Sales Call Prep</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Mono', monospace;
      background: #0a0a0f;
      color: #e8e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #111118;
      border: 1px solid #2e2e4e;
      border-radius: 16px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .tick { font-size: 48px; margin-bottom: 20px; }
    h1 { font-family: 'Syne', sans-serif; font-size: 24px; margin-bottom: 10px; color: #e8ff47; }
    p { color: #6e6e8e; margin-bottom: 20px; line-height: 1.6; font-size: 14px; }
    .key-box {
      background: #0a0a0f;
      border: 1px solid #e8ff47;
      border-radius: 10px;
      padding: 16px;
      font-size: 18px;
      letter-spacing: 0.1em;
      color: #e8ff47;
      margin: 20px 0;
      word-break: break-all;
    }
    .instruction { font-size: 12px; color: #3e3e5e; margin-top: 16px; }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="card">
    <div class="tick">🎯</div>
    <h1>You're in.</h1>
    <p>Welcome to Sales Call Prep Pro. Your licence key is below — copy it and paste it into the extension settings.</p>
    ${licenceKey
      ? `<div class="key-box">${licenceKey}</div>`
      : `<p style="color:#ff4d6d">Key being generated — check your email shortly.</p>`
    }
    <p class="instruction">Open the Chrome extension → ⚙ Settings → paste your key → Save.</p>
  </div>
</body>
</html>`);
});

app.get('/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Cancelled</title>
  <style>
    body { font-family: monospace; background: #0a0a0f; color: #e8e8f0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .card { text-align:center; padding:40px; }
    h1 { color:#6e6e8e; margin-bottom:10px; }
    p { color: #3e3e5e; }
  </style>
</head>
<body>
  <div class="card">
    <h1>No worries.</h1>
    <p>You can upgrade anytime from the extension. Your free briefs are still waiting.</p>
  </div>
</body>
</html>`);
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sales Prep API running on port ${PORT}`));

module.exports = app;
