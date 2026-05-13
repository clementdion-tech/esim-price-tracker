/**
 * Compares two sets of plans (previous vs fresh) and detects:
 * - Price changes for competitors (not Kolet)
 * - New countries added by competitors
 * - Plans added or removed
 */

const { COUNTRY_ISO2 } = require('./lib/countryData');
const { isCityEntry, normalizeCountryName, canonicalName } = require('./lib/utils');

const COMPETITOR_PROVIDERS = ['airalo', 'saily', 'holafly'];

function compare(previousPlans, freshPlans) {
  const priceChanges = [];
  const newCountries = [];
  const addedPlans = [];
  const removedPlans = [];

  const prevMap = buildMap(previousPlans);
  const freshMap = buildMap(freshPlans);

  // Countries per provider in previous data
  const prevCountries = buildCountrySet(previousPlans);
  const freshCountries = buildCountrySet(freshPlans);

  // Detect price changes and removed plans (only for competitors)
  for (const [key, prev] of prevMap.entries()) {
    if (!COMPETITOR_PROVIDERS.includes(prev.provider)) continue;

    const fresh = freshMap.get(key);
    if (!fresh) {
      removedPlans.push({ ...prev, detected_at: new Date().toISOString() });
      continue;
    }

    const eurDiff = Math.abs(fresh.price_eur - prev.price_eur);
    const usdDiff = Math.abs(fresh.price_usd - prev.price_usd);

    if (eurDiff >= 0.01 || usdDiff >= 0.01) {
      const changePercent = prev.price_eur > 0
        ? Math.round(((fresh.price_eur - prev.price_eur) / prev.price_eur) * 10000) / 100
        : 0;

      priceChanges.push({
        detected_at: new Date().toISOString(),
        provider: prev.provider,
        country: prev.country,
        country_code: prev.country_code,
        plan_name: prev.plan_name,
        data_gb: prev.data_gb,
        plan_type: prev.plan_type,
        validity_days: prev.validity_days,
        old_price_eur: prev.price_eur,
        new_price_eur: fresh.price_eur,
        old_price_usd: prev.price_usd,
        new_price_usd: fresh.price_usd,
        change_percent: changePercent,
        direction: fresh.price_eur > prev.price_eur ? 'increase' : 'decrease',
      });
    }
  }

  // Detect added plans (only for competitors)
  for (const [key, fresh] of freshMap.entries()) {
    if (!COMPETITOR_PROVIDERS.includes(fresh.provider)) continue;
    if (!prevMap.has(key)) {
      addedPlans.push({ ...fresh, detected_at: new Date().toISOString() });
    }
  }

  // Detect new countries per competitor
  for (const provider of COMPETITOR_PROVIDERS) {
    const prevSet = prevCountries.get(provider) || new Set();
    const freshSet = freshCountries.get(provider) || new Set();

    for (const countryKey of freshSet) {
      if (!prevSet.has(countryKey) && prevSet.size > 0) {
        // Find a plan to get display name, code and region
        const sample = freshPlans.find(
          (p) => p.provider === provider && (p.country || '').toLowerCase().trim() === countryKey
        );
        newCountries.push({
          detected_at: new Date().toISOString(),
          provider,
          country: sample?.country || countryKey,
          country_code: sample?.country_code || '',
          region: sample?.region || '',
        });
      }
    }
  }

  return { priceChanges, newCountries, addedPlans, removedPlans };
}

/**
 * Build a lookup map keyed by provider|country_code|plan_type|data_gb|validity_days
 */
function buildMap(plans) {
  const map = new Map();
  for (const plan of plans) {
    const key = planKey(plan);
    // If duplicate key, keep the cheapest (dedup)
    if (!map.has(key) || plan.price_eur < map.get(key).price_eur) {
      map.set(key, plan);
    }
  }
  return map;
}

function planKey(plan) {
  const dataGb = plan.data_gb === null ? 'unlimited' : String(plan.data_gb);
  const days = normalizeDays(plan.validity_days);
  return `${plan.provider}|${(plan.country || '').toLowerCase().trim()}|${plan.plan_type}|${dataGb}|${days}`;
}

function normalizeDays(days) {
  if (!days) return '0';
  const d = parseInt(days);
  if (d >= 28 && d <= 31) return '30';
  if (d >= 7 && d <= 8) return '7';
  if (d >= 14 && d <= 16) return '15';
  return String(d);
}

function buildCountrySet(plans) {
  const map = new Map();
  for (const plan of plans) {
    if (!map.has(plan.provider)) map.set(plan.provider, new Set());
    const code = plan.country ? plan.country.toLowerCase().trim() : '';
    if (code) map.get(plan.provider).add(code);
  }
  return map;
}

/**
 * Return the best available ISO-2 country code from a set of plans for the same country.
 * Preference order: COUNTRY_ISO2 override > 2-letter raw code > empty.
 */
function bestCountryCode(plans, canonical) {
  // 1. Try override map first (keyed on canonical display name)
  const override = COUNTRY_ISO2[(canonical || '').toLowerCase()];
  if (override) return override;
  // 2. Try proper 2-letter ISO code from any provider's raw data
  for (const p of plans) {
    if (p.country_code && p.country_code.length === 2) return p.country_code.toUpperCase();
  }
  return '';
}

/**
 * Build the comparison matrix for the dashboard.
 * Returns an array of rows, each representing a unique plan spec across countries.
 * Groups by NORMALISED COUNTRY NAME so that the same country from different
 * providers (which may use different ISO codes) is merged into one row.
 */
function buildComparisonMatrix(plans) {
  const providers = ['kolet', 'airalo', 'saily', 'holafly'];

  // Group by normalised country name (not country_code — providers use different schemes)
  const byCountry = new Map();
  for (const plan of plans) {
    // Skip city-level entries — they only exist in Holafly and clutter the comparison
    if (isCityEntry(plan.country)) continue;

    const key = normalizeCountryName(plan.country);
    if (!key) continue;
    if (!byCountry.has(key)) {
      byCountry.set(key, {
        country: canonicalName(plan.country),
        country_code: '',
        region: plan.region || '',
        plans: [],
      });
    }
    const entry = byCountry.get(key);
    // Always use canonical name
    entry.country = canonicalName(entry.country);
    if (!entry.region && plan.region) entry.region = plan.region;
    entry.plans.push(plan);
  }

  // Resolve the best ISO-2 code for each country group
  for (const entry of byCountry.values()) {
    entry.country_code = bestCountryCode(entry.plans, entry.country);
  }

  const matrix = [];

  for (const [, countryData] of byCountry.entries()) {
    const { country, country_code, region, plans: countryPlans } = countryData;

    // Collect all unique plan specs in this country
    const specMap = new Map();
    for (const plan of countryPlans) {
      const specKey = `${plan.plan_type}|${plan.data_gb === null ? 'unlimited' : plan.data_gb}|${normalizeDays(plan.validity_days)}`;
      if (!specMap.has(specKey)) {
        specMap.set(specKey, {
          plan_type: plan.plan_type,
          data_gb: plan.data_gb,
          validity_days: normalizeDays(plan.validity_days),
          label: formatPlanLabel(plan),
          by_provider: {},
        });
      }
      // Keep cheapest per provider if duplicate
      const spec = specMap.get(specKey);
      if (
        !spec.by_provider[plan.provider] ||
        plan.price_eur < spec.by_provider[plan.provider].price_eur
      ) {
        spec.by_provider[plan.provider] = {
          price_eur: plan.price_eur,
          price_usd: plan.price_usd,
          plan_name: plan.plan_name,
        };
      }
    }

    // Sort specs: data plans by GB asc, then unlimited, then daily
    const specs = [...specMap.values()].sort(sortSpecs);

    // Count gaps (providers missing this plan in this country)
    for (const spec of specs) {
      let gapCount = 0;
      for (const p of providers) {
        if (!spec.by_provider[p]) gapCount++;
      }
      spec.gap_count = gapCount;
    }

    matrix.push({ country, country_code, region, specs });
  }

  // Sort countries alphabetically
  matrix.sort((a, b) => a.country.localeCompare(b.country));
  return matrix;
}

function formatPlanLabel(plan) {
  if (plan.plan_type === 'unlimited') return `Unlimited / ${plan.validity_days}d`;
  if (plan.plan_type === 'daily') return `Daily pass / ${plan.validity_days}d`;
  const gb = plan.data_gb;
  const display = gb >= 1 ? `${gb}GB` : `${Math.round(gb * 1024)}MB`;
  return `${display} / ${plan.validity_days}d`;
}

function sortSpecs(a, b) {
  const order = { data: 0, unlimited: 1, daily: 2 };
  if (a.plan_type !== b.plan_type) return order[a.plan_type] - order[b.plan_type];
  if (a.data_gb !== null && b.data_gb !== null) return a.data_gb - b.data_gb;
  return parseInt(a.validity_days) - parseInt(b.validity_days);
}

module.exports = { compare, buildComparisonMatrix };
