/**
 * Saily scraper (saily.com)
 * Uses __NEXT_DATA__ extraction + XHR capture.
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
    const capturedJson = [];

    page.on('response', async (res) => {
      const ct = res.headers()['content-type'] || '';
      if (res.status() === 200 && ct.includes('json')) {
        try {
          const text = await res.text();
          if (text.length > 500) {
            console.error(`[Saily] XHR: ${res.url().substring(0, 100)} (${text.length}b)`);
            capturedJson.push({ url: res.url(), text });
          }
        } catch (_) {}
      }
    });

    // Load main store / destinations page
    for (const path of ['/', '/store', '/esim', '/destinations']) {
      try {
        console.error(`[Saily] Trying ${BASE_URL}${path}...`);
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(2000);

        const nd = await extractNextData(page);
        if (nd) {
          const plans = deepSearchPlans(nd, 'saily');
          console.error(`[Saily] __NEXT_DATA__ from ${path}: ${plans.length} plans`);
          addUnique(allPlans, seen, plans);
        }

        for (const { text } of capturedJson) {
          try {
            const plans = deepSearchPlans(JSON.parse(text), 'saily');
            addUnique(allPlans, seen, plans);
          } catch (_) {}
        }

        if (allPlans.length > 0) break;
      } catch (_) {}
    }

    // Collect country links and visit each
    const countryLinks = await page.$$eval(
      'a[href*="esim"], a[href*="country"], a[href*="destination"], a[href*="/store/"]',
      (els, base) =>
        [...new Set(
          els
            .map((el) => el.href)
            .filter((h) => h.startsWith(base) && h !== base && h !== base + '/')
        )].slice(0, 200),
      BASE_URL
    );
    console.error(`[Saily] ${countryLinks.length} country links found`);

    for (const href of countryLinks) {
      capturedJson.length = 0;
      try {
        await page.goto(href, { waitUntil: 'networkidle', timeout: 35000 });
        await page.waitForTimeout(1200);

        const nd = await extractNextData(page);
        if (nd) {
          const plans = deepSearchPlans(nd, 'saily');
          if (plans.length > 0) console.error(`[Saily] ${plans.length} from ${href.split('/').pop()}`);
          addUnique(allPlans, seen, plans);
        }

        for (const { text } of capturedJson) {
          try {
            addUnique(allPlans, seen, deepSearchPlans(JSON.parse(text), 'saily'));
          } catch (_) {}
        }
      } catch (_) {}
    }
  } finally {
    await browser.close();
  }

  console.error(`[Saily] Total: ${allPlans.length} plans`);
  return allPlans;
}

async function extractNextData(page) {
  try {
    const raw = await page.$eval('#__NEXT_DATA__', (el) => el.textContent);
    return JSON.parse(raw);
  } catch (_) {
    // Try Nuxt / generic window state
    try {
      return await page.evaluate(() => window.__NUXT__ || window.__INITIAL_STATE__ || null);
    } catch (_) {
      return null;
    }
  }
}

function deepSearchPlans(obj, provider, depth = 0, results = []) {
  if (depth > 20 || !obj) return results;

  if (Array.isArray(obj) && obj.length > 0 && obj.length < 2000) {
    const sample = obj[0];
    if (sample && typeof sample === 'object' && looksLikePlan(sample)) {
      const plans = obj.map((item) => normalizePlan(item, provider)).filter(Boolean);
      if (plans.length > 0) results.push(...plans);
      return results;
    }
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj)) {
      deepSearchPlans(v, provider, depth + 1, results);
    }
  }

  return results;
}

function looksLikePlan(obj) {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const hasPrice = keys.some((k) =>
    ['price', 'net_price', 'amount', 'cost', 'retail_price'].some((pk) => k.includes(pk))
  );
  const hasDuration = keys.some((k) =>
    ['day', 'days', 'validity', 'duration'].some((dk) => k.includes(dk))
  );
  const hasData = keys.some((k) =>
    ['data', 'gb', 'allowance', 'size', 'bandwidth'].some((dk) => k.includes(dk))
  );
  return hasPrice && (hasDuration || hasData);
}

async function normalizePlan(item, provider) {
  const country = item.country || item.country_name || item.destination || item.name || '';
  const countryCode = (item.country_code || item.iso_code || item.code || '').toUpperCase();
  const region = item.region || item.continent || '';
  const dataStr = String(item.data || item.data_amount || item.size || item.allowance || '');
  const dataGb = parseDataGb(dataStr);
  const validityDays = parseInt(item.validity || item.days || item.duration || item.day || '0') || null;
  const priceRaw = parseFloat(item.price || item.amount || item.cost || item.net_price || '0');
  const currency = (item.currency || 'USD').toUpperCase();

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);

  return {
    provider,
    country,
    country_code: countryCode,
    region,
    plan_name: item.title || item.name || `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays}d`,
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

function addUnique(allPlans, seen, plans) {
  for (const p of plans) {
    const key = `${p.provider}|${p.country_code || p.country}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
    if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
  }
}

module.exports = { scrape };
