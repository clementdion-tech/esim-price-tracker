const { COUNTRY_ALIASES } = require('./countryData');

/**
 * Returns true if the slug is a utility/marketing page, not an eSIM destination.
 * Used by all scrapers to skip non-plan pages during country listing.
 */
function isUtilitySlug(slug) {
  const s = slug.toLowerCase();
  return /business|voucher|partner|device|affiliate|career|review|download|coupon|student|instruction|install|activat|support|blog|faq|terms|privacy|about|contact|login|register|reward|loyalty|nonprofit|ultra-plan|not-found|cookie|press|news|media|ambassador|referr|promo|gift/.test(s);
}

/**
 * Returns true if the Holafly destination is a city or cruise route rather than
 * a country or region. City/cruise entries only exist in Holafly and create
 * noise in the cross-provider comparison.
 *
 * Holafly city slugs typically end in "-city" or include a city name suffix
 * like "-cruise", or are well-known cities (agadir, alanya, alicante, etc.).
 */
function isHolaflyCity(slug) {
  const s = slug.toLowerCase();
  return (
    s.endsWith('-city') ||
    s.includes('-cruise') ||
    s.includes('cruise-') ||
    // Named cities & specific areas that are not countries/regions
    /^(agadir|alanya|alicante|almaty|amman|antalya|abidjan|aarhus|aaland|alberta|alaska$|abu-dhabi-city|amsterdam-city|antalya-city|abu-dhabi)/.test(s)
  );
}

// Holafly city-level display names (non-slug form) to exclude from the comparison matrix.
const CITY_PATTERNS = /^(aaland islands?|åland islands?|abidjan|abu dhabi city|agadir|alaska|alanya|alberta|alicante|almaty|amman|amsterdam city|antalya city|antalya|alaska cruise|caribbean cruise|europe cruise|mediterranean cruise)$/i;

/**
 * Returns true if this is a city/cruise display name that should not appear in
 * the country comparison matrix (Holafly includes city-level destinations).
 */
function isCityEntry(name) {
  return CITY_PATTERNS.test((name || '').trim());
}

/**
 * Normalise a country/destination name for grouping.
 * Applies alias mapping then lowercase+trim.
 */
function normalizeCountryName(name) {
  const lower = (name || '').toLowerCase().trim().replace(/\t/g, ' ').replace(/\s+/g, ' ');
  const alias = COUNTRY_ALIASES[lower];
  return alias ? alias.toLowerCase() : lower;
}

/**
 * Returns the canonical display name (title-cased alias or original).
 */
function canonicalName(name) {
  const lower = (name || '').toLowerCase().trim().replace(/\t/g, ' ').replace(/\s+/g, ' ');
  return COUNTRY_ALIASES[lower] || name.trim().replace(/\t/g, ' ');
}

module.exports = { isUtilitySlug, isHolaflyCity, isCityEntry, normalizeCountryName, canonicalName };
