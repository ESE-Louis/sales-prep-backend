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

// ─── GENERATE BRIEF ───
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

// ─── SCORE PROSPECTS (NEW - Lead Gen) ───
app.post('/api/score-prospects', async (req, res) => {
  const { prospects, icp, sellerName } = req.body;
  if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
    return res.status(400).json({ error: 'Prospects array is required' });
  }
  if (!icp) return res.status(400).json({ error: 'ICP description is required' });

  try {
    const scored = await scoreProspects(prospects, icp, sellerName);
    res.json({ prospects: scored });
  } catch (err) {
    console.error('Score prospects error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATE OUTREACH (NEW - Lead Gen) ───
app.post('/api/generate-outreach', async (req, res) => {
  const { prospect, icp, sellerName, outreachType } = req.body;
  if (!prospect) return res.status(400).json({ error: 'Prospect is required' });
  if (!icp) return res.status(400).json({ error: 'ICP is required' });

  try {
    const outreach = await generateOutreach(prospect, icp, sellerName, outreachType);
    res.json({ outreach });
  } catch (err) {
    console.error('Generate outreach error:', err.message);
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

// ─── ANTHROPIC HELPER ───
async function callAnthropic(prompt, system, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 1000,
      system: system,
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

// ─── SCORE PROSPECTS ───
async function scoreProspects(prospects, icp, sellerName) {
  const sellerCtx = sellerName ? 'Seller: ' + sellerName + '.' : 'Seller is a B2B sales professional.';

  const prospectList = prospects.map((p, i) =>
    (i + 1) + '. Name: ' + (p.name || 'Unknown') +
    ' | Title: ' + (p.title || 'Unknown') +
    ' | Company: ' + (p.company || 'Unknown') +
    ' | Location: ' + (p.location || 'Unknown') +
    ' | LinkedIn: ' + (p.linkedinUrl || '')
  ).join('\n');

  const prompt = 'Score these prospects against the ICP. Return top 10 by total score.\n\n' +
    'ICP: ' + icp + '\n' +
    sellerCtx + '\n\n' +
    'Prospects:\n' + prospectList + '\n\n' +
    'Buying signals to look for: new role under 6 months, growing company, decision-maker title, company size matches ICP, recent funding.\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"index":1,"name":"","title":"","company":"","location":"","linkedinUrl":"","fitScore":8,"signalScore":7,"totalScore":15,"whyNow":"One sentence why contact now","fitReason":"One sentence why they match ICP"}]\n' +
    'Sort by totalScore descending. Top 10 only.';

  return await callAnthropic(prompt,
    'You are an expert B2B sales strategist. Respond ONLY with a valid JSON array. No markdown, no preamble.',
    2000
  );
}

// ─── GENERATE OUTREACH ───
async function generateOutreach(prospect, icp, sellerName, outreachType) {
  const sellerCtx = sellerName ? 'Seller: ' + sellerName + '.' : 'Seller is a B2B sales professional.';
  const type = outreachType || 'connection';

  const typeGuide = {
    connection: 'LinkedIn connection request note. Max 300 characters. Personal, specific, no pitch. Just open a conversation.',
    message: 'LinkedIn DM. Max 500 characters. Reference their signal, offer value, end with a soft question. No hard pitch.',
    email: 'Cold email. Subject + body, max 150 words. Personal, specific, value-led. Curiosity-driven subject line.'
  };

  const prompt = 'Write personalised ' + type + ' outreach for this prospect.\n\n' +
    'Prospect: ' + (prospect.name || '') + ' | ' + (prospect.title || '') + ' at ' + (prospect.company || '') + '\n' +
    'Why now: ' + (prospect.whyNow || '') + '\n' +
    'Fit reason: ' + (prospect.fitReason || '') + '\n\n' +
    'ICP context: ' + icp + '\n' +
    sellerCtx + '\n\n' +
    'Write: ' + (typeGuide[type] || typeGuide.connection) + '\n\n' +
    'Return ONLY: {"type":"' + type + '","subject":"(email only, else empty)","message":"outreach text"}';

  return await callAnthropic(prompt,
    'You are an expert B2B sales copywriter. Write genuine outreach that does not sound like AI. Respond ONLY with valid JSON.',
    500
  );
}

// ─── GENERATE BRIEF ───
async function generateBrief(url, context, callType, sellerName, pageContent) {
  const callTypeConfig = {
    discovery: {
      label: 'a first-call discovery call',
      bullets: [
        { category: 'Background', instruction: 'Current role, company and relevant career history' },
        { category: 'Likely Pain Point', instruction: 'Biggest business challenge they probably face right now' },
        { category: 'Buying Trigger', instruction: 'Specific recent event making them open to a conversation now' },
        { category: 'Discovery Angle', instruction: 'Best qualifying question to uncover their real pain' },
        { category: 'Your Angle', instruction: 'How to position the sellers value for this specific situation' }
      ],
      opener: 'Natural first-call opener referencing something specific, leading into a qualifying question'
    },
    demo: {
      label: 'a product demo call',
      bullets: [
        { category: 'Background', instruction: 'Role and decisions they influence in the buying process' },
        { category: 'Use Case Fit', instruction: 'Most likely way they would use the product' },
        { category: 'Buying Criteria', instruction: 'What they will evaluate the product on' },
        { category: 'Likely Objection', instruction: 'Most likely objection they will raise in the demo' },
        { category: 'Demo Focus', instruction: 'Which capability to emphasise to resonate most' }
      ],
      opener: 'Demo opener confirming priorities before starting'
    },
    followup: {
      label: 'a follow-up sales call',
      bullets: [
        { category: 'Background', instruction: 'Role and position in the decision making process' },
        { category: 'Where We Left Off', instruction: 'Likely deal stage and what was discussed previously' },
        { category: 'Likely Hesitation', instruction: 'What is probably making them hesitate' },
        { category: 'Next Step To Push', instruction: 'Specific next step to advance the deal' },
        { category: 'Your Angle', instruction: 'How to re-energise interest and create urgency' }
      ],
      opener: 'Follow-up opener re-establishing rapport and moving to advancing the deal'
    }
  };

  const config = callTypeConfig[callType] || callTypeConfig.discovery;
  const sellerCtx = sellerName ? 'Seller: ' + sellerName + '.' : 'Seller is a B2B sales professional.';

  const profileSection = pageContent && pageContent.length > 100
    ? 'LIVE PROFILE DATA:\n"""\n' + pageContent + '\n"""'
    : 'PROFILE URL: ' + url + '\nInfer name, role and company. Make intelligent assumptions.';

  const prompt = 'Generate a sales call prep brief for ' + config.label + '.\n\n' +
    profileSection + '\n' +
    (context ? 'Context: ' + context + '\n' : '') +
    sellerCtx + '\n\n' +
    'Use correct gender pronouns. Make bullets specific and actionable. Always return a complete brief.\n\n' +
    'Return ONLY this JSON:\n' +
    '{"name":"Full name","role":"Role and company","bullets":[' +
    config.bullets.map(b => '{"category":"' + b.category + '","text":"[' + b.instruction + ']"}').join(',') +
    '],"opener":"[' + config.opener + ']"}';

  return await callAnthropic(prompt,
    'You are an expert enterprise sales strategist. Respond ONLY with valid JSON. No markdown, no preamble.',
    1000
  );
}

// ─── HEALTH ───
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    endpoints: [
      'POST /api/generate',
      'POST /api/score-prospects',
      'POST /api/generate-outreach',
      'POST /api/usage',
      'POST /api/verify-licence',
      'GET /api/health'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Predicta API v3.0 running on port ' + PORT));

module.exports = app;
