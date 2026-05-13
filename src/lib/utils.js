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

module.exports = { isUtilitySlug, isHolaflyCity };
