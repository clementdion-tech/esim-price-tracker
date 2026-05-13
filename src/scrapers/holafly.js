/**
 * Holafly scraper (esim.holafly.com)
 *
 * Strategy:
 *  1. Load /shop/ — the full destination listing page.
 *  2. Dismiss cookie banner, scroll to load all lazy country cards.
 *  3. Collect all /esim-[country]/ links (filter out regional/utility pages).
 *  4. For each country page, parse duration + price text patterns.
 *  5. Process 3 pages in parallel.
 *
 * Holafly sells UNLIMITED data plans priced by duration (1d, 3d, 5d, 7d, 10d, 15d, 30d).
 * Prices are shown in the user's currency (USD on GH Actions US servers, GBP on UK IPs).
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const SHOP_URL = 'https://esim.holafly.com/shop/all-destinations/';
const BASE_URL = 'https://esim.holafly.com';
const CONCURRENCY = 3;

// Non-plan pages to exclude (utility/nav pages, not actual eSIM destinations)
const EXCLUDED_SLUGS = new Set([
  'esim-rewards-loyalty-program',
  'esim-installation-and-activation-instructions',
  'esim-how-to-install',
  'esim-compatible-devices',
  'esim-faq',
]);

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

    // ── Step 1: get country list from /shop/ ──────────────────────────────
    console.error('[Holafly] Loading shop page...');
    const listPage = await context.newPage();
    let countryLinks = [];

    try {
      await listPage.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await listPage.waitForTimeout(3000);

      // Dismiss cookie banner
      for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("Accept all")']) {
        try { await listPage.click(sel, { timeout: 2000 }); break; } catch (_) {}
      }
      await listPage.waitForTimeout(500);

      // Scroll to trigger lazy loading of country cards
      for (let i = 0; i < 12; i++) {
        await listPage.evaluate(() => window.scrollBy(0, 600));
        await listPage.waitForTimeout(300);
      }
      await listPage.waitForTimeout(1500);

      countryLinks = await listPage.evaluate(({ base, excluded }) => {
        const links = [...new Set(
          [...document.querySelectorAll('a')]
            .map(a => a.href.split('?')[0].split('#')[0])
            .filter(h => h.startsWith(base + '/esim-'))
        )];
        return links.filter(h => {
          const slug = h.replace(base + '/', '').replace(/\/$/, '');
          return !excluded.includes(slug);
        });
      }, { base: BASE_URL, excluded: [...EXCLUDED_SLUGS] });

      console.error(`[Holafly] Found ${countryLinks.length} country links`);
    } catch (err) {
      console.error(`[Holafly] Shop page error: ${err.message}`);
    }

    await listPage.close();

    if (countryLinks.length === 0) {
      console.error('[Holafly] No country links found — aborting');
      return [];
    }

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
