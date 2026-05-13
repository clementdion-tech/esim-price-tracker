/**
 * Holafly scraper (esim.holafly.com)
 * Holafly sells unlimited data plans. They use a Nuxt.js / Vue frontend.
 * Strategy: capture XHR + extract __NUXT__ / window state + DOM fallback.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://esim.holafly.com';

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
          if (text.length > 300) {
            console.error(`[Holafly] XHR: ${res.url().substring(0, 100)} (${text.length}b)`);
            capturedJson.push({ url: res.url(), text });
          }
        } catch (_) {}
      }
    });

    // Try English and French entry points
    for (const path of ['/', '/en/', '/en/esim/', '/fr/', '/esim/']) {
      try {
        console.error(`[Holafly] Trying ${BASE_URL}${path}`);
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(2500);
        await autoScroll(page);
        await page.waitForTimeout(1500);

        // Try multiple window state patterns
        const windowState = await page.evaluate(() => {
          try { return window.__NUXT__ || null; } catch (_) { return null; }
        });
        if (windowState) {
          const plans = deepSearchPlans(windowState, 'holafly');
          console.error(`[Holafly] __NUXT__ plans: ${plans.length}`);
          addUnique(allPlans, seen, plans);
        }

        // Next.js fallback
        const nd = await extractNextData(page);
        if (nd) {
          const plans = deepSearchPlans(nd, 'holafly');
          console.error(`[Holafly] __NEXT_DATA__ plans: ${plans.length}`);
          addUnique(allPlans, seen, plans);
        }

        // XHR responses
        for (const { url, text } of capturedJson) {
          try {
            const plans = deepSearchPlans(JSON.parse(text), 'holafly');
            if (plans.length > 0) console.error(`[Holafly] ${plans.length} from XHR ${url.substring(0, 80)}`);
            addUnique(allPlans, seen, plans);
          } catch (_) {}
        }

        if (allPlans.length > 0) break;
      } catch (err) {
        console.error(`[Holafly] ${path} error: ${err.message}`);
      }
    }

    // Get country links and visit individually
    const countryLinks = await page.$$eval(
      'a[href*="esim"], a[href*="country"], a[href*="destino"], a[href*="destination"]',
      (els, base) =>
        [...new Set(
          els
            .map((el) => el.href)
            .filter((h) => h.startsWith(base) && h !== base && !h.includes('#'))
        )].slice(0, 200),
      BASE_URL
    );
    console.error(`[Holafly] ${countryLinks.length} country links`);

    for (const href of countryLinks) {
      capturedJson.length = 0;
      try {
        await page.goto(href, { waitUntil: 'networkidle', timeout: 35000 });
        await page.waitForTimeout(1500);

        // Window state
        const ws = await page.evaluate(() => {
          try { return window.__NUXT__ || null; } catch (_) { return null; }
        });
        if (ws) addUnique(allPlans, seen, deepSearchPlans(ws, 'holafly'));

        const nd = await extractNextData(page);
        if (nd) addUnique(allPlans, seen, deepSearchPlans(nd, 'holafly'));

        // XHR
        for (const { text } of capturedJson) {
          try { addUnique(allPlans, seen, deepSearchPlans(JSON.parse(text), 'holafly')); } catch (_) {}
        }

        // DOM fallback: Holafly shows duration + price as cards
        const domPlans = await extractHolaflyDom(page, href);
        addUnique(allPlans, seen, domPlans);

      } catch (_) {}
    }
  } finally {
    await browser.close();
  }

  console.error(`[Holafly] Total: ${allPlans.length} plans`);
  return allPlans;
}

async function extractNextData(page) {
  try {
    const raw = await page.$eval('#__NEXT_DATA__', (el) => el.textContent);
    return JSON.parse(raw);
  } catch (_) { return null; }
}

async function extractHolaflyDom(page, href) {
  const plans = [];
  try {
    const countrySlug = href.replace(/\/$/, '').split('/').pop() || '';
    const countryName = countrySlug.replace(/-esim.*$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    const cards = await page.evaluate(() => {
      const results = [];
      // Holafly renders plan options with duration + price
      const allText = document.body.innerText;
      // Look for "X days" next to a price pattern
      const regex = /(\d+)\s*(?:day|jour|día|giorni|Tag)s?[^\n€$]*[€$]\s*(\d+(?:[.,]\d+)?)/gi;
      let m;
      while ((m = regex.exec(allText)) !== null) {
        results.push({ days: parseInt(m[1]), price: parseFloat(m[2].replace(',', '.')) });
      }
      return results;
    });

    for (const { days, price } of cards) {
      if (days > 0 && price > 0) {
        const { price_eur, price_usd } = await toEurUsd(price, 'EUR');
        plans.push({
          provider: 'holafly',
          country: countryName,
          country_code: '',
          region: '',
          plan_name: `Unlimited / ${days}d`,
          data_gb: null,
          plan_type: 'unlimited',
          validity_days: days,
          price_eur,
          price_usd,
        });
      }
    }
  } catch (_) {}
  return plans;
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
  const hasPrice = keys.some((k) => ['price', 'amount', 'cost'].some((pk) => k.includes(pk)));
  const hasDuration = keys.some((k) => ['day', 'days', 'validity', 'duration'].some((dk) => k.includes(dk)));
  return hasPrice && hasDuration;
}

async function normalizePlan(item, provider) {
  const country = item.country || item.country_name || item.destination || item.location || '';
  const countryCode = (item.country_code || item.iso || item.code || '').toUpperCase();
  const region = item.region || item.continent || '';
  const dataStr = String(item.data || item.data_amount || '');
  const dataGb = parseDataGb(dataStr);
  const isUnlimited = dataGb === null || item.unlimited || item.is_unlimited ||
    String(item.data || '').toLowerCase().includes('unlimited');
  const validityDays = parseInt(item.duration || item.days || item.validity || item.day || '0') || null;
  const priceRaw = parseFloat(item.price || item.amount || item.cost || '0');
  const currency = (item.currency || 'EUR').toUpperCase();

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);

  return {
    provider,
    country,
    country_code: countryCode,
    region,
    plan_name: item.title || item.name || (isUnlimited ? `Unlimited / ${validityDays}d` : `${dataGb}GB / ${validityDays}d`),
    data_gb: isUnlimited ? null : dataGb,
    plan_type: isUnlimited ? 'unlimited' : 'data',
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
  return n;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        total += 400;
        if (total >= document.body.scrollHeight - window.innerHeight) { clearInterval(timer); resolve(); }
      }, 200);
    });
  });
}

function addUnique(allPlans, seen, plans) {
  for (const p of plans) {
    const key = `${p.provider}|${p.country_code || p.country}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
    if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
  }
}

module.exports = { scrape };
