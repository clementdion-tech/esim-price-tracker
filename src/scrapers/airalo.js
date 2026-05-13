/**
 * Airalo scraper (airalo.com)
 * Intercepts the internal REST API that powers their package listings.
 * Airalo uses Next.js; packages are fetched from an internal API at /api/v2/packages.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');
const axios = require('axios');

const BASE_URL = 'https://www.airalo.com';

// Region slugs to iterate
const REGIONS = [
  'africa', 'asia', 'caribbean-islands', 'central-america',
  'europe', 'middle-east', 'north-america', 'oceania',
  'south-america',
];

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

    // Capture all JSON API calls
    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (
        response.status() === 200 &&
        ct.includes('json') &&
        (url.includes('/api/') || url.includes('/_next/') || url.includes('packages') || url.includes('countries'))
      ) {
        try {
          const text = await response.text();
          if (text.includes('"price"') && (text.includes('"country"') || text.includes('"operator"'))) {
            apiResponses.push({ url, text });
          }
        } catch (_) {}
      }
    });

    // First try the deals page which loads a broad set of packages
    console.error('[Airalo] Loading deals page...');
    await page.goto(`${BASE_URL}/esim-deals`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Scroll to trigger lazy-loaded content
    await autoScroll(page);
    await page.waitForTimeout(2000);

    // Process captured API responses
    for (const { url, text } of apiResponses) {
      try {
        const json = JSON.parse(text);
        const plans = parseAiraloResponse(json);
        for (const p of plans) {
          const key = `${p.country_code}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPlans.push(p);
          }
        }
      } catch (_) {}
    }

    console.error(`[Airalo] After deals page: ${allPlans.length} plans`);

    // If we didn't get enough, iterate region pages
    if (allPlans.length < 50) {
      for (const region of REGIONS) {
        apiResponses.length = 0;
        try {
          await page.goto(`${BASE_URL}/${region}-esim`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(2000);
          await autoScroll(page);
          await page.waitForTimeout(1500);

          for (const { text } of apiResponses) {
            try {
              const json = JSON.parse(text);
              const plans = parseAiraloResponse(json);
              for (const p of plans) {
                const key = `${p.country_code}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  allPlans.push(p);
                }
              }
            } catch (_) {}
          }

          // Also get country links from the region page and visit each
          const countryLinks = await page.$$eval(
            'a[href*="-esim"]:not([href*="global"]):not([href*="deals"])',
            (els) => [...new Set(els.map((el) => el.href))].slice(0, 30)
          );

          for (const href of countryLinks) {
            apiResponses.length = 0;
            try {
              await page.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(1500);
              for (const { text } of apiResponses) {
                try {
                  const json = JSON.parse(text);
                  const plans = parseAiraloResponse(json);
                  for (const p of plans) {
                    const key = `${p.country_code}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
                    if (!seen.has(key)) {
                      seen.add(key);
                      allPlans.push(p);
                    }
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }
        } catch (err) {
          console.error(`[Airalo] Region ${region} error: ${err.message}`);
        }

        console.error(`[Airalo] After region ${region}: ${allPlans.length} plans`);
      }
    }
  } finally {
    await browser.close();
  }

  console.error(`[Airalo] Total: ${allPlans.length} plans`);
  return allPlans;
}

function parseAiraloResponse(data) {
  const plans = [];
  const items = findPackageArray(data);
  if (!items) return plans;

  for (const item of items) {
    try {
      const plan = normalizeAiralo(item);
      if (plan) plans.push(plan);
    } catch (_) {}
  }
  return plans;
}

function findPackageArray(data) {
  if (Array.isArray(data)) {
    if (data.length && isPackage(data[0])) return data;
  }
  if (data && typeof data === 'object') {
    for (const key of ['data', 'packages', 'plans', 'esims', 'items', 'results', 'operators']) {
      if (Array.isArray(data[key]) && data[key].length && isPackage(data[key][0])) {
        return data[key];
      }
    }
    // One level deeper
    for (const v of Object.values(data)) {
      if (v && typeof v === 'object') {
        const nested = findPackageArray(v);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function isPackage(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  return keys.some((k) => ['price', 'amount', 'net_price'].includes(k));
}

async function normalizeAiralo(item) {
  // Airalo package structure
  const country =
    item.country ||
    item.operator?.country?.title ||
    item.countries?.[0]?.title ||
    item.location_code ||
    '';
  const countryCode =
    item.country_code ||
    item.operator?.country?.slug?.toUpperCase() ||
    item.location_code ||
    '';
  const region =
    item.operator?.country?.region?.title ||
    item.region?.title ||
    item.region ||
    '';
  const dataStr = String(item.data || item.amount || '');
  const dataGb = parseDataGb(dataStr);
  const validityDays = parseInt(item.day || item.validity || item.duration || '0') || null;
  const planType = item.is_unlimited ? 'unlimited' : dataGb === null ? 'unlimited' : 'data';

  // Price: Airalo typically exposes price in USD
  const priceUsd = parseFloat(item.price || item.net_price || item.amount_usd || '0');
  if (!country || priceUsd <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceUsd, 'USD');
  const planName = item.title || `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays}d`;

  return {
    provider: 'airalo',
    country,
    country_code: countryCode.toUpperCase(),
    region,
    plan_name: planName,
    data_gb: dataGb,
    plan_type: planType,
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
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

module.exports = { scrape };
