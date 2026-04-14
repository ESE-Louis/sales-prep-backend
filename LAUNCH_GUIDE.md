# Sales Call Prep — Launch & Monetisation Guide

## What you've got

```
sales-prep-extension/   ← Chrome extension (the product)
sales-prep-backend/     ← Node.js API (licence server + Stripe webhooks)
```

The flow:
1. User installs extension → gets 5 free briefs
2. On brief #6 → upgrade wall appears
3. User pays $9/mo via Stripe Checkout
4. Stripe webhook fires → licence key generated → emailed to user
5. User pastes key into extension → instantly unlocked

---

## STEP 1 — Set up Stripe (15 mins)

1. Go to https://dashboard.stripe.com and create an account
2. Create a **Product**:
   - Name: "Sales Call Prep Pro"
   - Price: $9.00 / month / recurring
   - Copy the **Price ID** (starts with `price_...`)

3. Go to Developers → API Keys → copy your **Secret Key** (`sk_live_...`)

4. Go to Developers → Webhooks → Add endpoint:
   - URL: `https://your-vercel-app.vercel.app/api/webhook`
   - Events to listen to:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
   - Copy the **Webhook Signing Secret** (`whsec_...`)

---

## STEP 2 — Deploy backend to Vercel (10 mins)

### Option A: Vercel CLI (recommended)
```bash
cd sales-prep-backend
npm install
npx vercel login
npx vercel deploy --prod
```

### Option B: GitHub → Vercel dashboard
1. Push `sales-prep-backend/` to a GitHub repo
2. Go to https://vercel.com → New Project → import repo
3. Deploy

### Set environment variables in Vercel dashboard:
```
STRIPE_SECRET_KEY      = sk_live_...
STRIPE_WEBHOOK_SECRET  = whsec_...
STRIPE_PRICE_ID        = price_...
APP_SECRET             = (any random string, e.g. "xK9mP2qL8nR5wT3v")
BASE_URL               = https://your-vercel-app.vercel.app
```

After deploying, copy your Vercel URL (e.g. `https://sales-prep-api.vercel.app`)

---

## STEP 3 — Update extension with your backend URL (2 mins)

In `sales-prep-extension/popup.js`, line 3:
```javascript
const API_BASE = 'https://sales-prep-api.vercel.app'; // ← your actual URL
```

---

## STEP 4 — Add email sending (optional but recommended)

When a customer pays, you want to email them their licence key automatically.
Add this to `index.js` in the `checkout.session.completed` handler:

### Using Resend (free tier — 100 emails/day):
```bash
npm install resend
```

```javascript
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Inside checkout.session.completed:
await resend.emails.send({
  from: 'Sales Call Prep <noreply@enterprisesalesengine.com>',
  to: email,
  subject: 'Your Sales Call Prep licence key',
  html: `
    <h2>You're in. Welcome to Pro.</h2>
    <p>Your licence key:</p>
    <h1 style="letter-spacing:0.1em; color:#333">${key}</h1>
    <p>Open the Chrome extension → ⚙ Settings → paste your key → Save.</p>
    <p>Questions? Reply to this email.</p>
    <p>— Louis, Enterprise Sales Engine</p>
  `
});
```

Add `RESEND_API_KEY` to your Vercel env variables.

---

## STEP 5 — Add persistent storage (production requirement)

The current backend uses in-memory storage — this resets on every deploy.
For production, replace with **Vercel KV** (free tier):

```bash
npm install @vercel/kv
```

```javascript
const { kv } = require('@vercel/kv');

// Replace: licenceStore[key] = record
await kv.set(`licence:${key}`, JSON.stringify(record));

// Replace: licenceStore[key]
const record = JSON.parse(await kv.get(`licence:${key}`) || 'null');
```

Enable Vercel KV in your Vercel project dashboard → Storage → KV.

---

## STEP 6 — Load extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `sales-prep-extension/` folder

To package for Chrome Web Store later:
```bash
cd sales-prep-extension
zip -r sales-call-prep-v1.zip . --exclude "*.DS_Store"
```

---

## Revenue projection

| Users | MRR | ARR |
|-------|-----|-----|
| 50 | $450 | $5,400 |
| 100 | $900 | $10,800 |
| 500 | $4,500 | $54,000 |
| 1,000 | $9,000 | $108,000 |

Conversion benchmark: free tools typically see 2–5% free→paid.
At 2,000 installs that's 40–100 paying subscribers = $360–$900 MRR.

---

## Chrome Web Store submission (when ready)

1. Pay one-time $5 developer registration at https://chrome.google.com/webstore/devconsole
2. Zip the extension folder
3. Submit with:
   - Screenshots (1280×800 or 640×400)
   - Short description: "Paste a LinkedIn URL → get a 5-bullet sales call prep brief in seconds. Built for SDRs, AEs, and founders."
   - Category: Productivity
   - Privacy policy URL (required — create a simple one-pager)

Review typically takes 1–3 business days.

---

## Quick wins after launch

- Post about it on your LinkedIn (you have the audience)
- Add it to your Enterprise Sales Engine website
- Give free Pro codes to your first 10 clients as a value-add
- Share in sales communities: RevGenius, Pavilion, LinkedIn Sales groups
