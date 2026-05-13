/**
 * Shared deepSearch utility for eSIM plan extraction from arbitrary JSON blobs.
 *
 * The key fix over the original per-scraper versions:
 *   Old code: `if (obj && typeof obj === 'object' && !Array.isArray(obj))` — this prevented
 *   recursion into non-plan arrays entirely, so nested arrays of countries/pages were skipped.
 *   Fix: always recurse into array items when the array doesn't itself look like a plan list.
 */

/**
 * Parse a data string into GB (number) or null for unlimited.
 * Handles "1GB", "500MB", "2TB", "unlimited", "∞", bare numbers assumed GB.
 *
 * @param {string|number} str
 * @returns {number|null}
 */
function parseDataGb(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).toLowerCase().trim();
  if (!s || s === '0') return null;
  if (s.includes('unlimited') || s === '∞') return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(gb|mb|tb)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'gb').toLowerCase();
  if (unit === 'mb') return Math.round((n / 1024) * 100) / 100;
  if (unit === 'tb') return n * 1024;
  return n;
}

/**
 * Heuristic: does this object look like an eSIM plan?
 * Requires at least a price indicator AND (duration OR data) indicator.
 *
 * @param {object} obj
 * @returns {boolean}
 */
function looksLikePlan(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
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

/**
 * Generic plan normalizer for JSON-sourced data (not DOM-scraped data).
 * Converts raw item fields into the standard plan shape WITHOUT currency conversion
 * (call toEurUsd separately after, since page.evaluate can't be async).
 *
 * Returns null if missing required fields.
 *
 * @param {object} item   Raw plan object from JSON
 * @param {string} provider
 * @returns {object|null}  Partial plan (missing price_eur/price_usd — caller must add)
 */
function normalizePlanGeneric(item, provider) {
  if (!item || typeof item !== 'object') return null;

  const country =
    item.country ||
    item.country_name ||
    item.destination ||
    item.location ||
    item.operator?.country?.title ||
    item.countries?.[0]?.title ||
    '';

  const countryCode = (
    item.country_code ||
    item.iso_code ||
    item.iso ||
    item.code ||
    item.operator?.country?.slug ||
    ''
  ).toUpperCase();

  const region =
    item.region?.title ||
    item.region ||
    item.continent ||
    item.operator?.country?.region?.title ||
    '';

  const dataStr = String(
    item.data ?? item.allowance ?? item.data_amount ?? item.size ?? item.bandwidth ?? ''
  );
  const dataGb = parseDataGb(dataStr);
  const isUnlimited =
    dataGb === null ||
    item.unlimited ||
    item.is_unlimited ||
    String(item.data || '').toLowerCase().includes('unlimited');

  const validityDays =
    parseInt(item.day ?? item.days ?? item.validity ?? item.duration ?? item.period ?? '0') || null;

  const priceRaw = parseFloat(
    item.price ?? item.net_price ?? item.retail_price ?? item.amount ?? item.cost ?? 0
  );
  const currency = (item.currency || 'USD').toUpperCase();

  const planName =
    item.title ||
    item.name ||
    (isUnlimited ? `Unlimited / ${validityDays}d` : `${dataGb}GB / ${validityDays}d`);

  // Require at minimum: some country identifier and a positive price
  if (!country || priceRaw <= 0) return null;

  return {
    provider,
    country,
    country_code: countryCode,
    region,
    plan_name: planName,
    data_gb: isUnlimited ? null : dataGb,
    plan_type: isUnlimited ? 'unlimited' : 'data',
    validity_days: validityDays,
    // Caller is responsible for adding price_eur / price_usd via toEurUsd(priceRaw, currency)
    _priceRaw: priceRaw,
    _currency: currency,
  };
}

/**
 * Recursively search any JSON value for arrays that look like eSIM plan lists.
 *
 * Key behaviour:
 *  - If an array's first element passes looksLikePlan(), treat the whole array as plans.
 *  - Otherwise recurse into each array element (this is the fix — old code stopped here).
 *  - For plain objects always recurse into values.
 *
 * @param {*}        obj       Any JSON value
 * @param {string}   provider  Provider name tag (e.g. 'airalo')
 * @param {number}   [depth=0] Current recursion depth (internal)
 * @param {object[]} [results] Accumulator (internal)
 * @returns {object[]}  Array of partial plan objects (need price_eur/price_usd added)
 */
function deepSearchPlans(obj, provider, depth = 0, results = []) {
  if (depth > 25 || !obj) return results;

  if (Array.isArray(obj)) {
    if (obj.length === 0 || obj.length >= 2000) return results;

    const sample = obj[0];
    if (sample && typeof sample === 'object' && !Array.isArray(sample) && looksLikePlan(sample)) {
      // This array looks like a plan list — extract and stop recursing here
      const plans = obj.map((item) => normalizePlanGeneric(item, provider)).filter(Boolean);
      if (plans.length > 0) results.push(...plans);
      return results;
    }

    // Not a plan array — recurse into each element (THE FIX)
    for (const item of obj) {
      deepSearchPlans(item, provider, depth + 1, results);
    }
    return results;
  }

  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      deepSearchPlans(v, provider, depth + 1, results);
    }
  }

  return results;
}

module.exports = { deepSearchPlans, looksLikePlan, normalizePlanGeneric, parseDataGb };
