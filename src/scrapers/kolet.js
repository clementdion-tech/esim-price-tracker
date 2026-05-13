/**
 * Kolet.com scraper
 * Navigates the Kolet website and extracts eSIM plans per country.
 * Uses network interception to capture the JSON pricing API.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://kolet.com';

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const plans = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    const captured = [];

    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (response.status() === 200 && ct.includes('json')) {
        try {
          const text = await response.text();
          // Look for responses that contain pricing/plans data
          if (
            text.length > 100 &&
            (text.includes('"price"') ||
              text.includes('"amount"') ||
              text.includes('"data"') ||
              text.includes('"plans"') ||
              text.includes('"packages"'))
          ) {
            captured.push({ url, text });
          }
        } catch (_) {}
      }
    });

    console.error('[Kolet] Navigating to homepage...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Try the /esim or /shop page
    for (const path of ['/esim', '/shop', '/store', '/data-plans', '/packages']) {
      try {
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        if (captured.length > 0) break;
      } catch (_) {}
    }

    console.error(`[Kolet] Captured ${captured.length} API responses`);

    for (const { url, text } of captured) {
      try {
        const json = JSON.parse(text);
        const extracted = extractPlans(json, 'kolet');
        if (extracted.length > 0) {
          console.error(`[Kolet] Extracted ${extracted.length} plans from ${url}`);
          plans.push(...extracted);
        }
      } catch (_) {}
    }

    // DOM fallback — look for price cards
    if (plans.length === 0) {
      console.error('[Kolet] Falling back to DOM parsing...');
      const domPlans = await parseDom(page);
      plans.push(...domPlans);
    }
  } finally {
    await browser.close();
  }

  console.error(`[Kolet] Total plans: ${plans.length}`);
  return plans;
}

function extractPlans(data, provider) {
  const plans = [];
  const items = findArrayWithPlans(data);
  if (!items) return plans;

  for (const item of items) {
    try {
      const plan = normalizePlan(item, provider);
      if (plan) plans.push(plan);
    } catch (_) {}
  }
  return plans;
}

function findArrayWithPlans(data) {
  if (Array.isArray(data) && data.length > 0 && hasPlansShape(data[0])) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'plans', 'packages', 'products', 'items', 'results', 'esims']) {
      if (Array.isArray(data[key]) && data[key].length > 0 && hasPlansShape(data[key][0])) {
        return data[key];
      }
    }
    // One more level deep
    for (const key of Object.keys(data)) {
      if (data[key] && typeof data[key] === 'object') {
        const nested = findArrayWithPlans(data[key]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function hasPlansShape(item) {
  if (!item || typeof item !== 'object') return false;
  const keys = Object.keys(item).map((k) => k.toLowerCase());
  return (
    (keys.includes('price') || keys.includes('amount') || keys.includes('cost')) &&
    (keys.includes('country') || keys.includes('region') || keys.includes('destination'))
  );
}

async function normalizePlan(item, provider) {
  const country = item.country || item.country_name || item.destination || item.location || '';
  const countryCode = item.country_code || item.iso || item.code || '';
  const region = item.region || item.continent || '';
  const dataStr = String(item.data || item.amount || item.data_amount || item.size || '');
  const dataGb = parseDataGb(dataStr);
  const validityDays = parseInt(item.validity || item.days || item.duration || item.day || '0') || null;
  const priceRaw = parseFloat(item.price || item.cost || item.amount_usd || item.price_usd || '0');
  const currency = (item.currency || item.price_currency || 'USD').toUpperCase();
  const planName =
    item.title ||
    item.name ||
    item.plan_name ||
    `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays}d`;

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);

  return {
    provider,
    country,
    country_code: countryCode.toUpperCase(),
    region,
    plan_name: planName,
    data_gb: dataGb,
    plan_type: dataGb === null ? 'unlimited' : 'data',
    validity_days: validityDays,
    price_eur,
    price_usd,
  };
}

function parseDataGb(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();
  if (s.includes('unlimited') || s === '∞') return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(gb|mb|tb)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'mb') return Math.round((n / 1024) * 100) / 100;
  if (unit === 'tb') return n * 1024;
  return n;
}

async function parseDom(page) {
  // Generic DOM parser for pricing cards — adjust selectors after inspecting the live site
  return page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll(
      '[class*="plan"], [class*="package"], [class*="offer"], [class*="product"], [class*="card"]'
    );
    cards.forEach((card) => {
      const text = card.textContent;
      const priceMatch = text.match(/[$€£]?\s*(\d+(?:[.,]\d+)?)\s*[$€£]?/);
      const dataMatch = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
      if (priceMatch && dataMatch) {
        results.push({ rawText: text.trim().substring(0, 200) });
      }
    });
    return results;
  });
}

module.exports = { scrape };
