const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const JOBS_FILE = path.join(__dirname, 'jobs.json');

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); }
  catch { return []; }
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs), 'utf8');
}

// ── Translate endpoint ─────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, language } = req.body;
  if (!text || !language) return res.status(400).json({ error: 'Missing text or language' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a professional translation engine. Translate the user's English text to ${language}. Return ONLY the translated text — no explanations, no quotes, no preamble.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'API error');
    }

    const data = await response.json();
    const translation = data.content?.[0]?.text || '';
    res.json({ translation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Jobs endpoints ─────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  res.json(loadJobs());
});

app.post('/api/jobs', (req, res) => {
  const jobs = loadJobs();
  const job = { ...req.body, createdAt: Date.now() };
  jobs.push(job);
  saveJobs(jobs);
  res.json(job);
});

app.patch('/api/jobs/:id', (req, res) => {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Job not found' });
  jobs[idx] = { ...jobs[idx], ...req.body };
  saveJobs(jobs);
  res.json(jobs[idx]);
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LingoCheck running on port ${PORT}`);
});
