require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const { buildComparisonMatrix } = require('./compare');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, '../data');
const CURRENT_FILE = path.join(DATA_DIR, 'current.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

app.use(express.static(path.join(__dirname, '../public')));

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[server] Failed to read ${file}:`, err.message);
  }
  return fallback;
}

// In-memory cache for the built matrix (invalidated after 60 s)
let matrixCache = null;
let matrixCacheAt = 0;
const MATRIX_CACHE_TTL = 60 * 1000; // 60 seconds

app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/data', (_, res) => {
  let current;
  try {
    current = readJson(CURRENT_FILE, { scraped_at: null, plans: [] });
    if (!Array.isArray(current.plans)) {
      console.error('[server] current.json is malformed — plans is not an array, using empty fallback');
      current = { scraped_at: null, plans: [] };
    }
  } catch (err) {
    console.error('[server] Unexpected error reading current.json:', err.message);
    current = { scraped_at: null, plans: [] };
  }

  const history = readJson(HISTORY_FILE, { changes: [], new_countries: [] });

  // Use cached matrix if still fresh
  const now = Date.now();
  if (!matrixCache || now - matrixCacheAt > MATRIX_CACHE_TTL) {
    matrixCache = buildComparisonMatrix(current.plans);
    matrixCacheAt = now;
  }
  const matrix = matrixCache;

  // Recent price changes (last 90 days, competitors only)
  const cutoff = new Date(now - 90 * 24 * 3600 * 1000).toISOString();
  const recentChanges = (history.changes || [])
    .filter((c) => c.detected_at >= cutoff)
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at));

  const recentNewCountries = (history.new_countries || [])
    .filter((c) => c.detected_at >= cutoff)
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at));

  // Stats
  const providers = ['kolet', 'airalo', 'saily', 'holafly'];
  const stats = {};
  for (const p of providers) {
    const pPlans = current.plans.filter((x) => x.provider === p);
    stats[p] = {
      plan_count: pPlans.length,
      country_count: new Set(pPlans.map((x) => x.country_code || x.country)).size,
    };
  }

  res.json({
    scraped_at: current.scraped_at,
    stats,
    matrix,
    recent_changes: recentChanges,
    new_countries: recentNewCountries,
    all_countries: [...new Set(current.plans.map((p) => p.country_code || '').filter(Boolean))].sort(),
    all_regions: [...new Set(current.plans.map((p) => p.region || '').filter(Boolean))].sort(),
  });
});

// Raw plans endpoint (for debugging)
app.get('/api/plans', (_, res) => {
  const current = readJson(CURRENT_FILE, { plans: [] });
  res.json(current.plans);
});

app.get('/api/history', (_, res) => {
  const history = readJson(HISTORY_FILE, { changes: [], new_countries: [] });
  res.json(history);
});

app.listen(PORT, () => {
  console.log(`eSIM Price Tracker running on http://localhost:${PORT}`);
});
