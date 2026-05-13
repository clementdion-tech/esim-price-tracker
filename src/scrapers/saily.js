/**
 * Saily scraper (saily.com)
 * Saily is a Nordic eSIM provider. They list packages per country.
 * Their React frontend fetches from an internal API.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://saily.com';

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const allPlans = [];
  const seen = new Set();

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();
    const apiResponses = [];

    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (response.status() === 200 && ct.includes('json')) {
        try {
          const text = await response.text();
          if (
            text.length > 200 &&
            (text.includes('"price"') || text.includes('"amount"')) &&
            (text.includes('"country"') || text.includes('"destination"') || text.includes('"packages"'))
          ) {
            apiResponses.push({ url, text });
          }
        } catch (_) {}
      }
    });

    console.error('[Saily] Loading homepage...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Try dedicated packages/store page
    for (const path of ['/store', '/packages', '/esim', '/destinations', '/plans']) {
      try {
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        if (apiResponses.length > 0) break;
      } catch (_) {}
    }

    // Scroll to trigger lazy loading
    await autoScroll(page);
    await page.waitForTimeout(2000);

    console.error(`[Saily] Captured ${apiResponses.length} API responses`);

    for (const { url, text } of apiResponses) {
      try {
        const json = JSON.parse(text);
        const plans = parseSailyResponse(json);
        for (const p of plans) {
          const key = `${p.country_code}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPlans.push(p);
          }
        }
      } catch (_) {}
    }

    // If not enough data, try getting country list from DOM and visiting each
    if (allPlans.length < 20) {
      console.error('[Saily] Trying country-by-country scrape...');
      const countryLinks = await page.$$eval(
        'a[href*="country"], a[href*="destination"], a[href*="esim"]',
        (els) => [...new Set(els.map((el) => el.href))].filter((h) => h.startsWith('http')).slice(0, 100)
      );

      for (const href of countryLinks) {
        apiResponses.length = 0;
        try {
          await page.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1200);
          for (const { text } of apiResponses) {
            try {
              const json = JSON.parse(text);
              const plans = parseSailyResponse(json);
              for (const p of plans) {
                const key = `${p.country_code}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
                if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
  } finally {
    await browser.close();
  }

  console.error(`[Saily] Total: ${allPlans.length} plans`);
  return allPlans;
}

function parseSailyResponse(data) {
  const plans = [];
  const items = findArray(data);
  if (!items) return plans;

  for (const item of items) {
    try {
      const plan = normalizeSaily(item);
      if (plan) plans.push(plan);
    } catch (_) {}
  }
  return plans;
}

function findArray(data) {
  if (Array.isArray(data) && data.length && hasPriceKey(data[0])) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'packages', 'plans', 'products', 'destinations', 'items', 'results']) {
      if (Array.isArray(data[key]) && data[key].length && hasPriceKey(data[key][0])) {
        return data[key];
      }
    }
    for (const v of Object.values(data)) {
      if (v && typeof v === 'object') {
        const nested = findArray(v);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function hasPriceKey(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.keys(obj).some((k) => ['price', 'amount', 'cost', 'net_price'].includes(k.toLowerCase()));
}

async function normalizeSaily(item) {
  const country = item.country || item.country_name || item.destination || item.name || '';
  const countryCode = item.country_code || item.iso_code || item.code || '';
  const region = item.region || item.continent || '';
  const dataStr = String(item.data || item.data_amount || item.size || '');
  const dataGb = parseDataGb(dataStr);
  const validityDays = parseInt(item.validity || item.days || item.duration || item.day || '0') || null;
  const priceRaw = parseFloat(item.price || item.amount || item.cost || '0');
  const currency = (item.currency || 'USD').toUpperCase();
  const planName = item.title || item.name || `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays}d`;

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);

  return {
    provider: 'saily',
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

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        total += 400;
        if (total >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

module.exports = { scrape };
