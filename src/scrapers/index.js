#!/usr/bin/env node
/**
 * Scraper orchestrator
 * Run: node src/scrapers/index.js [--only=kolet,airalo,saily,holafly]
 *
 * Reads data/current.json, runs all scrapers, compares, writes updated files,
 * and sends Slack alerts if price changes are detected.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path = require('path');
const fs = require('fs');
const { compare } = require('../compare');
const { sendAlert } = require('../alerts');

const DATA_DIR = path.join(__dirname, '../../data');
const CURRENT_FILE = path.join(DATA_DIR, 'current.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const SCRAPERS = {
  kolet: require('./kolet'),
  airalo: require('./airalo'),
  saily: require('./saily'),
  holafly: require('./holafly'),
};

async function run() {
  // Determine which scrapers to run
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.replace('--only=', '').split(',') : null;
  const scraperNames = only || Object.keys(SCRAPERS);

  console.error(`\n=== eSIM Price Tracker — ${new Date().toISOString()} ===`);
  console.error(`Running scrapers: ${scraperNames.join(', ')}\n`);

  // Load previous data
  let previous = { scraped_at: null, plans: [] };
  if (fs.existsSync(CURRENT_FILE)) {
    try {
      previous = JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
    } catch (e) {
      console.error('Could not parse previous data:', e.message);
    }
  }

  // Run scrapers
  const freshPlans = [];
  const errors = [];

  for (const name of scraperNames) {
    const scraper = SCRAPERS[name];
    if (!scraper) {
      console.error(`Unknown scraper: ${name}`);
      continue;
    }
    console.error(`\n--- Running ${name} scraper ---`);
    try {
      const plans = await scraper.scrape();
      console.error(`${name}: ${plans.length} plans scraped`);
      freshPlans.push(...plans);
    } catch (err) {
      console.error(`${name} FAILED: ${err.message}`);
      errors.push({ scraper: name, error: err.message });
      // Keep previous data for failed scrapers
      const prevPlans = previous.plans.filter((p) => p.provider === name);
      freshPlans.push(...prevPlans);
    }
  }

  // Merge: keep data from scrapers we didn't run (when using --only)
  if (only) {
    const untouched = previous.plans.filter((p) => !only.includes(p.provider));
    freshPlans.push(...untouched);
  }

  const newData = {
    scraped_at: new Date().toISOString(),
    errors: errors.length > 0 ? errors : undefined,
    plans: freshPlans,
  };

  // Compare old vs new
  console.error('\n--- Comparing with previous data ---');
  const { priceChanges, newCountries, removedPlans, addedPlans } = compare(previous.plans, freshPlans);

  console.error(`Price changes (competitors): ${priceChanges.length}`);
  console.error(`New countries: ${newCountries.length}`);
  console.error(`Added plans: ${addedPlans.length}`);
  console.error(`Removed plans: ${removedPlans.length}`);

  // Update history
  let history = { changes: [], new_countries: [] };
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (_) {}
  }

  if (priceChanges.length > 0) {
    history.changes.push(...priceChanges);
  }
  if (newCountries.length > 0) {
    history.new_countries.push(...newCountries);
  }

  // Save files
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_FILE, JSON.stringify(newData, null, 2));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.error('\nData saved.');

  // Send Slack alerts
  if ((priceChanges.length > 0 || newCountries.length > 0) && process.env.SLACK_WEBHOOK_URL) {
    console.error('Sending Slack alert...');
    await sendAlert({ priceChanges, newCountries });
  }

  // Print summary for CI logs
  console.log(JSON.stringify({ plans: freshPlans.length, priceChanges: priceChanges.length, newCountries: newCountries.length, errors }, null, 2));
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
