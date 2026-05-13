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
const { addUnique, buildPlan, launchBrowser } = require('../lib/scraperUtils');

const BASE_URL = 'https://www.airalo.com';
const COUNTRIES_API = 'https://www.airalo.com/api/v4/countries';
const REGIONS_API = 'https://www.airalo.com/api/v4/regions';
const CONCURRENCY = 4;

// ─── Main export ─────────────────────────────────────────────────────────────

async function scrape() {
  // Step 1: fetch countries + regions (plain HTTP — fast, no browser)
  console.error('[Airalo] Fetching country + region list from API...');
  const [countries, regions] = await Promise.all([fetchCountryList(), fetchRegionList()]);
  const allDestinations = [...countries, ...regions];
  console.error(`[Airalo] ${countries.length} countries + ${regions.length} regions = ${allDestinations.length} total`);

  const browser = await launchBrowser(chromium);

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
    const limit = parseInt(process.env.SCRAPE_SAMPLE || 'Infinity');
    const countriesToScrape = allDestinations.slice(0, limit);

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
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; esim-price-tracker/1.0)' },
      timeout: 30000,
    });
    const list = Array.isArray(data) ? data : (data?.data ?? []);
    return list.filter((c) => c.slug && c.title);
  } catch (err) {
    console.error(`[Airalo] Country API error: ${err.message}`);
    return [{ slug: 'france', title: 'France' }];
  }
}

async function fetchRegionList() {
  try {
    const { data } = await axios.get(REGIONS_API, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; esim-price-tracker/1.0)' },
      timeout: 30000,
    });
    const list = Array.isArray(data) ? data : (data?.data ?? []);
    // Tag as regional so the dashboard can distinguish them
    return list.filter((r) => r.slug && r.title).map((r) => ({ ...r, isRegional: true }));
  } catch (err) {
    console.error(`[Airalo] Region API error: ${err.message}`);
    return [];
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
      rawPlans.map((raw) =>
        buildPlan({
          provider: 'airalo',
          country: country.title,
          country_code: String(country.slug || '').toUpperCase().slice(0, 3),
          region: country.region || '',
          dataGb: raw.dataGb,
          validityDays: raw.validityDays,
          price: raw.price,
          currency: raw.currency,
          isRegional: country.isRegional || false,
        })
      )
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
    return [];
  }

  // Wait for button content to hydrate
  await page.waitForFunction(
    () => document.querySelector('[data-testid="package-grouped-packages_package-button"]')?.textContent?.match(/[£$€]/),
    { timeout: 8000 }
  ).catch(() => {});

  // Extract from the current tab (Standard data plans)
  const standardPlans = await extractButtonPlans(page);

  // Check if an "Unlimited" tab exists and click it
  const hasUnlimitedTab = await page.$('[data-testid="segmented-control_tab-unlimited"]') !== null;
  let unlimitedPlans = [];

  if (hasUnlimitedTab) {
    try {
      await page.click('[data-testid="segmented-control_tab-unlimited"]');
      // Fixed wait — avoids waitForFunction timeout on cloud IPs where rendering is slower.
      // On UK IP the tab shows same standard plans; on US IP (GH Actions) it shows Unlimited GB.
      // Either way, extractButtonPlans filters correctly: unlimited=true only when text has "Unlimited".
      await page.waitForTimeout(3000);
      const afterTabPlans = await extractButtonPlans(page);
      // Keep only truly unlimited plans (dataGb === null) to avoid duplicating standard plans
      unlimitedPlans = afterTabPlans.filter(p => p.dataGb === null);
    } catch (_) {
      // Unlimited tab exists but failed to load — skip gracefully
    }
  }

  return [...standardPlans, ...unlimitedPlans];
}

/** Extracts all package button plans from the currently visible tab. Sync-safe. */
function extractButtonPlans(page) {
  return page.evaluate(() => {
    const plans = [];
    const buttons = [
      ...document.querySelectorAll('[data-testid="package-grouped-packages_package-button"]'),
    ];

    for (const btn of buttons) {
      const text = btn.textContent.trim();
      const gbMatch = text.match(/(\d+(?:\.\d+)?)\s*GB/i);
      const isUnlimited = /unlimited/i.test(text);
      const priceMatch = text.match(/([£$€])\s*(\d+(?:\.\d+)?)/);

      if ((!gbMatch && !isUnlimited) || !priceMatch) continue;

      const dataGb = isUnlimited ? null : parseFloat(gbMatch[1]);
      const price = parseFloat(priceMatch[2]);
      const sym = priceMatch[1];
      const currency = sym === '£' ? 'GBP' : sym === '$' ? 'USD' : 'EUR';

      // Walk up DOM to find "N days" group header
      let validityDays = null;
      let node = btn.parentElement;
      for (let depth = 0; depth < 10 && node; depth++) {
        const daysMatch = (node.textContent || '').match(/(\d+)\s*days?/i);
        if (daysMatch) { validityDays = parseInt(daysMatch[1], 10); break; }
        node = node.parentElement;
      }

      if (price > 0) plans.push({ dataGb, price, currency, validityDays });
    }
    return plans;
  });
}

module.exports = { scrape };
