/**
 * Saily scraper (saily.com)
 *
 * Strategy:
 *  1. Warm-up: visit saily.com English homepage so Cloudflare issues a cf_clearance cookie
 *     without setting a non-English locale cookie.
 *  2. Load saily.com/en/all-destinations/ (English locale) — lists 200+ countries.
 *  3. For each country, visit saily.com/en/esim-[slug]/ (forced English locale).
 *  4. Parse plans using two layers:
 *     A. Intercept the raw SSR HTML response (page.on 'response') and parse plan cards
 *        via regex — this works even when Cloudflare slows React hydration on cloud IPs
 *        because the SSR HTML payload is sent before any JS challenge fires.
 *     B. Fallback: wait for DOM hydration and read innerText / body text.
 *  5. For unlimited plans: parse duration options from the SSR HTML <select>, then click
 *     each option to get individual prices.
 *  6. Process 3 pages in parallel.
 *
 * Why this works on cloud IPs:
 *  - Cloudflare may delay or challenge JS execution on Azure/US cloud IPs, but the SSR
 *    HTML payload is sent in full before the challenge fires.  Capturing the raw response
 *    bytes with page.on('response') gives us the rendered plan data without any JS.
 *  - The homepage warm-up acquires a cf_clearance cookie that carries over to all country
 *    pages in the same browser context, reducing the chance of a hard block.
 *  - We force the /en/ locale prefix on all pages to avoid locale-specific content
 *    (French pages say "Go" instead of "GB" and use comma decimal separators).
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const { toEurUsd } = require('../currency');

const BASE_URL = 'https://saily.com';
const ALL_DESTINATIONS = 'https://saily.com/en/all-destinations/';
const CONCURRENCY = 3;

// ─── Main export ─────────────────────────────────────────────────────────────

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const allPlans = [];
  const seen = new Set();

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'sec-ch-ua':
          '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    });

    // ── Step 0: Homepage warm-up to acquire cf_clearance cookie ────────────
    // Use the English homepage (/en/) so no French locale cookie gets set.
    console.error('[Saily] Warming up session on homepage...');
    const warmPage = await context.newPage();
    try {
      await warmPage.goto(`${BASE_URL}/en/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await warmPage.waitForTimeout(4000);
      const title = await warmPage.title();
      console.error(`[Saily] Homepage title: "${title}"`);
    } catch (err) {
      console.error(`[Saily] Homepage warm-up warning: ${err.message}`);
    } finally {
      await warmPage.close();
    }

    // ── Step 1: Get full country list from all-destinations (English) ──────
    console.error('[Saily] Loading all-destinations...');
    const listPage = await context.newPage();
    let countries = [];

    try {
      let listHtml = '';
      listPage.on('response', async (res) => {
        if (res.url().includes('/all-destinations') && res.status() === 200) {
          try { listHtml = await res.text(); } catch (_) {}
        }
      });

      await listPage.goto(ALL_DESTINATIONS, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await listPage.waitForTimeout(5000);

      countries = await listPage.evaluate((base) => {
        const results = [];
        const links = [...document.querySelectorAll('a')];
        for (const el of links) {
          const href = (el.href || '').split('?')[0].split('#')[0];
          if (!href.startsWith(base)) continue;
          // Strip any locale prefix (/fr/, /en/, /de/, etc.)
          const path = href.replace(base, '').replace(/^\/[a-z]{2}\//, '/');
          if (!path.match(/^\/esim-[a-z]/)) continue;

          // ISO code: nearest ancestor with a 2-letter uppercase data-testid
          let isoCode = '';
          let node = el;
          for (let d = 0; d < 8 && node; d++) {
            const tid = node.getAttribute('data-testid') || '';
            if (tid.match(/^[A-Z]{2}$/)) { isoCode = tid; break; }
            node = node.parentElement;
          }

          const slug = path.replace(/^\/esim-/, '').replace(/\/$/, '');
          // Only skip sub-pages (e.g. europe/special) — keep regional slugs like europe, asia
          if (slug.includes('/')) continue;

          const countryName = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          // Always use the explicit /en/ locale URL to avoid locale redirect contamination
          results.push({ slug, countryName, isoCode, englishUrl: `${base}/en/esim-${slug}/` });
        }
        const seen = new Set();
        return results.filter((c) => {
          if (seen.has(c.slug)) return false;
          seen.add(c.slug);
          return true;
        });
      }, BASE_URL);

      if (countries.length === 0 && listHtml) {
        console.error('[Saily] DOM parse failed — falling back to raw HTML country extraction');
        countries = extractCountriesFromHtml(listHtml, BASE_URL);
      }

      console.error(`[Saily] Found ${countries.length} countries`);
    } catch (err) {
      console.error(`[Saily] all-destinations error: ${err.message}`);
    }

    await listPage.close();

    if (countries.length === 0) {
      console.error('[Saily] No countries found — aborting');
      return [];
    }

    // ── Step 2: Scrape each country page ──────────────────────────────────
    const sampleLimit = process.env.SCRAPE_SAMPLE ? parseInt(process.env.SCRAPE_SAMPLE) : Infinity;
    const countriesToScrape = countries.slice(0, sampleLimit);

    for (let i = 0; i < countriesToScrape.length; i += CONCURRENCY) {
      const chunk = countriesToScrape.slice(i, i + CONCURRENCY);

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

// ─── Per-country scraper ──────────────────────────────────────────────────────

async function scrapeCountry(page, country, idx, total) {
  try {
    // Capture the raw SSR HTML response — works even when CF delays JS execution
    // because the HTML body is sent before any JS challenge fires.
    let rawHtml = '';
    page.on('response', async (res) => {
      const url = res.url();
      const status = res.status();
      // Match the slug anywhere in the URL path (handles locale redirects like /en/, /fr/)
      if (
        status === 200 &&
        url.includes('saily.com') &&
        url.includes(`esim-${country.slug}`) &&
        !url.includes('?')
      ) {
        try { rawHtml = await res.text(); } catch (_) {}
      }
    });

    await page.goto(country.englishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for plan cards or timeout — CF may delay hydration on cloud IPs
    await page.waitForSelector('[data-testid^="destination-hero-plan-card-"]', { timeout: 12000 })
      .catch(() => {});
    await page.waitForTimeout(4000);

    // ── Strategy A: parse raw SSR HTML (works when JS hydration is blocked) ──
    let dataPlans = rawHtml ? extractPlansFromHtml(rawHtml) : [];

    // ── Strategy B: DOM innerText extraction (original approach, works locally) ──
    if (dataPlans.filter((p) => !p.isUnlimited).length === 0) {
      const domPlans = await page.evaluate(() => {
        const cards = [
          ...document.querySelectorAll('[data-testid^="destination-hero-plan-card-"]'),
        ].filter((el) => el.getAttribute('data-testid') !== 'destination-hero-plan-card-999');

        return cards.map((card) => {
          const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
          const gbMatch = text.match(/(\d+(?:\.\d+)?)\s*G(?:B|[Oo])/i);
          const daysMatch = text.match(/(\d+)\s*(?:days?|jours?)/i);
          const priceMatch =
            text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) ||
            text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
          if (!gbMatch || !priceMatch) return null;
          return {
            dataGb: parseFloat(gbMatch[1]),
            validityDays: daysMatch ? parseInt(daysMatch[1]) : null,
            price: parseFloat(priceMatch[1].replace(',', '.')),
            currency: 'USD',
            isUnlimited: false,
          };
        }).filter(Boolean);
      });
      dataPlans.push(...domPlans);
    }

    // ── Strategy C: body-text regex fallback ─────────────────────────────────
    if (dataPlans.filter((p) => !p.isUnlimited).length === 0) {
      const bodyPlans = await page.evaluate(() => {
        const text = document.body.innerText || document.body.textContent || '';
        const results = [];
        const re =
          /(\d+(?:\.\d+)?)\s*G(?:B|[Oo])[\s\S]{0,80}?(\d+)\s*(?:days?|jours?)[\s\S]{0,50}?(?:US)?\$\s*(\d+(?:[.,]\d+)?)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const price = parseFloat(m[3].replace(',', '.'));
          if (price > 0)
            results.push({
              dataGb: parseFloat(m[1]),
              validityDays: parseInt(m[2]),
              price,
              currency: 'USD',
              isUnlimited: false,
            });
        }
        const seen = new Set();
        return results.filter((r) => {
          const k = `${r.dataGb}|${r.validityDays}|${r.price}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      });
      dataPlans.push(...bodyPlans);
    }

    // ── Unlimited plans ───────────────────────────────────────────────────────
    const unlimitedPlans = await scrapeUnlimitedPlans(page, rawHtml);

    // Merge, dedup, normalise
    const allRaw = deduplicateRaw([
      ...dataPlans.filter((p) => !p.isUnlimited),
      ...unlimitedPlans,
    ]);

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

// ─── Unlimited plan scraper ───────────────────────────────────────────────────

async function scrapeUnlimitedPlans(page, rawHtml) {
  const plans = [];
  try {
    // Extract durations and SSR-default price from the raw HTML <select> in card-999
    const ssrDurations = [];
    if (rawHtml) {
      const card999Idx = rawHtml.indexOf('destination-hero-plan-card-999');
      if (card999Idx !== -1) {
        const card999Html = rawHtml.substring(card999Idx, card999Idx + 5000);
        // <option data-testid="uuid" value="uuid">N days</option>
        const optRe = /<option[^>]*data-testid="([^"]+)"[^>]*>(\d+)\s*(?:days?|jours?)/gi;
        let m;
        while ((m = optRe.exec(card999Html)) !== null) {
          ssrDurations.push({ testid: m[1], days: parseInt(m[2]) });
        }
        // SSR-rendered price (for the currently selected option)
        const priceMatch =
          card999Html.match(/pricing-card-original-price[^>]*>US\$([\d.,]+)/) ||
          card999Html.match(/pricing-card-original-price[^>]*>\$([\d.,]+)/);
        const selectedOptMatch = card999Html.match(/<option[^>]+selected[^>]*>(\d+)\s*(?:days?|jours?)/i);
        if (priceMatch && selectedOptMatch) {
          plans.push({
            dataGb: null,
            validityDays: parseInt(selectedOptMatch[1]),
            price: parseFloat(priceMatch[1].replace(',', '.')),
            currency: 'USD',
            isUnlimited: true,
            _ssrDefault: true,
          });
        }
      }
    }

    // Use DOM to click each duration option and read the updated price
    const unlimCard = await page.$('[data-testid="destination-hero-plan-card-999"]');
    if (!unlimCard) return plans;

    let durationsToClick = ssrDurations;
    if (durationsToClick.length === 0) {
      durationsToClick = await page.evaluate(() => {
        const sel = document.querySelector(
          '[data-testid="unlimited-plan-duration-select"] select, [data-testid="destination-hero-plan-card-999"] select'
        );
        if (!sel) return [];
        return [...sel.options].map((o) => ({
          testid: o.getAttribute('data-testid') || o.value,
          days: parseInt((o.textContent.match(/\d+/) || ['0'])[0]),
        })).filter((o) => o.days > 0);
      });
    }

    const alreadyHaveDays = new Set(plans.map((p) => p.validityDays));

    for (const opt of durationsToClick) {
      if (alreadyHaveDays.has(opt.days)) continue;
      try {
        await page.evaluate((tid) => {
          const sel = document.querySelector(
            '[data-testid="unlimited-plan-duration-select"] select, [data-testid="destination-hero-plan-card-999"] select'
          );
          if (!sel) return;
          for (const o of sel.options) {
            if (o.getAttribute('data-testid') === tid || o.value === tid) {
              sel.value = o.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }, opt.testid);
        await page.waitForTimeout(500);

        const price = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="destination-hero-plan-card-999"]');
          if (!card) return null;
          const text = card.innerText || '';
          const m = text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) || text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
          return m ? parseFloat(m[1].replace(',', '.')) : null;
        });

        if (price && price > 0) {
          plans.push({ dataGb: null, validityDays: opt.days, price, currency: 'USD', isUnlimited: true });
          alreadyHaveDays.add(opt.days);
        }
      } catch (_) {}
    }

    // Final fallback: just read whatever is shown on the card
    if (plans.length === 0) {
      const text = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="destination-hero-plan-card-999"]');
        return card ? (card.innerText || '').replace(/\s+/g, ' ') : '';
      });
      const priceMatch =
        text.match(/US\$\s*(\d+(?:[.,]\d+)?)/) || text.match(/\$\s*(\d+(?:[.,]\d+)?)/);
      const daysMatch = text.match(/(\d+)\s*(?:days?|jours?)/i);
      if (priceMatch && daysMatch) {
        plans.push({
          dataGb: null,
          validityDays: parseInt(daysMatch[1]),
          price: parseFloat(priceMatch[1].replace(',', '.')),
          currency: 'USD',
          isUnlimited: true,
        });
      }
    }
  } catch (_) {}
  return plans;
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────

/**
 * Parse plan cards from raw SSR HTML.
 *
 * English locale: "1 GB", "7 days", "US$3.99"
 * French locale:  "1 Go", "7 jours", "US$3,99" (comma decimal)
 * Both are handled.
 */
function extractPlansFromHtml(html) {
  const plans = [];
  if (!html) return plans;

  const boundaries = [];
  const re = /data-testid="destination-hero-plan-card-(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    boundaries.push({ cardNum: m[1], idx: m.index });
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].idx;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].idx : start + 4000;
    const cardNum = boundaries[i].cardNum;
    if (cardNum === '999') continue;

    const cardHtml = html.substring(start, Math.min(end, start + 4000));

    // "1 GB" (English) or "1 Go" (French)
    const gbMatch = cardHtml.match(/([\d.]+)\s*G(?:B|[Oo])/i);
    const daysMatch = cardHtml.match(/(\d+)\s*(?:days?|jours?)/i);
    // Price in data-testid="pricing-card-original-price">US$N.NN or US$N,NN
    const priceMatch =
      cardHtml.match(/pricing-card-original-price[^>]*>US\$([\d.,]+)/) ||
      cardHtml.match(/pricing-card-original-price[^>]*>\$([\d.,]+)/) ||
      cardHtml.match(/US\$([\d.,]+)/);

    if (!gbMatch || !priceMatch) continue;

    const price = parseFloat(priceMatch[1].replace(',', '.'));
    if (!price || price <= 0) continue;

    plans.push({
      dataGb: parseFloat(gbMatch[1]),
      validityDays: daysMatch ? parseInt(daysMatch[1]) : null,
      price,
      currency: 'USD',
      isUnlimited: false,
    });
  }

  return plans;
}

/**
 * Parse country links from raw all-destinations HTML (fallback when DOM returns nothing).
 */
function extractCountriesFromHtml(html, base) {
  const countries = [];
  const seen = new Set();

  // Try with ISO code data-testid first
  const re = /href="(?:\/[a-z]{2})?(\/esim-([a-z][a-z0-9-]+)\/)"[^>]*data-testid="([A-Z]{2})"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[2];
    const isoCode = m[3];
    if (seen.has(slug)) continue;
    if (
      /^(europe|asia|oceania|africa|americas|north-america|latin-america|caribbean|middle-east|global)/.test(slug)
    ) continue;
    seen.add(slug);
    countries.push({
      slug,
      countryName: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      isoCode,
      englishUrl: `${base}/en/esim-${slug}/`,
    });
  }

  // Second pass without ISO code requirement
  if (countries.length === 0) {
    const re2 = /href="(?:\/[a-z]{2})?(\/esim-([a-z][a-z0-9-]+)\/)">/g;
    while ((m = re2.exec(html)) !== null) {
      const slug = m[2];
      if (seen.has(slug)) continue;
      if (
        /^(europe|asia|oceania|africa|americas|north-america|latin-america|caribbean|middle-east|global)/.test(slug)
      ) continue;
      seen.add(slug);
      countries.push({
        slug,
        countryName: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        isoCode: '',
        englishUrl: `${base}/en/esim-${slug}/`,
      });
    }
  }
  return countries;
}

/**
 * Deduplicate raw plan objects by (dataGb, validityDays).
 */
function deduplicateRaw(plans) {
  const seen = new Set();
  return plans.filter((p) => {
    const k = `${p.dataGb}|${p.validityDays}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { scrape };
