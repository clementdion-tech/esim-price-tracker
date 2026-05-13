/**
 * Slack alert for monthly competitor pricing report.
 * Only reports changes from Airalo, Saily and Holafly — never Kolet.
 * Format per change: competitor | country/region | plan | old price → new price (% Δ)
 */
const axios = require('axios');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://esim-price-tracker.onrender.com';

const PROVIDER_EMOJI = { airalo: '🟠', saily: '🟢', holafly: '🔴' };
const PROVIDER_LABEL = { airalo: 'Airalo', saily: 'Saily', holafly: 'Holafly' };

async function sendAlert({ priceChanges, newCountries }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[alerts] No SLACK_WEBHOOK_URL — skipping');
    return;
  }
  if (!priceChanges?.length && !newCountries?.length) {
    console.error('[alerts] No changes to report');
    return;
  }

  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const blocks = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📊 Monthly eSIM Competitor Price Report', emoji: true },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${date}  •  Competitors monitored: Airalo · Saily · Holafly  •  Kolet excluded` }],
  });

  // ── Price changes ────────────────────────────────────────────────────────────
  if (priceChanges.length > 0) {
    // Sort: decreases first (most competitive threat), then by % magnitude
    const sorted = [...priceChanges].sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === 'decrease' ? -1 : 1;
      return Math.abs(b.change_percent) - Math.abs(a.change_percent);
    });

    // Group by provider
    const byProvider = {};
    for (const c of sorted) {
      if (!byProvider[c.provider]) byProvider[c.provider] = [];
      byProvider[c.provider].push(c);
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*💰 ${priceChanges.length} Price Change${priceChanges.length !== 1 ? 's' : ''}* detected this month`,
      },
    });

    for (const [provider, changes] of Object.entries(byProvider)) {
      const emoji = PROVIDER_EMOJI[provider] || '⚪';
      const label = PROVIDER_LABEL[provider] || provider;

      const lines = changes.slice(0, 15).map((c) => {
        const dir    = c.direction === 'decrease' ? '📉' : '📈';
        const sign   = c.change_percent > 0 ? '+' : '';
        const flag   = flagForCode(c.country_code);
        const oldEur = Number(c.old_price_eur).toFixed(2);
        const newEur = Number(c.new_price_eur).toFixed(2);
        const oldUsd = Number(c.old_price_usd).toFixed(2);
        const newUsd = Number(c.new_price_usd).toFixed(2);

        return (
          `${dir} ${flag}*${c.country}* — ${c.plan_name}\n` +
          `     €${oldEur} → *€${newEur}*  ($${oldUsd} → $${newUsd})  _(${sign}${c.change_percent}%)_`
        );
      });

      if (changes.length > 15) lines.push(`_…and ${changes.length - 15} more changes_`);

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${emoji} *${label}*\n${lines.join('\n\n')}` },
      });
    }
  }

  // ── New countries / destinations ─────────────────────────────────────────────
  if (newCountries.length > 0) {
    blocks.push({ type: 'divider' });
    const lines = newCountries.map((c) => {
      const emoji = PROVIDER_EMOJI[c.provider] || '⚪';
      const label = PROVIDER_LABEL[c.provider] || c.provider;
      const flag  = flagForCode(c.country_code);
      return `${emoji} *${label}* added: ${flag}${c.country}${c.region ? ` _(${c.region})_` : ''}`;
    });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🌍 ${newCountries.length} New Destination${newCountries.length !== 1 ? 's' : ''}*\n${lines.join('\n')}`,
      },
    });
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<${DASHBOARD_URL}|View full pricing dashboard →>` },
  });

  try {
    await axios.post(webhookUrl, {
      text: `eSIM Competitor Report — ${priceChanges.length} price changes, ${newCountries.length} new destinations`,
      blocks,
    });
    console.error(`[alerts] Slack alert sent (${priceChanges.length} changes, ${newCountries.length} new countries)`);
  } catch (err) {
    console.error('[alerts] Slack alert failed:', err.response?.data || err.message);
  }
}

function flagForCode(code) {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + offset)).join('') + ' ';
}

module.exports = { sendAlert };
