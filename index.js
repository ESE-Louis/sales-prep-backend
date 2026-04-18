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

// ─── CALL TYPE CONFIGS ───
const callTypeConfig = {
  discovery: {
    label: 'a first-call discovery call',
    bullets: [
      { category: 'Background', instruction: 'Their current role, company, and relevant career history' },
      { category: 'Likely Pain Point', instruction: 'The biggest business challenge they probably face right now that the seller could help solve' },
      { category: 'Buying Trigger', instruction: 'A specific recent event, role change, or signal that makes them likely to be open to a conversation now' },
      { category: 'Discovery Angle', instruction: 'The single best qualifying question to ask to uncover their real pain and budget authority' },
      { category: 'Your Angle', instruction: 'How to position the sellers value proposition specifically for this persons situation and company stage' }
    ],
    openerInstruction: 'A natural first-call opener that references something specific from their background and leads into a qualifying question'
  },
  demo: {
    label: 'a product demo call',
    bullets: [
      { category: 'Background', instruction: 'Their role and what decisions they influence or own in the buying process' },
      { category: 'Use Case Fit', instruction: 'The most likely way they would use the product based on their role and company — be specific' },
      { category: 'Buying Criteria', instruction: 'What they will likely evaluate the product on — features, ROI, integration, ease of use, etc' },
      { category: 'Likely Objection', instruction: 'The single most likely objection or concern they will raise during the demo and how to pre-empt it' },
      { category: 'Demo Focus', instruction: 'Which specific capability or outcome to emphasise in the demo to resonate most with this person' }
    ],
    openerInstruction: 'A demo call opener that confirms their priorities before starting and sets up the agenda around their specific use case'
  },
  followup: {
    label: 'a follow-up sales call',
    bullets: [
      { category: 'Background', instruction: 'Their role and where they likely sit in the decision making process' },
      { category: 'Where We Left Off', instruction: 'Based on their profile and typical buying journey, what stage the deal is probably at and what was likely discussed previously' },
      { category: 'Likely Hesitation', instruction: 'What is probably making them hesitate or slow down — internal politics, budget, competing priorities' },
      { category: 'Next Step To Push', instruction: 'The specific next step to push for in this call to advance the deal — proposal, pilot, intro to decision maker, etc' },
      { category: 'Your Angle', instruction: 'How to re-energise their interest and create urgency without being pushy — reference their specific business goals' }
    ],
    openerInstruction: 'A follow-up opener that re-establishes rapport, references the previous conversation, and moves straight to advancing the deal'
  }
};

// ─── GENERATE BRIEF ───
async function generateBrief(url, context, callType, sellerName, pageContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const config = callTypeConfig[callType] || callTypeConfig.discovery;

  const sellerCtx = sellerName
    ? 'The salesperson is: ' + sellerName + '.'
    : 'The salesperson is an enterprise B2B sales professional.';

  const profileSection = pageContent && pageContent.length > 100
    ? 'LIVE PROFILE DATA:\n"""\n' + pageContent + '\n"""'
    : 'PROFILE URL: ' + url + '\nInfer name, role and company from the URL. Make intelligent assumptions to generate a useful brief.';

  const bulletInstructions = config.bullets.map((b, i) =>
    '    {"category": "' + b.category + '", "text": "' + b.instruction + '"}'
  ).join(',\n');

  const prompt = 'Generate a sales call prep brief for ' + config.label + '.\n\n' +
    profileSection + '\n' +
    (context ? 'Additional context: ' + context + '\n' : '') +
    sellerCtx + '\n\n' +
    'IMPORTANT:\n' +
    '- Use the correct gender pronouns based on their name\n' +
    '- Make each bullet specific and actionable — not generic\n' +
    '- Tailor every bullet to THIS call type (' + config.label + ') not just general background\n' +
    '- Always return a complete brief even with limited profile data\n\n' +
    'Return ONLY this JSON:\n' +
    '{\n' +
    '  "name": "Their full name",\n' +
    '  "role": "Current role and company",\n' +
    '  "bullets": [\n' +
    config.bullets.map(b => '    {"category": "' + b.category + '", "text": "[' + b.instruction + ']"}').join(',\n') + '\n' +
    '  ],\n' +
    '  "opener": "[' + config.openerInstruction + ']"\n' +
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
      system: 'You are an expert enterprise sales strategist. Respond ONLY with valid JSON. No markdown, no preamble. Make every brief specific, actionable and tailored to the exact call type.',
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
  res.json({ status: 'ok', version: '2.2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Sales Prep API v2.2 running on port ' + PORT));

module.exports = app;
