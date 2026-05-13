/**
 * Saily scraper (saily.com)
 *
 * Strategy:
 *  1. Load saily.com/fr/all-destinations/ — lists 200+ countries with ISO codes.
 *  2. For each country, visit saily.com/esim-[slug]/ (English page).
 *  3. Parse plan cards via data-testid="destination-hero-plan-card-*".
 *  4. For unlimited plans, iterate duration options to capture all prices.
 *  5. Process 3 pages in parallel.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://saily.com';
const ALL_DESTINATIONS = 'https://saily.com/fr/all-destinations/';
const CONCURRENCY = 3;

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

    // ── Step 1: get full country list from all-destinations ────────────────
    console.error('[Saily] Loading all-destinations...');
    const listPage = await context.newPage();
    let countries = [];

    try {
      await listPage.goto(ALL_DESTINATIONS, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await listPage.waitForTimeout(5000);

      countries = await listPage.evaluate((base) => {
        const results = [];
        const links = [...document.querySelectorAll('a')];
        for (const el of links) {
          const href = (el.href || '').split('?')[0].split('#')[0];
          // Saily country links: saily.com/fr/esim-[country]/ or saily.com/esim-[country]/
          if (!href.startsWith(base)) continue;
          const path = href.replace(base, '').replace(/^\/[a-z]{2}\//, '/'); // strip /fr/ locale
          if (!path.match(/^\/esim-[a-z]/)) continue;

          // ISO code is in the nearest ancestor/sibling [data-testid] with a 2-letter value
          let isoCode = '';
          let node = el;
          for (let d = 0; d < 8 && node; d++) {
            const tid = node.getAttribute('data-testid') || '';
            if (tid.match(/^[A-Z]{2}$/)) { isoCode = tid; break; }
            node = node.parentElement;
          }

          const slug = path.replace(/^\/esim-/, '').replace(/\/$/, '');
          const countryName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

          results.push({ slug, countryName, isoCode, englishUrl: `${base}/esim-${slug}/` });
        }
        // Deduplicate by slug
        const seen = new Set();
        return results.filter(c => { if (seen.has(c.slug)) return false; seen.add(c.slug); return true; });
      }, BASE_URL);

      console.error(`[Saily] Found ${countries.length} countries`);
    } catch (err) {
      console.error(`[Saily] all-destinations error: ${err.message}`);
    }

    await listPage.close();

    if (countries.length === 0) {
      console.error('[Saily] No countries found — aborting');
      return [];
    }

    // ── Step 2: scrape each country page ──────────────────────────────────
    for (let i = 0; i < countries.length; i += CONCURRENCY) {
      const chunk = countries.slice(i, i + CONCURRENCY);

      await Promise.all(
        chunk.map(async (country, j) => {
          const idx = i + j + 1;
          const page = await context.newPage();
          try {
            const plans = await scrapeCountry(page, country, idx, countries.length);
            for (const p of plans) {
              const key = `saily|${p.country_code || p.country}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
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

  console.error(`[Saily] Total: ${allPlans.length} plans`);
  return allPlans;
}

async function scrapeCountry(page, country, idx, total) {
  try {
    await page.goto(country.englishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait until plan cards exist AND have actual content (React hydration takes a moment)
    try {
      await page.waitForFunction(() => {
        const card = document.querySelector('[data-testid^="destination-hero-plan-card-"]');
        return card && (card.innerText || '').includes('GB');
      }, { timeout: 15000 });
    } catch {
      console.error(`[Saily] [${idx}/${total}] ${country.countryName} — no plan content`);
      return [];
    }

    // Extract data plans (testid = card-1, card-3, card-5, card-10, card-20 etc.)
    const dataPlans = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid^="destination-hero-plan-card-"]')]
        .filter(el => {
          const tid = el.getAttribute('data-testid') || '';
          return tid !== 'destination-hero-plan-card-999'; // unlimited handled separately
        });

      return cards.map(card => {
        const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
        const gbMatch = text.match(/(\d+(?:\.\d+)?)\s*GB/i);
        const daysMatch = text.match(/(\d+)\s*days?/i);
        const priceMatch = text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) || text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
        if (!gbMatch || !priceMatch) return null;
        return {
          dataGb: parseFloat(gbMatch[1]),
          validityDays: daysMatch ? parseInt(daysMatch[1]) : null,
          price: parseFloat(priceMatch[1].replace(',', '.')),
          currency: 'USD',
        };
      }).filter(Boolean);
    });

    // Extract unlimited plan durations by clicking each option
    const unlimitedPlans = await scrapeUnlimitedPlans(page);

    const allRaw = [...dataPlans, ...unlimitedPlans];
    if (allRaw.length === 0) {
      console.error(`[Saily] [${idx}/${total}] ${country.countryName} — 0 plans`);
      return [];
    }

    const plans = await Promise.all(
      allRaw.map(async (raw) => {
        const { price_eur, price_usd } = await toEurUsd(raw.price, raw.currency);
        return {
          provider: 'saily',
          country: country.countryName,
          country_code: country.isoCode,
          region: '',
          plan_name: `${raw.dataGb === null ? 'Unlimited' : raw.dataGb + 'GB'} / ${raw.validityDays}d`,
          data_gb: raw.dataGb,
          plan_type: raw.dataGb === null ? 'unlimited' : 'data',
          validity_days: raw.validityDays,
          price_eur,
          price_usd,
        };
      })
    );

    console.error(`[Saily] [${idx}/${total}] ${country.countryName} — ${plans.length} plans`);
    return plans;
  } catch (err) {
    console.error(`[Saily] [${idx}/${total}] ${country.countryName} error: ${err.message}`);
    return [];
  }
}

async function scrapeUnlimitedPlans(page) {
  const plans = [];
  try {
    const unlimCard = await page.$('[data-testid="destination-hero-plan-card-999"]');
    if (!unlimCard) return plans;

    // Get all duration options
    const options = await page.$$('[data-testid="unlimited-plan-duration-select"] [role="option"], [data-testid="unlimited-plan-duration-select"] option');
    const optionIds = await page.evaluate(() => {
      // Get the sibling radio/button options for duration selection
      const sel = document.querySelector('[data-testid="unlimited-plan-duration-select"]');
      if (!sel) return [];
      const items = [...sel.querySelectorAll('[data-testid]')];
      return items.map(el => ({ testid: el.getAttribute('data-testid'), text: el.innerText.trim() }));
    });

    if (optionIds.length === 0) {
      // Just read the current price
      const text = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="destination-hero-plan-card-999"]');
        return card ? (card.innerText || '').replace(/\s+/g, ' ') : '';
      });
      const priceMatch = text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) || text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
      const daysMatch = text.match(/(\d+)\s*days?/i);
      if (priceMatch && daysMatch) {
        plans.push({ dataGb: null, validityDays: parseInt(daysMatch[1]), price: parseFloat(priceMatch[1]), currency: 'USD' });
      }
      return plans;
    }

    // Click each option and read price
    for (const opt of optionIds) {
      try {
        const daysMatch = opt.text.match(/(\d+)/);
        if (!daysMatch) continue;
        await page.click(`[data-testid="${opt.testid}"]`);
        await page.waitForTimeout(300);
        const price = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="destination-hero-plan-card-999"]');
          if (!card) return null;
          const text = card.innerText || '';
          const m = text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) || text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
          return m ? parseFloat(m[1].replace(',', '.')) : null;
        });
        if (price && price > 0) {
          plans.push({ dataGb: null, validityDays: parseInt(daysMatch[1]), price, currency: 'USD' });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return plans;
}

module.exports = { scrape };
