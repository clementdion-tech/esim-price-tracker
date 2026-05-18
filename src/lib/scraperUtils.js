/**
 * Shared scraper utilities — imported by airalo.js, saily.js, holafly.js.
 *
 * Extracted to avoid copy-paste across scrapers:
 *   - parseDataGb     — "5GB" / "500MB" → float GB
 *   - addUnique       — deduplicates plans by composite key
 *   - buildPlan       — converts raw price + constructs normalised plan object
 *   - launchBrowser   — launches Playwright chromium with standard cloud-safe args
 *   - autoScroll      — scrolls page to bottom to trigger lazy loading
 */

const { toEurUsd } = require('../currency');

// ─── parseDataGb ─────────────────────────────────────────────────────────────

/**
 * Parse a human-readable data string to a float GB value.
 *   "5GB"    → 5
 *   "500MB"  → 0.5 (rounded to 3 decimal places)
 *   "1.5 GB" → 1.5
 *   "Unlimited" → null
 * Returns null for anything that cannot be parsed or is clearly unlimited.
 */
function parseDataGb(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/unlimited/i.test(s)) return null;

  const mb = s.match(/(\d+(?:\.\d+)?)\s*MB/i);
  if (mb) return Math.round((parseFloat(mb[1]) / 1024) * 1000) / 1000;

  const gb = s.match(/(\d+(?:\.\d+)?)\s*G[Bb]/i);
  if (gb) return parseFloat(gb[1]);

  return null;
}

// ─── addUnique ────────────────────────────────────────────────────────────────

/**
 * Push plans into allPlans only if their composite key is not already in seen.
 * Key format: provider|country_code_or_country|data_gb|validity_days|price_eur
 *
 * Mutates allPlans and seen in place.
 */
function addUnique(allPlans, seen, plans) {
  for (const p of plans) {
    const key = `${p.provider}|${p.country_code || p.country}|${p.data_gb}|${p.validity_days}|${p.price_eur}`;
    if (!seen.has(key)) {
      seen.add(key);
      allPlans.push(p);
    }
  }
}

// ─── buildPlan ────────────────────────────────────────────────────────────────

/**
 * Convert a raw scraped plan record into a normalised plan object.
 *
 * @param {object} raw
 * @param {string}  raw.provider       — 'airalo' | 'saily' | 'holafly' | 'kolet'
 * @param {string}  raw.country        — display name, e.g. "France"
 * @param {string}  raw.country_code   — ISO-2 or provider code, e.g. "FR"
 * @param {string}  raw.region         — '' for country plans, region name otherwise
 * @param {number|null} raw.dataGb     — GB as float, or null for unlimited
 * @param {number}  raw.validityDays   — plan duration
 * @param {number}  raw.price          — price in raw.currency
 * @param {string}  raw.currency       — 'USD' | 'EUR' | 'GBP'
 * @param {string}  [raw.planName]     — override auto-generated plan_name
 * @param {boolean} [raw.isRegional]   — true for regional/multi-country bundles
 * @param {string}  [raw.planType]    — override plan_type (e.g. 'voice_data', 'subscription')
 *
 * @returns {Promise<object>} Normalised plan object with price_eur and price_usd.
 */
async function buildPlan(raw) {
  const { price_eur, price_usd } = await toEurUsd(raw.price, raw.currency);

  const dataGb = raw.dataGb;
  const planName =
    raw.planName ||
    (dataGb === null ? 'Unlimited' : `${dataGb}GB`) + ` / ${raw.validityDays}d`;

  return {
    provider: raw.provider,
    country: raw.country,
    country_code: raw.country_code || '',
    region: raw.region || '',
    plan_name: planName,
    data_gb: dataGb,
    plan_type: raw.planType || (dataGb === null ? 'unlimited' : 'data'),
    is_regional: raw.isRegional || false,
    validity_days: raw.validityDays,
    price_eur,
    price_usd,
  };
}

// ─── launchBrowser ───────────────────────────────────────────────────────────

/**
 * Launch a Playwright chromium instance with the standard cloud-safe args.
 *
 * @param {object} chromiumModule  — the `chromium` export from 'playwright' or
 *                                   'playwright-extra' (already .use(stealth())'d
 *                                   if needed — caller is responsible).
 * @param {string[]} [extraArgs]   — additional CLI flags appended after the
 *                                   standard set (e.g. ['--disable-blink-features=AutomationControlled']).
 * @returns {Promise<Browser>}
 */
async function launchBrowser(chromiumModule, extraArgs = []) {
  return chromiumModule.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...extraArgs],
  });
}

// ─── autoScroll ──────────────────────────────────────────────────────────────

/**
 * Scroll the page to the bottom in increments to trigger lazy-loaded content.
 * Waits 200 ms between each step.
 *
 * @param {Page} page — Playwright Page object
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const distance = 300;
      const delay = 200;
      let totalScrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalScrolled += distance;
        if (totalScrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, delay);
    });
  });
}

// ─── roundToStandardGb ───────────────────────────────────────────────────────

/**
 * Round a GB value to the nearest standard plan size.
 * Used by kolet.js at scrape time and by compare.js for display normalisation.
 *   e.g. 4.88 → 5, 0.98 → 1, 9.77 → 10
 * Returns null when gb is null or undefined (unlimited plans).
 */
function roundToStandardGb(gb) {
  if (gb === null || gb === undefined) return null;
  const standards = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 100];
  return standards.reduce((prev, curr) =>
    Math.abs(curr - gb) < Math.abs(prev - gb) ? curr : prev
  );
}

module.exports = { parseDataGb, addUnique, buildPlan, launchBrowser, autoScroll, roundToStandardGb };
