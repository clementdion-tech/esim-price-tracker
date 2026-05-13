/**
 * Kolet scraper — uses the public catalog API directly.
 * No browser needed.
 */
const axios = require('axios');

const API_URL = 'https://api.kolet.com/catalog/plans/anonymous';

function roundToStandardGb(gb) {
  const standards = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 100];
  return standards.reduce((prev, curr) => Math.abs(curr - gb) < Math.abs(prev - gb) ? curr : prev);
}

async function scrape() {
  console.error('[Kolet] Fetching from API...');

  const { data } = await axios.get(API_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; price-tracker/1.0)',
    },
    timeout: 30000,
  });

  const plans = [];

  for (const plan of data.plans || []) {
    if (!plan.zone?.enabled) continue;

    const dataGb = roundToStandardGb(plan.allowanceInMb / 1024);
    const priceEur = plan.priceInCentsEUR / 100;
    const priceUsd = plan.priceInCentsUSD / 100;

    plans.push({
      provider: 'kolet',
      country: plan.zone.label,
      country_code: plan.zone.code,  // Kolet uses 3-letter zone codes (e.g. FRA)
      region: plan.zone.coverageType || '',
      plan_name: `${dataGb}GB / ${plan.durationInDays}d`,
      data_gb: dataGb,
      plan_type: 'data',
      validity_days: plan.durationInDays,
      price_eur: priceEur,
      price_usd: priceUsd,
    });
  }

  console.error(`[Kolet] ${plans.length} plans`);
  return plans;
}

module.exports = { scrape };
