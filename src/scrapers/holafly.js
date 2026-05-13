/**
 * Holafly scraper (esim.holafly.com)
 * Strategy: DOM scraping via Playwright.
 * Holafly sells UNLIMITED data eSIMs priced by duration (7d / 15d / 30d etc.), in EUR.
 *
 * 1. Load the destination listing page.
 * 2. Collect all country page links (pattern: /esim-[country]/ or /[lang]/esim-[country]/).
 * 3. For each country page, wait for duration+price cards to render and extract them.
 * 4. Process 3 pages in parallel.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://esim.holafly.com';
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
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // ── Step 1: collect country links ──────────────────────────────────────
    console.error('[Holafly] Loading destination list...');
    const listPage = await context.newPage();
    let countryLinks = [];

    const listingPaths = ['/', '/en/', '/en/esim/', '/esim/'];
    for (const path of listingPaths) {
      try {
        await listPage.goto(`${BASE_URL}${path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await listPage.waitForTimeout(6000);

        // Wait for any destination link to appear
        try {
          await listPage.waitForSelector('a[href*="-esim"], a[href*="/esim-"]', { timeout: 10000 });
        } catch (_) { /* may not match */ }

        countryLinks = await listPage.$$eval(
          'a',
          (els, base) => {
            const valid = [];
            for (const el of els) {
              const href = (el.href || '').split('?')[0].split('#')[0];
              if (!href.startsWith(base)) continue;
              // Accept links that contain "-esim" in the slug, or "/esim-" path segment
              // Exclude top-level nav / utility pages
              if (
                href === base ||
                href === base + '/' ||
                /\/(blog|faq|about|contact|terms|privacy|support|help|login|register)\/?/.test(href)
              ) continue;
              if (
                href.includes('-esim') ||
                href.includes('/esim-') ||
                // e.g. /en/esim-france/
                /\/esim-[a-z]/.test(href.replace(base, ''))
              ) {
                valid.push(href);
              }
            }
            return [...new Set(valid)].slice(0, 250);
          },
          BASE_URL
        );

        if (countryLinks.length > 5) {
          console.error(`[Holafly] Found ${countryLinks.length} country links from ${path}`);
          break;
        }
      } catch (err) {
        console.error(`[Holafly] Listing ${path} error: ${err.message}`);
      }
    }

    await listPage.close();
    console.error(`[Holafly] Processing ${countryLinks.length} country pages...`);

    // ── Step 2: scrape each country page in parallel chunks ───────────────
    for (let i = 0; i < countryLinks.length; i += CONCURRENCY) {
      const chunk = countryLinks.slice(i, i + CONCURRENCY);

      await Promise.all(
        chunk.map(async (href) => {
          const page = await context.newPage();
          try {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 });

            // Wait for pricing to render — try several selector patterns
            const pricingSelectors = [
              '[class*="duration"]',
              '[class*="period"]',
              '[class*="price"]',
              '[class*="plan"]',
              '[class*="card"]',
              '[data-testid*="plan"]',
              '[data-testid*="duration"]',
              '[data-testid*="price"]',
            ];
            let selectorHit = false;
            for (const sel of pricingSelectors) {
              try {
                await page.waitForSelector(sel, { timeout: 5000 });
                selectorHit = true;
                break;
              } catch (_) { /* try next */ }
            }
            if (!selectorHit) {
              await page.waitForTimeout(5000);
            }

            // ── DOM extraction ───────────────────────────────────────────
            const rawPlans = await page.evaluate(() => {
              const results = [];

              // ── Strategy A: structured card elements ──────────────────
              // Holafly renders each duration option as a card/button with days + price
              const cardSelectors = [
                '[class*="duration"]',
                '[class*="period"]',
                '[class*="DurationCard"]',
                '[class*="PeriodCard"]',
                '[class*="plan-option"]',
                '[class*="PlanOption"]',
                '[class*="offer"]',
                '[data-testid*="plan"]',
                '[data-testid*="duration"]',
              ];

              const cards = [];
              for (const sel of cardSelectors) {
                cards.push(...document.querySelectorAll(sel));
              }
              const uniqueCards = [...new Set(cards)];

              for (const card of uniqueCards) {
                const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;

                // Needs a "X days/day" pattern and a price
                const daysMatch = text.match(/(\d+)\s*(?:day|days|jour|jours|día|días|Tag|Tage|giorni)/i);
                const priceMatch = text.match(/€\s*(\d+(?:[.,]\d+)?)/) ||
                                   text.match(/(\d+(?:[.,]\d+)?)\s*€/);

                if (daysMatch && priceMatch) {
                  results.push({
                    days: parseInt(daysMatch[1]),
                    price: parseFloat(priceMatch[1].replace(',', '.')),
                    source: 'card',
                  });
                }
              }

              // ── Strategy B: page-level text scan (fallback) ───────────
              if (results.length === 0) {
                const bodyText = document.body.innerText || '';

                // Pattern: "7 days ... €19" or "€19 ... 7 days" within ~80 chars
                const fwdRegex = /(\d+)\s*(?:day|days|jour|jours|día|días|Tag|Tage|giorni)[\s\S]{0,80}?€\s*(\d+(?:[.,]\d+)?)/gi;
                let m;
                while ((m = fwdRegex.exec(bodyText)) !== null) {
                  const price = parseFloat(m[2].replace(',', '.'));
                  if (price > 0) {
                    results.push({ days: parseInt(m[1]), price, source: 'regex-fwd' });
                  }
                }

                const revRegex = /€\s*(\d+(?:[.,]\d+)?)[\s\S]{0,80}?(\d+)\s*(?:day|days|jour|jours|día|días|Tag|Tage|giorni)/gi;
                while ((m = revRegex.exec(bodyText)) !== null) {
                  const price = parseFloat(m[1].replace(',', '.'));
                  if (price > 0) {
                    results.push({ days: parseInt(m[2]), price, source: 'regex-rev' });
                  }
                }
              }

              // Deduplicate by (days, price)
              const seen = new Set();
              return results.filter(({ days, price }) => {
                const key = `${days}|${price}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return days > 0 && price > 0;
              });
            });

            // Resolve country name from URL
            const slug = href.replace(/\/$/, '').split('/').pop() || '';
            // Handles patterns: esim-france, france-esim, esim-united-states
            const countryName = slug
              .replace(/^esim-/, '')
              .replace(/-esim$/, '')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());

            const plans = [];
            for (const raw of rawPlans) {
              if (!raw.price || raw.price <= 0 || !raw.days) continue;
              const { price_eur, price_usd } = await toEurUsd(raw.price, 'EUR');
              plans.push({
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
              });
            }

            const totalSoFar = i + chunk.indexOf(href) + 1;
            console.error(`[Holafly] [${totalSoFar}/${countryLinks.length}] ${countryName} — ${plans.length} plans`);

            addUnique(allPlans, seen, plans);
          } catch (err) {
            console.error(`[Holafly] Error on ${href}: ${err.message}`);
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

// ── Helpers ────────────────────────────────────────────────────────────────

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
