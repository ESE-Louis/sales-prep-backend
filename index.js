
const express = require('express');
const app = express();

app.use(express.json());

// CORS — allow Chrome extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-licence-key, x-user-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Simple in-memory usage tracking (resets on deploy — fine for MVP)
const usageStore = {};
const FREE_LIMIT = 5;

// ─────────────────────────────────────────────
// ROUTE: Generate Brief
// POST /api/generate
// Body: { userId, url, context, callType, sellerName, licenceKey }
// ─────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { userId, url, context, callType, sellerName, licenceKey } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  // Check licence or usage
  const isPro = licenceKey && await validateLicence(licenceKey);
  if (!isPro) {
    const count = usageStore[userId] || 0;
    if (count >= FREE_LIMIT) {
      return res.status(402).json({ error: 'Free limit reached', code: 'UPGRADE_REQUIRED' });
    }
  }

  try {
    const brief = await generateBrief(url, context, callType, sellerName);

    // Increment usage for free users
    if (!isPro) {
      usageStore[userId] = (usageStore[userId] || 0) + 1;
    }

    res.json({ brief, usage: usageStore[userId] || 0 });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Check Usage
// POST /api/usage
// Body: { userId, licenceKey }
// ─────────────────────────────────────────────
app.post('/api/usage', async (req, res) => {
  const { userId, licenceKey } = req.body;
  const isPro = licenceKey && await validateLicence(licenceKey);
  const count = usageStore[userId] || 0;
  res.json({ count, isPro, remaining: isPro ? 999 : Math.max(0, FREE_LIMIT - count) });
});

// ─────────────────────────────────────────────
// ROUTE: Verify Licence
// POST /api/verify-licence
// Body: { licenceKey }
// ─────────────────────────────────────────────
app.post('/api/verify-licence', async (req, res) => {
  const { licenceKey } = req.body;
  if (!licenceKey) return res.json({ valid: false });
  const valid = await validateLicence(licenceKey);
  res.json({ valid });
});

// ─────────────────────────────────────────────
// VALIDATE LICENCE
// Simple hash-based validation matching the extension
// ─────────────────────────────────────────────
async function validateLicence(key) {
  if (!key || !key.startsWith('ESE-')) return false;
  const pattern = /^ESE-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;
  return pattern.test(key.toUpperCase());
}

// ─────────────────────────────────────────────
// GENERATE BRIEF via Anthropic
// ─────────────────────────────────────────────
async function generateBrief(url, context, callType, sellerName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const labels = {
    discovery: 'a first-call discovery call',
    demo: 'a product demo call',
    followup: 'a follow-up sales call'
  };

  const sellerCtx = sellerName
    ? `The salesperson is: ${sellerName}.`
    : 'The salesperson is an enterprise B2B sales professional.';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: 'You are an expert enterprise sales strategist. Respond ONLY with valid JSON. No markdown, no preamble.',
      messages: [{
        role: 'user',
        content: `Generate a sales call prep brief for ${labels[callType] || labels.discovery}.

URL: ${url}
${context ? `Context: ${context}` : ''}
${sellerCtx}

IMPORTANT: Determine the prospect's gender from their name or profile and use correct pronouns throughout.

Return ONLY this JSON:
{
  "name": "Their actual full name",
  "role": "Current role and company",
  "bullets": [
    {"category": "Background", "text": "Current role, company, and notable career history"},
    {"category": "Likely Pain Point", "text": "A specific challenge for their profession"},
    {"category": "Buying Trigger", "text": "What might make them open to a conversation now"},
    {"category": "Their Priority", "text": "What they care about most professionally"},
    {"category": "Your Angle", "text": "How the seller can genuinely help this person"}
  ],
  "opener": "Natural specific 1-2 sentence opener referencing something real from their profile"
}`
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  const text = data.content.map(c => c.text || '').join('').replace(/```json\n?|\n?```/g, '').trim();

  try { return JSON.parse(text); }
  catch { throw new Error('Invalid response from AI'); }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sales Prep API v2 running on port ${PORT}`));

module.exports = app;
