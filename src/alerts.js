const axios = require('axios');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://esim-price-tracker.onrender.com';

async function sendAlert({ priceChanges, newCountries }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('No SLACK_WEBHOOK_URL — skipping alert');
    return;
  }

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📊 eSIM Pricing Update Detected', emoji: true },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}* — Competitor pricing changes detected`,
    },
  });

  // Price changes
  if (priceChanges.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💰 Price Changes (${priceChanges.length})*` },
    });

    // Group by provider
    const byProvider = {};
    for (const c of priceChanges) {
      if (!byProvider[c.provider]) byProvider[c.provider] = [];
      byProvider[c.provider].push(c);
    }

    for (const [provider, changes] of Object.entries(byProvider)) {
      const lines = changes.slice(0, 10).map((c) => {
        const arrow = c.direction === 'decrease' ? '📉' : '📈';
        const sign = c.change_percent > 0 ? '+' : '';
        return `• *${c.country}* — ${c.plan_name}: €${c.old_price_eur} → €${c.new_price_eur} (${sign}${c.change_percent}%) ${arrow}`;
      });

      if (changes.length > 10) {
        lines.push(`_…and ${changes.length - 10} more_`);
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${capitalise(provider)}*\n${lines.join('\n')}`,
        },
      });
    }
  }

  // New countries
  if (newCountries.length > 0) {
    blocks.push({ type: 'divider' });
    const lines = newCountries.map(
      (c) => `• *${capitalise(c.provider)}* added: ${c.country}${c.region ? ` (${c.region})` : ''}`
    );
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🌍 New Countries / Destinations (${newCountries.length})*\n${lines.join('\n')}`,
      },
    });
  }

  // Dashboard link
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<${DASHBOARD_URL}|View full dashboard →>` },
  });

  try {
    await axios.post(webhookUrl, { blocks, text: 'eSIM Pricing Update' });
    console.error('Slack alert sent.');
  } catch (err) {
    console.error('Slack alert failed:', err.message);
  }
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { sendAlert };
