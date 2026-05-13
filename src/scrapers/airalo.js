/**
 * Airalo scraper (airalo.com)
 * Strategy: extract __NEXT_DATA__ from country pages (Next.js SSR).
 * Falls back to capturing XHR responses if __NEXT_DATA__ is empty.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://www.airalo.com';

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
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();

    // Step 1: get country list from the deals / home page
    console.error('[Airalo] Loading country list...');
    const capturedJson = [];
    page.on('response', async (res) => {
      const ct = res.headers()['content-type'] || '';
      if (res.status() === 200 && ct.includes('json')) {
        try {
          const text = await res.text();
          if (text.length > 500) {
            console.error(`[Airalo] XHR: ${res.url().substring(0, 100)} (${text.length}b)`);
            capturedJson.push({ url: res.url(), text });
          }
        } catch (_) {}
      }
    });

    await page.goto(`${BASE_URL}/esim-deals`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Extract __NEXT_DATA__ for the listing page (may contain country list)
    const listingNextData = await extractNextData(page);
    if (listingNextData) {
      console.error('[Airalo] Got __NEXT_DATA__ from deals page');
      const plans = deepSearchPlans(listingNextData, 'airalo');
      addUnique(allPlans, seen, plans);
    }

    // Also try XHR responses from listing page
    for (const { url, text } of capturedJson) {
      try {
        const plans = deepSearchPlans(JSON.parse(text), 'airalo');
        if (plans.length > 0) console.error(`[Airalo] ${plans.length} plans from XHR: ${url.substring(0, 80)}`);
        addUnique(allPlans, seen, plans);
      } catch (_) {}
    }

    // Step 2: collect country page links
    const countryLinks = await page.$$eval(
      'a[href*="-esim"]',
      (els, base) =>
        [...new Set(
          els
            .map((el) => el.href)
            .filter((h) => h.startsWith(base) && !h.includes('/global') && !h.includes('/deals') && !h.includes('/store') && h !== base + '/' && h !== base)
        )],
      BASE_URL
    );
    console.error(`[Airalo] Found ${countryLinks.length} country links`);

    // Step 3: visit each country page and extract __NEXT_DATA__
    for (const href of countryLinks) {
      capturedJson.length = 0;
      try {
        await page.goto(href, { waitUntil: 'networkidle', timeout: 40000 });
        await page.waitForTimeout(1500);

        const nd = await extractNextData(page);
        if (nd) {
          const plans = deepSearchPlans(nd, 'airalo');
          if (plans.length > 0) {
            console.error(`[Airalo] ${plans.length} plans from ${href.split('/').pop()}`);
            addUnique(allPlans, seen, plans);
          }
        }

        // Also check XHR
        for (const { text } of capturedJson) {
          try {
            const plans = deepSearchPlans(JSON.parse(text), 'airalo');
            addUnique(allPlans, seen, plans);
          } catch (_) {}
        }
      } catch (err) {
        console.error(`[Airalo] Error on ${href}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.error(`[Airalo] Total: ${allPlans.length} plans`);
  return allPlans;
}

async function extractNextData(page) {
  try {
    const raw = await page.$eval('#__NEXT_DATA__', (el) => el.textContent);
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Recursively search any JSON blob for arrays that look like eSIM plan lists.
 * Airalo's __NEXT_DATA__ nests packages under props.pageProps or React Query cache.
 */
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
    ['price', 'net_price', 'amount', 'cost', 'retail_price', 'priceincents'].some((pk) => k.includes(pk))
  );
  const hasDuration = keys.some((k) =>
    ['day', 'days', 'validity', 'duration', 'period'].some((dk) => k.includes(dk))
  );
  const hasData = keys.some((k) =>
    ['data', 'gb', 'allowance', 'size', 'bandwidth'].some((dk) => k.includes(dk))
  );
  return hasPrice && (hasDuration || hasData);
}

async function normalizePlan(item, provider) {
  // Airalo field patterns (may vary by page type)
  const country =
    item.country ||
    item.operator?.country?.title ||
    item.countries?.[0]?.title ||
    item.location ||
    '';
  const countryCode =
    (item.country_code || item.operator?.country?.slug || item.iso || '').toUpperCase();
  const region =
    item.operator?.country?.region?.title ||
    item.region?.title ||
    item.region ||
    '';

  const dataStr = String(item.data || item.allowance || item.amount || '');
  const dataGb = parseDataGb(dataStr);

  const validityDays =
    parseInt(item.day || item.days || item.validity || item.duration || '0') || null;

  // Price: Airalo typically returns USD
  const priceRaw = parseFloat(
    item.price || item.net_price || item.retail_price || item.priceInCentsUSD / 100 || '0'
  );
  const currency = (item.currency || 'USD').toUpperCase();
  const planName = item.title || item.name || `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays}d`;

  if (!country || priceRaw <= 0) return null;

  const { price_eur, price_usd } = await toEurUsd(priceRaw, currency);

  return {
    provider,
    country,
    country_code: countryCode,
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

function addUnique(allPlans, seen, plans) {
  for (const p of plans) {
    const key = `${p.provider}|${p.country_code || p.country}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
    if (!seen.has(key)) {
      seen.add(key);
      allPlans.push(p);
    }
  }
}

module.exports = { scrape };
