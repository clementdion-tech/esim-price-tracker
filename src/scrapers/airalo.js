/**
 * Airalo scraper (airalo.com)
 *
 * Strategy:
 *  1. Fetch the country list from the Airalo public API (no browser needed).
 *  2. For each country, open its [slug]-esim page with Playwright.
 *  3. Wait for the package buttons to appear in the DOM.
 *  4. Extract duration groups + button text via page.evaluate (sync — no async inside).
 *  5. Convert prices to EUR/USD outside evaluate (toEurUsd is async).
 *  6. Process countries 4 at a time (Promise.all over chunks of 4).
 */

const axios = require('axios');
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://www.airalo.com';
const COUNTRIES_API = 'https://www.airalo.com/api/v4/countries';
const CONCURRENCY = 4;

// ─── Main export ─────────────────────────────────────────────────────────────

async function scrape() {
  // Step 1: fetch country list (plain HTTP — fast, no browser)
  console.error('[Airalo] Fetching country list from API...');
  const countries = await fetchCountryList();
  console.error(`[Airalo] ${countries.length} countries to scrape`);

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

    // Respect SCRAPE_SAMPLE env var (set by test.js --sample=N for fast CI validation)
    const sampleLimit = process.env.SCRAPE_SAMPLE ? parseInt(process.env.SCRAPE_SAMPLE) : Infinity;
    const countriesToScrape = countries.slice(0, sampleLimit);

    // Process in chunks of CONCURRENCY (4 parallel pages)
    for (let i = 0; i < countriesToScrape.length; i += CONCURRENCY) {
      const chunk = countriesToScrape.slice(i, i + CONCURRENCY);

      const chunkResults = await Promise.all(
        chunk.map(async (c, j) => {
          const idx = i + j + 1;
          const page = await context.newPage();
          try {
            return await scrapeCountryPage(page, c, idx, countries.length);
          } finally {
            await page.close();
          }
        })
      );

      for (const plans of chunkResults) {
        addUnique(allPlans, seen, plans);
      }
    }
  } finally {
    await browser.close();
  }

  console.error(`[Airalo] Total: ${allPlans.length} plans`);
  return allPlans;
}

// ─── Country list ─────────────────────────────────────────────────────────────

async function fetchCountryList() {
  try {
    const { data } = await axios.get(COUNTRIES_API, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; esim-price-tracker/1.0)',
      },
      timeout: 30000,
    });

    // API returns { data: [ {id, slug, title}, ... ] } or a bare array
    const list = Array.isArray(data) ? data : (data?.data ?? []);
    return list.filter((c) => c.slug && c.title);
  } catch (err) {
    console.error(`[Airalo] Country API error: ${err.message}`);
    // Minimal fallback so we still get some data
    return [{ slug: 'france', title: 'France', id: 'fr' }];
  }
}

// ─── Per-country page scraping ────────────────────────────────────────────────

async function scrapeCountryPage(page, country, idx, total) {
  const url = `${BASE_URL}/${country.slug}-esim`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait up to 12 s for the package buttons to appear
    const rawPlans = await extractPackagesFromPage(page, country.title, country.slug);

    if (rawPlans.length === 0) {
      console.error(`[Airalo] [${idx}/${total}] ${country.title} — 0 plans (no buttons found)`);
      return [];
    }

    // Convert prices outside page.evaluate (toEurUsd is async)
    const plans = await Promise.all(
      rawPlans.map(async (raw) => {
        const { price_eur, price_usd } = await toEurUsd(raw.price, raw.currency);
        return {
          provider: 'airalo',
          country: country.title,
          country_code: String(country.slug || '').toUpperCase().slice(0, 3),
          region: country.region || '',
          plan_name: `${raw.dataGb === null ? 'Unlimited' : raw.dataGb + 'GB'} / ${raw.validityDays}d`,
          data_gb: raw.dataGb,
          plan_type: raw.dataGb === null ? 'unlimited' : 'data',
          validity_days: raw.validityDays,
          price_eur,
          price_usd,
        };
      })
    );

    console.error(`[Airalo] [${idx}/${total}] ${country.title} — ${plans.length} plans`);
    return plans;
  } catch (err) {
    console.error(`[Airalo] [${idx}/${total}] ${country.title} error: ${err.message}`);
    return [];
  }
}

// ─── DOM extraction (runs inside page.evaluate — must be synchronous) ─────────

/**
 * Wait for package buttons, then extract raw plan data from the DOM.
 * Returns an array of { dataGb, price, currency, validityDays }.
 * All heavy lifting (currency conversion, normalization) happens outside.
 */
async function extractPackagesFromPage(page, countryName, countrySlug) {
  try {
    await page.waitForSelector(
      '[data-testid="package-grouped-packages_package-button"]',
      { timeout: 12000 }
    );
  } catch {
    // Buttons never appeared — page may be geo-blocked or empty
    return [];
  }

  // page.evaluate runs synchronously in the browser context
  return page.evaluate(() => {
    const plans = [];

    /**
     * Find all "duration group" containers.
     * Each group is a DIV whose text starts with "N days" and that contains
     * at least one package button.
     *
     * Strategy: find all buttons first, then walk up to their parent container
     * that also holds a "N days" text node, so we don't depend on a specific
     * class name that can change.
     */
    const buttons = [
      ...document.querySelectorAll('[data-testid="package-grouped-packages_package-button"]'),
    ];

    for (const btn of buttons) {
      // Button text looks like "1GB£3.50" or "3 GB $5.50" or "10GB€11.50"
      const text = btn.textContent.trim();
      const gbMatch = text.match(/(\d+(?:\.\d+)?)\s*GB/i);
      const priceMatch = text.match(/([£$€])\s*(\d+(?:\.\d+)?)/);

      if (!gbMatch || !priceMatch) continue;

      const dataGb = parseFloat(gbMatch[1]);
      const price = parseFloat(priceMatch[2]);
      const sym = priceMatch[1];
      const currency = sym === '£' ? 'GBP' : sym === '$' ? 'USD' : 'EUR';

      // Walk up the DOM tree to find the duration group container
      // (a parent that contains a "N days" text node but not the button's sibling text)
      let validityDays = null;
      let node = btn.parentElement;
      for (let depth = 0; depth < 10 && node; depth++) {
        const nodeText = node.textContent || '';
        const daysMatch = nodeText.match(/(\d+)\s*days?/i);
        if (daysMatch) {
          validityDays = parseInt(daysMatch[1], 10);
          break;
        }
        node = node.parentElement;
      }

      if (price > 0) {
        plans.push({ dataGb, price, currency, validityDays });
      }
    }

    return plans;
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
