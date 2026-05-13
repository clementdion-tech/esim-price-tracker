#!/usr/bin/env node
/**
 * QA validation loop for all eSIM scrapers.
 *
 * Usage:
 *   node src/test.js                   # run all scrapers
 *   node src/test.js --only=airalo     # run specific scraper(s)
 *   node src/test.js --only=kolet,saily
 *
 * Behaviour:
 *  - Each scraper is attempted up to MAX_ATTEMPTS times.
 *  - PASS = scraper returned >= MIN_PLANS plans, each with at least 3 required fields non-null.
 *  - FAIL = all attempts exhausted or exception thrown every time.
 *  - Exits with code 1 if any scraper fails; 0 if all pass.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const MAX_ATTEMPTS = 3;
const MIN_PLANS = 1;
// These fields must be non-null on every plan
const REQUIRED_FIELDS = ['provider', 'country', 'price_eur', 'price_usd'];
// At least 3 of these "detail" fields must be non-null
const DETAIL_FIELDS = ['data_gb', 'plan_type', 'validity_days', 'plan_name', 'country_code'];
const MIN_DETAIL_NON_NULL = 3;

const SCRAPERS = {
  kolet: require('./scrapers/kolet'),
  airalo: require('./scrapers/airalo'),
  saily: require('./scrapers/saily'),
  holafly: require('./scrapers/holafly'),
};

// ─── Argument parsing ─────────────────────────────────────────────────────────

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.replace('--only=', '').split(',').map((s) => s.trim()) : null;
const scraperNames = only || Object.keys(SCRAPERS);

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate a single plan object.
 * Returns an array of error strings (empty = valid).
 */
function validatePlan(plan, idx) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (plan[field] === null || plan[field] === undefined || plan[field] === '') {
      errors.push(`plan[${idx}].${field} is null/undefined/empty`);
    }
  }

  const detailNonNull = DETAIL_FIELDS.filter(
    (f) => plan[f] !== null && plan[f] !== undefined && plan[f] !== ''
  ).length;
  if (detailNonNull < MIN_DETAIL_NON_NULL) {
    const missing = DETAIL_FIELDS.filter(
      (f) => plan[f] === null || plan[f] === undefined || plan[f] === ''
    );
    errors.push(
      `plan[${idx}] has only ${detailNonNull}/${MIN_DETAIL_NON_NULL} required detail fields (missing: ${missing.join(', ')})`
    );
  }

  if (typeof plan.price_eur === 'number' && plan.price_eur <= 0) {
    errors.push(`plan[${idx}].price_eur is <= 0 (${plan.price_eur})`);
  }
  if (typeof plan.price_usd === 'number' && plan.price_usd <= 0) {
    errors.push(`plan[${idx}].price_usd is <= 0 (${plan.price_usd})`);
  }

  return errors;
}

/**
 * Validate an array of plans returned by a scraper.
 * Returns { ok: boolean, planCount: number, errors: string[] }
 */
function validatePlans(plans, scraperName) {
  if (!Array.isArray(plans)) {
    return { ok: false, planCount: 0, errors: [`${scraperName} did not return an array`] };
  }
  if (plans.length < MIN_PLANS) {
    return {
      ok: false,
      planCount: plans.length,
      errors: [`${scraperName} returned ${plans.length} plans — minimum is ${MIN_PLANS}`],
    };
  }

  const allErrors = [];
  // Validate every plan (cap at 50 for speed in large result sets)
  const sampleSize = Math.min(plans.length, 50);
  for (let i = 0; i < sampleSize; i++) {
    const errs = validatePlan(plans[i], i);
    allErrors.push(...errs);
  }

  return {
    ok: allErrors.length === 0,
    planCount: plans.length,
    errors: allErrors,
  };
}

// ─── Pretty printing ──────────────────────────────────────────────────────────

function printSamplePlans(plans, n = 2) {
  const samples = plans.slice(0, n);
  for (const [i, plan] of samples.entries()) {
    console.log(`    Sample plan ${i + 1}:`, JSON.stringify(plan, null, 6).replace(/\n/g, '\n    '));
  }
}

function separator(char = '─', width = 60) {
  return char.repeat(width);
}

// ─── Per-scraper runner with retry ───────────────────────────────────────────

async function runScraperWithRetry(name, scraper) {
  let lastError = null;
  let lastValidation = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptLabel = `attempt ${attempt}/${MAX_ATTEMPTS}`;
    console.log(`\n  [${name}] ${attemptLabel}...`);

    try {
      const plans = await scraper.scrape();
      const validation = validatePlans(plans, name);

      if (validation.ok) {
        return { passed: true, planCount: validation.planCount, plans, attempt };
      }

      console.log(`  [${name}] Validation failed (${attemptLabel}):`);
      for (const err of validation.errors.slice(0, 5)) {
        console.log(`    - ${err}`);
      }
      if (validation.errors.length > 5) {
        console.log(`    ... and ${validation.errors.length - 5} more errors`);
      }
      lastValidation = validation;
    } catch (err) {
      console.log(`  [${name}] Exception (${attemptLabel}): ${err.message}`);
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(`  [${name}] Retrying...`);
    }
  }

  return {
    passed: false,
    planCount: lastValidation?.planCount ?? 0,
    plans: [],
    attempt: MAX_ATTEMPTS,
    errors: lastValidation?.errors ?? (lastError ? [lastError.message] : ['Unknown failure']),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(separator('='));
  console.log('eSIM Price Tracker — QA Validation');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Scrapers: ${scraperNames.join(', ')}`);
  console.log(separator('='));

  const results = {};

  for (const name of scraperNames) {
    const scraper = SCRAPERS[name];
    if (!scraper) {
      console.log(`\nUnknown scraper: "${name}" — skipping`);
      results[name] = { passed: false, errors: [`Unknown scraper: ${name}`] };
      continue;
    }

    console.log(`\n${separator()}`);
    console.log(`Scraper: ${name.toUpperCase()}`);
    console.log(separator());

    const result = await runScraperWithRetry(name, scraper);
    results[name] = result;

    if (result.passed) {
      console.log(`\n  PASS — ${result.planCount} plans (succeeded on attempt ${result.attempt})`);
      printSamplePlans(result.plans, 2);
    } else {
      console.log(`\n  FAIL — ${result.planCount} plans after ${MAX_ATTEMPTS} attempts`);
      if (result.errors) {
        for (const err of result.errors.slice(0, 8)) {
          console.log(`    - ${err}`);
        }
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${separator('=')}`);
  console.log('SUMMARY');
  console.log(separator('='));

  let anyFailed = false;
  for (const name of scraperNames) {
    const r = results[name];
    if (!r) continue;
    const status = r.passed ? 'PASS' : 'FAIL';
    const count = r.planCount ?? 0;
    console.log(`  ${status.padEnd(4)}  ${name.padEnd(12)}  ${count} plans`);
    if (!r.passed) anyFailed = true;
  }

  console.log(separator('='));

  if (anyFailed) {
    console.log('\nResult: FAILED — one or more scrapers did not pass validation.');
    process.exit(1);
  } else {
    console.log('\nResult: ALL PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
