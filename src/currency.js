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
  currency = currency.toUpperCase();

  if (currency === 'USD') {
    return { price_usd: Math.round(amount * 100) / 100, price_eur: Math.round(amount * rates.EUR * 100) / 100 };
  }
  if (currency === 'EUR') {
    const usdRate = 1 / rates.EUR;
    return { price_eur: Math.round(amount * 100) / 100, price_usd: Math.round(amount * usdRate * 100) / 100 };
  }
  return { price_eur: amount, price_usd: amount };
}

module.exports = { toEurUsd };
