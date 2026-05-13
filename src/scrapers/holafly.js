/**
 * Holafly scraper (esim.holafly.com)
 *
 * Strategy:
 *  1. Fetch product-sitemap.xml — contains all 400+ Holafly country/city pages.
 *  2. Cross-reference with Airalo country + region slugs to filter out sub-country
 *     city pages (e.g. esim-chennai, esim-perth) while keeping real countries.
 *  3. For each matched page, parse duration + price text patterns.
 *  4. Process 3 pages in parallel.
 *
 * Holafly sells UNLIMITED data plans priced by duration (1d, 3d, 5d, 7d, 10d, 15d, 30d).
 * Prices are shown in the user's currency (USD on GH Actions US servers, GBP on UK IPs).
 */
const axios = require('axios');
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');
const { isUtilitySlug, isHolaflyCity } = require('../lib/utils');

const BASE_URL = 'https://esim.holafly.com';
const SITEMAP_URL = 'https://esim.holafly.com/product-sitemap.xml';
const AIRALO_COUNTRIES_API = 'https://www.airalo.com/api/v4/countries';
const AIRALO_REGIONS_API = 'https://www.airalo.com/api/v4/regions';
const CONCURRENCY = 3;

/** Fetch all Holafly country pages from sitemap, cross-referenced with Airalo slugs */
async function getCountryLinks() {
  // 1. Get Airalo slug list (our source of truth for what counts as a country/region)
  let allowedSlugs = new Set();
  try {
    const [countries, regions] = await Promise.all([
      axios.get(AIRALO_COUNTRIES_API, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }),
      axios.get(AIRALO_REGIONS_API,   { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }),
    ]);
    for (const c of (Array.isArray(countries.data) ? countries.data : [])) {
      if (c.slug) allowedSlugs.add(c.slug.toLowerCase());
    }
    for (const r of (Array.isArray(regions.data) ? regions.data : [])) {
      if (r.slug) allowedSlugs.add(r.slug.toLowerCase());
    }
    console.error(`[Holafly] Airalo reference: ${allowedSlugs.size} slugs`);
  } catch (err) {
    console.error(`[Holafly] Airalo API error: ${err.message} — using sitemap only`);
  }

  // 2. Get all Holafly product pages from sitemap
  let sitemapUrls = [];
  try {
    const r = await axios.get(SITEMAP_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    sitemapUrls = r.data.match(/<loc>(https:\/\/esim\.holafly\.com\/esim-[^<]+)<\/loc>/g)
      ?.map(m => m.replace(/<\/?loc>/g, '')) || [];
    console.error(`[Holafly] Sitemap: ${sitemapUrls.length} esim-* pages`);
  } catch (err) {
    console.error(`[Holafly] Sitemap error: ${err.message}`);
  }

  // 3. Filter: keep slugs that are in Airalo's list OR are known regional bundles
  const links = sitemapUrls.filter(url => {
    const slug = url.replace(BASE_URL + '/esim-', '').replace(/\/$/, '');
    if (isUtilitySlug(slug) || isHolaflyCity(slug)) return false;
    // If we have Airalo reference data, only keep matching slugs
    if (allowedSlugs.size > 0) return allowedSlugs.has(slug.toLowerCase());
    // Fallback: exclude obvious city patterns
    return !/-(city|town|state|province|region|district)$/.test(slug);
  });

  console.error(`[Holafly] Country links after filter: ${links.length}`);
  return links;
}

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const allPlans = [];
  const seen = new Set();

  // Get country links from sitemap (before opening browser)
  let countryLinks = [];
  try {
    countryLinks = await getCountryLinks();
  } catch (err) {
    console.error(`[Holafly] getCountryLinks error: ${err.message}`);
  }

  if (countryLinks.length === 0) {
    console.error('[Holafly] No country links — aborting');
    await browser.close();
    return [];
  }

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // ── Step 2: scrape each country page in parallel ──────────────────────
    const sampleLimit = process.env.SCRAPE_SAMPLE ? parseInt(process.env.SCRAPE_SAMPLE) : Infinity;
    const linksToScrape = countryLinks.slice(0, sampleLimit);
    for (let i = 0; i < linksToScrape.length; i += CONCURRENCY) {
      const chunk = linksToScrape.slice(i, i + CONCURRENCY);

      await Promise.all(
        chunk.map(async (href, j) => {
          const idx = i + j + 1;
          const page = await context.newPage();
          try {
            const plans = await scrapeCountry(page, href, idx, countryLinks.length);
            for (const p of plans) {
              const key = `holafly|${p.country_code || p.country}|${p.plan_type}|${p.validity_days}|${p.price_eur}`;
              if (!seen.has(key)) { seen.add(key); allPlans.push(p); }
            }
          } finally {
            await page.close();
          }
        })
      );
    }
  } finally {
    await browser.close();
  }

  console.error(`[Holafly] Total: ${allPlans.length} plans`);
  return allPlans;
}

async function scrapeCountry(page, href, idx, total) {
  const slug = href.replace(BASE_URL + '/', '').replace(/\/$/, '');
  const countryName = slug
    .replace(/^esim-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Dismiss cookie banner if present
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")']) {
      try { await page.click(sel, { timeout: 1500 }); break; } catch (_) {}
    }

    const rawPlans = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const results = [];

      // Pattern A: "N days\t£/$/€ PRICE" (tab-separated, Holafly's main format)
      // e.g. "3 days\t£ 8.99GBP"  or  "7 days\t$ 19.99"  or  "1 day\t€ 5.99"
      const tabRegex = /(\d+)\s*days?\s*[\t ]+([£$€])\s*(\d+(?:[.,]\d+)?)/gi;
      let m;
      while ((m = tabRegex.exec(text)) !== null) {
        const price = parseFloat(m[3].replace(',', '.'));
        if (price > 0) {
          results.push({
            days: parseInt(m[1]),
            price,
            currency: m[2] === '£' ? 'GBP' : m[2] === '$' ? 'USD' : 'EUR',
          });
        }
      }

      // Pattern B: "N days … PRICE" within 80 chars (fallback)
      if (results.length === 0) {
        const fwd = /(\d+)\s*days?[\s\S]{0,80}?([£$€])\s*(\d+(?:[.,]\d+)?)/gi;
        while ((m = fwd.exec(text)) !== null) {
          const price = parseFloat(m[3].replace(',', '.'));
          if (price > 0) results.push({ days: parseInt(m[1]), price, currency: m[2] === '£' ? 'GBP' : m[2] === '$' ? 'USD' : 'EUR' });
        }
      }

      // Deduplicate by (days, price)
      const seen = new Set();
      return results.filter(r => {
        const k = `${r.days}|${r.price}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    });

    if (rawPlans.length === 0) {
      console.error(`[Holafly] [${idx}/${total}] ${countryName} — 0 plans`);
      return [];
    }

    const plans = await Promise.all(
      rawPlans.map(async (raw) => {
        const { price_eur, price_usd } = await toEurUsd(raw.price, raw.currency);
        return {
          provider: 'holafly',
          country: countryName,
          country_code: '',
          region: '',
          plan_name: `Unlimited / ${raw.days}d`,
          data_gb: null,
          plan_type: 'unlimited',
          validity_days: raw.days,
          price_eur,
          price_usd,
        };
      })
    );

    console.error(`[Holafly] [${idx}/${total}] ${countryName} — ${plans.length} plans`);
    return plans;
  } catch (err) {
    console.error(`[Holafly] [${idx}/${total}] ${countryName} error: ${err.message}`);
    return [];
  }
}

module.exports = { scrape };
