const express = require('express');
const app = express();

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-licence-key, x-user-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const usageStore = {};
const FREE_LIMIT = 5;

// ─── GENERATE ───
app.post('/api/generate', async (req, res) => {
  const { userId, url, context, callType, sellerName, licenceKey, pageContent } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  const isPro = licenceKey && validateLicence(licenceKey);
  if (!isPro) {
    const count = usageStore[userId] || 0;
    if (count >= FREE_LIMIT) {
      return res.status(402).json({ error: 'Free limit reached', code: 'UPGRADE_REQUIRED' });
    }
  }

  try {
    const brief = await generateBrief(url, context, callType, sellerName, pageContent);
    if (!isPro) usageStore[userId] = (usageStore[userId] || 0) + 1;
    res.json({ brief, usage: usageStore[userId] || 0 });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── USAGE ───
app.post('/api/usage', (req, res) => {
  const { userId, licenceKey } = req.body;
  const isPro = licenceKey && validateLicence(licenceKey);
  const count = usageStore[userId] || 0;
  res.json({ count, isPro, remaining: isPro ? 999 : Math.max(0, FREE_LIMIT - count) });
});

// ─── VERIFY LICENCE ───
app.post('/api/verify-licence', (req, res) => {
  const { licenceKey } = req.body;
  res.json({ valid: licenceKey ? validateLicence(licenceKey) : false });
});

// ─── VALIDATE LICENCE ───
function validateLicence(key) {
  if (!key || !key.startsWith('ESE-')) return false;
  return /^ESE-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(key.toUpperCase());
}

// ─── GENERATE BRIEF ───
async function generateBrief(url, context, callType, sellerName, pageContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const callLabels = {
    discovery: 'a first-call discovery call',
    demo: 'a product demo call',
    followup: 'a follow-up sales call'
  };

  const sellerCtx = sellerName
    ? 'The salesperson is: ' + sellerName + '.'
    : 'The salesperson is an enterprise B2B sales professional.';

  // Use live page data if available, otherwise infer from URL
  let profileSection;
  if (pageContent && pageContent.length > 100) {
    profileSection = 'LIVE PROFILE DATA (use this to extract name, role, company, career history):\n"""\n' + pageContent + '\n"""';
  } else {
    profileSection = 'PROFILE URL: ' + url + '\nNote: Limited profile data available. Infer what you can from the URL and name. Make reasonable assumptions based on their likely role and industry — still generate a full, useful brief.';
  }

  const prompt = 'Generate a sales call prep brief for ' + (callLabels[callType] || callLabels.discovery) + '.\n\n' +
    profileSection + '\n' +
    (context ? 'Additional context: ' + context + '\n' : '') +
    sellerCtx + '\n\n' +
    'IMPORTANT:\n' +
    '- Determine gender from name and use correct pronouns throughout\n' +
    '- If profile data is limited, make intelligent assumptions based on available signals\n' +
    '- Always return a complete, useful brief — never refuse or return empty fields\n\n' +
    'Return ONLY this JSON:\n' +
    '{\n' +
    '  "name": "Their actual full name",\n' +
    '  "role": "Current role and company",\n' +
    '  "bullets": [\n' +
    '    {"category": "Background", "text": "Current role, company, and notable career history"},\n' +
    '    {"category": "Likely Pain Point", "text": "A specific challenge for their profession"},\n' +
    '    {"category": "Buying Trigger", "text": "What might make them open to a conversation now"},\n' +
    '    {"category": "Their Priority", "text": "What they care about most professionally"},\n' +
    '    {"category": "Your Angle", "text": "How the seller can genuinely help this person"}\n' +
    '  ],\n' +
    '  "opener": "Natural 1-2 sentence opener referencing something real from their profile"\n' +
    '}';

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
      system: 'You are an expert enterprise sales strategist. Respond ONLY with valid JSON. No markdown, no preamble. Always generate a complete brief even with limited information.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Anthropic API error ' + response.status);
  }

  const data = await response.json();
  const text = data.content.map(c => c.text || '').join('').replace(/```json\n?|\n?```/g, '').trim();

  try { return JSON.parse(text); }
  catch { throw new Error('Invalid response from AI'); }
}

// ─── HEALTH ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.1.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Sales Prep API v2.1 running on port ' + PORT));

module.exports = app;
