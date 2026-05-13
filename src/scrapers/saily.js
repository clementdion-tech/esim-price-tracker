/**
 * Saily scraper (saily.com)
 * Strategy: DOM scraping via Playwright.
 * 1. Load /store (destination listing page) with domcontentloaded + explicit wait.
 * 2. Extract all country page links.
 * 3. Visit each country page and parse plan cards from the rendered DOM.
 * 4. Process up to 3 country pages in parallel.
 */
const { chromium } = require('playwright');
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://saily.com';
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
    console.error('[Saily] Loading destination list...');
    const listPage = await context.newPage();

    let countryLinks = [];

    // Try multiple listing entry-points; stop at the first that yields links
    const listingPaths = ['/store', '/', '/esim', '/destinations'];
    for (const path of listingPaths) {
      try {
        await listPage.goto(`${BASE_URL}${path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        // Give React time to hydrate
        await listPage.waitForTimeout(6000);

        // Try waiting for any anchor that looks like a country destination
        try {
          await listPage.waitForSelector('a[href*="/store/"], a[href*="-esim"], a[href*="/esim/"]', {
            timeout: 10000,
          });
        } catch (_) { /* selector may not exist on this path */ }

        countryLinks = await listPage.$$eval(
          'a',
          (els, base) => {
            const valid = [];
            for (const el of els) {
              const href = el.href || '';
              if (!href.startsWith(base)) continue;
              const path = href.replace(base, '').split('?')[0].split('#')[0];
              // Must be a meaningful sub-path, not root, not top-level nav links
              if (
                path.length < 4 ||
                path === '/' ||
                /^\/(store|esim|destinations|blog|faq|about|contact|terms|privacy|support|help)\/?$/.test(path)
              ) continue;
              // Accept paths that look like /store/country-esim or /esim-country or /[country]
              if (
                href.includes('/store/') ||
                href.includes('-esim') ||
                href.includes('/esim-') ||
                /\/[a-z]{2,}\/?$/.test(path)
              ) {
                valid.push(href.split('?')[0].split('#')[0]);
              }
            }
            return [...new Set(valid)].slice(0, 250);
          },
          BASE_URL
        );

        if (countryLinks.length > 5) {
          console.error(`[Saily] Found ${countryLinks.length} country links from ${path}`);
          break;
        }
      } catch (err) {
        console.error(`[Saily] Listing ${path} error: ${err.message}`);
      }
    }

    await listPage.close();
    console.error(`[Saily] Processing ${countryLinks.length} country pages...`);

    // ── Step 2: scrape each country page in parallel chunks ───────────────
    for (let i = 0; i < countryLinks.length; i += CONCURRENCY) {
      const chunk = countryLinks.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (href) => {
          const page = await context.newPage();
          try {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 });

            // Wait for plan cards to appear — try several selector patterns
            const planSelectors = [
              '[data-testid*="package"]',
              '[data-testid*="plan"]',
              '[data-testid*="card"]',
              '[class*="package"]',
              '[class*="plan-card"]',
              '[class*="PlanCard"]',
              '[class*="PackageCard"]',
              '[class*="offer"]',
              // generic: any element containing "GB" and a price symbol nearby
            ];
            let selectorHit = false;
            for (const sel of planSelectors) {
              try {
                await page.waitForSelector(sel, { timeout: 5000 });
                selectorHit = true;
                break;
              } catch (_) { /* try next */ }
            }
            if (!selectorHit) {
              // Fall back to a plain wait; content may still be there
              await page.waitForTimeout(5000);
            }

            // Extract plan data from the rendered DOM
            const rawPlans = await page.evaluate(() => {
              const results = [];

              // ── Strategy A: structured card elements ──────────────────
              // Look for containers that hold a GB amount, validity, and price together
              const cardCandidates = [
                ...document.querySelectorAll('[data-testid*="package"], [data-testid*="plan"], [data-testid*="card"]'),
                ...document.querySelectorAll('[class*="package"], [class*="PackageCard"], [class*="PlanCard"], [class*="plan-card"]'),
                ...document.querySelectorAll('[class*="offer-card"], [class*="OfferCard"], [class*="data-plan"]'),
              ];
              // Deduplicate by reference
              const unique = [...new Set(cardCandidates)];

              for (const card of unique) {
                const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;

                // Need both a data marker and a price
                const dataMatch = text.match(/(\d+(?:\.\d+)?)\s*GB/i) ||
                                  text.match(/\b(unlimited|∞)\b/i);
                const priceMatch = text.match(/[\$€£]\s*(\d+(?:[.,]\d+)?)/) ||
                                   text.match(/(\d+(?:[.,]\d+)?)\s*[\$€£]/);
                const daysMatch = text.match(/(\d+)\s*(?:day|days|Day|Days)/);

                if ((dataMatch || text.toLowerCase().includes('unlimited')) && priceMatch) {
                  const dataStr = dataMatch ? dataMatch[0] : 'Unlimited';
                  const priceStr = priceMatch[1].replace(',', '.');
                  const daysStr = daysMatch ? daysMatch[1] : null;
                  // Determine currency symbol used
                  const currencySymbol = (priceMatch[0].includes('€') ? 'EUR' : 'USD');
                  results.push({
                    dataStr,
                    price: parseFloat(priceStr),
                    days: daysStr ? parseInt(daysStr) : null,
                    currency: currencySymbol,
                    source: 'card',
                  });
                }
              }

              // ── Strategy B: page-text regex scan (fallback) ───────────
              if (results.length === 0) {
                const bodyText = document.body.innerText || '';
                // Match patterns like:  1 GB  7 Days  $4.99
                // or: $4.99  1GB  7 days
                const lineRegex =
                  /(\d+(?:\.\d+)?)\s*GB[\s\S]{0,60}?(\d+)\s*(?:day|days)[\s\S]{0,30}?[\$€£]\s*(\d+(?:[.,]\d+)?)/gi;
                let m;
                while ((m = lineRegex.exec(bodyText)) !== null) {
                  results.push({
                    dataStr: m[1] + 'GB',
                    days: parseInt(m[2]),
                    price: parseFloat(m[3].replace(',', '.')),
                    currency: m[0].includes('€') ? 'EUR' : 'USD',
                    source: 'regex',
                  });
                }
                // Unlimited pattern
                const unlimRegex =
                  /unlimited[\s\S]{0,60}?(\d+)\s*(?:day|days)[\s\S]{0,30}?[\$€£]\s*(\d+(?:[.,]\d+)?)/gi;
                while ((m = unlimRegex.exec(bodyText)) !== null) {
                  results.push({
                    dataStr: 'Unlimited',
                    days: parseInt(m[1]),
                    price: parseFloat(m[2].replace(',', '.')),
                    currency: m[0].includes('€') ? 'EUR' : 'USD',
                    source: 'regex-unlimited',
                  });
                }
              }

              return results;
            });

            // Resolve country name from URL slug
            const slug = href.replace(/\/$/, '').split('/').pop() || '';
            const countryName = slug
              .replace(/-esim.*$/, '')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());

            const plans = [];

            for (const raw of rawPlans) {
              if (!raw.price || raw.price <= 0) continue;

              const dataGb = parseDataGb(raw.dataStr);
              const validityDays = raw.days || null;
              const { price_eur, price_usd } = await toEurUsd(raw.price, raw.currency || 'USD');

              plans.push({
                provider: 'saily',
                country: countryName,
                country_code: '',
                region: '',
                plan_name: `${dataGb === null ? 'Unlimited' : dataGb + 'GB'} / ${validityDays ? validityDays + 'd' : '?'}`,
                data_gb: dataGb,
                plan_type: dataGb === null ? 'unlimited' : 'data',
                validity_days: validityDays,
                price_eur,
                price_usd,
              });
            }

            const totalSoFar = i + chunk.indexOf(href) + 1;
            console.error(`[Saily] [${totalSoFar}/${countryLinks.length}] ${countryName} — ${plans.length} plans`);

            addUnique(allPlans, seen, plans);
          } catch (err) {
            console.error(`[Saily] Error on ${href}: ${err.message}`);
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

// ── Helpers ────────────────────────────────────────────────────────────────

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
