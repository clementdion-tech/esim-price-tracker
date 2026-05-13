const axios = require('axios');

let ratesCache = null;
let cacheTime = 0;
const CACHE_TTL = 3600 * 1000; // 1 hour

async function getRates() {
  if (ratesCache && Date.now() - cacheTime < CACHE_TTL) return ratesCache;
  try {
    const { data } = await axios.get('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP');
    ratesCache = data.rates;
    cacheTime = Date.now();
    return ratesCache;
  } catch {
    // Fallback rates if API is down
    return { EUR: 0.92, GBP: 0.79 };
  }
}

async function toEurUsd(amount, currency) {
  const rates = await getRates();
  currency = (currency || 'USD').toUpperCase();
  const usdPerEur = 1 / rates.EUR;  // e.g. ~1.09

  if (currency === 'USD') {
    return {
      price_usd: round(amount),
      price_eur: round(amount * rates.EUR),
    };
  }
  if (currency === 'EUR') {
    return {
      price_eur: round(amount),
      price_usd: round(amount * usdPerEur),
    };
  }
  if (currency === 'GBP') {
    // GBP → USD via (GBP/USD rate = GBP_rate_from_USD inverted)
    const gbpPerUsd = rates.GBP;          // e.g. 0.79 GBP per 1 USD
    const amountUsd = amount / gbpPerUsd; // convert GBP → USD
    return {
      price_usd: round(amountUsd),
      price_eur: round(amountUsd * rates.EUR),
    };
  }
  // Unknown currency — return as-is
  return { price_eur: round(amount), price_usd: round(amount) };
}

function round(n) { return Math.round(n * 100) / 100; }

module.exports = { toEurUsd };
