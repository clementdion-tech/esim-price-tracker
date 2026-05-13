/**
 * Holafly scraper (esim.holafly.com)
 * Holafly specialises in unlimited daily data plans.
 * Plans are priced by country + duration (e.g. 7 days, 30 days).
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://esim.holafly.com';

// Holafly uses path segments per language; /fr/ is French — we navigate the English root
const START_PATHS = ['/', '/en/', '/esim/', '/store/'];

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
            (text.includes('"price"') || text.includes('"amount"') || text.includes('"cost"')) &&
            (text.includes('"country"') || text.includes('"destination"') || text.includes('"duration"'))
          ) {
            apiResponses.push({ url, text });
          }
        } catch (_) {}
      }
    });

    for (const path of START_PATHS) {
      try {
        console.error(`[Holafly] Trying ${BASE_URL}${path}...`);
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        await autoScroll(page);
        await page.waitForTimeout(1500);
        if (apiResponses.length > 0) break;
      } catch (_) {}
    }

    console.error(`[Holafly] Captured ${apiResponses.length} API responses`);

    for (const { url, text } of apiResponses) {
      try {
        const json = JSON.parse(text);
        const plans = parseHolaflyResponse(json);
        for (const p of plans) {
          const key = `${p.country_code}|${p.plan_type}|${p.validity_days}|${p.price_eur}`;
          if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
        }
        if (plans.length > 0) {
          console.error(`[Holafly] Extracted ${plans.length} plans from ${url}`);
        }
      } catch (_) {}
    }

    // If API interception didn't yield results, scrape country pages from the DOM
    if (allPlans.length < 10) {
      console.error('[Holafly] Falling back to DOM country listing...');
      const countryLinks = await page.$$eval(
        'a[href*="esim"], a[href*="country"], a[href*="destination"]',
        (els) =>
          [...new Set(els.map((el) => el.href))]
            .filter((h) => h.startsWith('http') && !h.includes('#'))
            .slice(0, 150)
      );

      for (const href of countryLinks) {
        apiResponses.length = 0;
        try {
          await page.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1200);

          // Try to extract pricing from the DOM (Holafly typically lists duration + price in cards)
          const domPlans = await extractHolaflyDom(page, href);
          for (const p of domPlans) {
            const key = `${p.country_code}|${p.plan_type}|${p.validity_days}|${p.price_eur}`;
            if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
          }

          for (const { text } of apiResponses) {
            try {
              const json = JSON.parse(text);
              const plans = parseHolaflyResponse(json);
              for (const p of plans) {
                const key = `${p.country_code}|${p.plan_type}|${p.validity_days}|${p.price_eur}`;
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

  console.error(`[Holafly] Total: ${allPlans.length} plans`);
  return allPlans;
}

function parseHolaflyResponse(data) {
  const plans = [];
  const items = findArray(data);
  if (!items) return plans;

  for (const item of items) {
    try {
      const plan = normalizeHolafly(item);
      if (plan) plans.push(plan);
    } catch (_) {}
  }
  return plans;
}

function findArray(data) {
  if (Array.isArray(data) && data.length && hasPrice(data[0])) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'packages', 'plans', 'products', 'esims', 'destinations', 'items', 'results']) {
      if (Array.isArray(data[key]) && data[key].length && hasPrice(data[key][0])) {
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

function hasPrice(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.keys(obj).some((k) => ['price', 'amount', 'cost'].includes(k.toLowerCase()));
}

async function normalizeHolafly(item) {
  const country = item.country || item.country_name || item.destination || item.location || '';
  const countryCode = item.country_code || item.iso || item.code || '';
  const region = item.region || item.continent || '';
  const dataStr = String(item.data || item.data_amount || '');
  const dataGb = parseDataGb(dataStr);
  const validityDays = parseInt(item.duration || item.days || item.validity || item.day || '0') || null;
  const priceRaw = parseFloat(item.price || item.amount || item.cost || '0');
  const currency = (item.currency || 'EUR').toUpperCase(); // Holafly primary currency is EUR

  const isUnlimited =
    item.is_unlimited ||
    item.unlimited ||
    String(item.data || '').toLowerCase().includes('unlimited') ||
    dataGb === null;

  // Detect daily pass type
  const planType = item.is_daily || item.type === 'daily' ? 'daily' : isUnlimited ? 'unlimited' : 'data';

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);
  const planName =
    item.title ||
    item.name ||
    (planType === 'unlimited' ? `Unlimited / ${validityDays}d` : `${dataGb}GB / ${validityDays}d`);

  return {
    provider: 'holafly',
    country,
    country_code: countryCode.toUpperCase(),
    region,
    plan_name: planName,
    data_gb: isUnlimited ? null : dataGb,
    plan_type: planType,
    validity_days: validityDays,
    price_eur,
    price_usd,
  };
}

async function extractHolaflyDom(page, href) {
  // Extract country name from URL and structured pricing from DOM
  const plans = [];
  try {
    const countrySlug = href.split('/').filter(Boolean).pop()?.replace(/-esim.*$/, '') || '';

    const data = await page.evaluate(() => {
      const results = [];
      // Holafly typically renders plan cards with duration and price
      const cards = document.querySelectorAll(
        '[class*="plan"], [class*="card"], [class*="option"], [class*="package"], [class*="duration"]'
      );
      cards.forEach((card) => {
        const text = card.textContent || '';
        const priceMatch = text.match(/€\s*(\d+(?:[.,]\d+)?)/);
        const daysMatch = text.match(/(\d+)\s*(?:day|jour|día|giorni)/i);
        if (priceMatch && daysMatch) {
          results.push({
            price: parseFloat(priceMatch[1].replace(',', '.')),
            days: parseInt(daysMatch[1]),
            text: text.trim().substring(0, 100),
          });
        }
      });
      // Also try JSON-LD structured data
      const jsonLd = document.querySelector('script[type="application/ld+json"]');
      if (jsonLd) {
        try {
          results.push({ jsonLd: JSON.parse(jsonLd.textContent) });
        } catch (_) {}
      }
      return results;
    });

    const countryName = countrySlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    for (const item of data) {
      if (item.price && item.days) {
        const { price_eur, price_usd } = await toEurUsd(item.price, 'EUR');
        plans.push({
          provider: 'holafly',
          country: countryName,
          country_code: '',
          region: '',
          plan_name: `Unlimited / ${item.days}d`,
          data_gb: null,
          plan_type: 'unlimited',
          validity_days: item.days,
          price_eur,
          price_usd,
        });
      }
    }
  } catch (_) {}
  return plans;
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
