/* ===================================================================
   eSIM Price Tracker — Dashboard JS
   Fetches /api/data and renders the light-mode competitive dashboard.
   =================================================================== */

const PROVIDERS = ['kolet', 'airalo', 'saily', 'holafly'];
const PROVIDER_LABELS = { kolet: 'Kolet', airalo: 'Airalo', saily: 'Saily', holafly: 'Holafly' };
const PROVIDER_COLORS = { kolet: '#6366f1', airalo: '#f97316', saily: '#10b981', holafly: '#e91e63' };

// Currently active plan-type filter (managed by segmented control)
let activeTypeFilter = '';
let globalData = null;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadData() {
  const refreshIcon = document.getElementById('refresh-icon');
  const btn = refreshIcon?.closest('.btn-refresh');
  if (btn) btn.classList.add('loading');

  document.getElementById('loading').classList.remove('d-none');
  document.getElementById('matrix-container').classList.add('d-none');
  document.getElementById('no-data').classList.add('d-none');

  try {
    const res = await fetch('/api/data');
    globalData = await res.json();
    renderAll();
  } catch (e) {
    console.error(e);
    document.getElementById('loading').classList.add('d-none');
    document.getElementById('no-data').classList.remove('d-none');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

function renderAll() {
  if (!globalData) return;
  renderLastUpdated();
  renderStats();
  renderChanges();
  renderNewCountries();
  populateFilters();
  renderMatrix();
  document.getElementById('loading').classList.add('d-none');
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function renderLastUpdated() {
  const el = document.getElementById('last-updated');
  if (!globalData.scraped_at) { el.textContent = 'No data yet'; return; }
  const d = new Date(globalData.scraped_at);
  const fmt = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last scraped: ${fmt} at ${time}`;
}

// ---------------------------------------------------------------------------
// Stats cards
// ---------------------------------------------------------------------------

function renderStats() {
  for (const p of PROVIDERS) {
    const el = document.getElementById(`stat-${p}`);
    if (!el) continue;
    const s = globalData.stats?.[p] || { plan_count: 0, country_count: 0 };
    el.innerHTML = `
      <div class="stat-provider-label" style="color:${PROVIDER_COLORS[p]}">${PROVIDER_LABELS[p]}</div>
      <div>
        <span class="stat-plans-number">${s.plan_count.toLocaleString()}</span>
        <span class="stat-plans-unit">plans</span>
      </div>
      <div class="stat-countries">${s.country_count} countries / destinations</div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Panel toggle (collapsible)
// ---------------------------------------------------------------------------

function togglePanel(bodyId, chevronId) {
  const body = document.getElementById(bodyId);
  const chevron = document.getElementById(chevronId);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if (chevron) chevron.classList.toggle('open', !isOpen);
}

// ---------------------------------------------------------------------------
// Price changes panel
// ---------------------------------------------------------------------------

function renderChanges() {
  const changes = globalData.recent_changes || [];
  const panel = document.getElementById('changes-panel');
  if (changes.length === 0) { panel.classList.add('d-none'); return; }
  panel.classList.remove('d-none');

  document.getElementById('changes-badge').textContent = changes.length;

  const list = document.getElementById('changes-list');
  list.innerHTML = changes.slice(0, 40).map((c) => {
    const isDown = c.direction === 'decrease';
    const sign = c.change_percent > 0 ? '+' : '';
    const pct = `${sign}${c.change_percent}%`;
    const color = PROVIDER_COLORS[c.provider] || '#64748b';
    return `
      <div class="change-card" style="border-left-color:${color}">
        <div class="change-card-provider" style="color:${color}">${PROVIDER_LABELS[c.provider] || c.provider}</div>
        <div class="change-card-country">${c.country}</div>
        <div class="change-card-plan">${c.plan_name}</div>
        <div class="change-price-row">
          <span class="old-price">€${Number(c.old_price_eur).toFixed(2)}</span>
          <i class="bi bi-arrow-right" style="font-size:10px;color:#94a3b8"></i>
          <span class="new-price ${isDown ? 'new-price--down' : 'new-price--up'}">€${Number(c.new_price_eur).toFixed(2)}</span>
          <span class="change-pct ${isDown ? 'change-pct--down' : 'change-pct--up'}">${pct}</span>
        </div>
        ${c.old_price_usd && c.new_price_usd
          ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px">$${Number(c.old_price_usd).toFixed(2)} → $${Number(c.new_price_usd).toFixed(2)}</div>`
          : ''}
        <div class="change-date">${formatDate(c.detected_at)}</div>
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------------
// New countries panel
// ---------------------------------------------------------------------------

function renderNewCountries() {
  const nc = globalData.new_countries || [];
  const panel = document.getElementById('new-countries-panel');
  if (nc.length === 0) { panel.classList.add('d-none'); return; }
  panel.classList.remove('d-none');

  document.getElementById('new-countries-badge').textContent = nc.length;

  const list = document.getElementById('new-countries-list');
  list.innerHTML = nc.map((c) => {
    const color = PROVIDER_COLORS[c.provider] || '#64748b';
    return `
      <span class="new-country-chip"
        style="background:${color}18;border-color:${color}38;color:${colorDarken(c.provider)}">
        <span class="prov-dot prov-dot--${c.provider}"></span>
        <strong style="color:#0f172a">${c.country}</strong>
        <span style="color:${color};font-size:10px;font-weight:700">${PROVIDER_LABELS[c.provider] || c.provider}</span>
        ${c.region ? `<span style="color:#94a3b8;font-size:10px">${c.region}</span>` : ''}
      </span>
    `;
  }).join('');
}

function colorDarken(provider) {
  // Return slightly darker tone for text legibility on light tint backgrounds
  const map = { kolet: '#4338ca', airalo: '#c2410c', saily: '#065f46', holafly: '#9d174d' };
  return map[provider] || '#1e293b';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function populateFilters() {
  const regionSel = document.getElementById('filter-region');
  const regions = globalData.all_regions || [];
  regionSel.innerHTML = '<option value="">All regions</option>' +
    regions.map((r) => `<option value="${esc(r)}">${r}</option>`).join('');
}

function setTypeFilter(btn) {
  activeTypeFilter = btn.dataset.value;
  document.querySelectorAll('#type-seg .seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderMatrix();
}

function resetFilters() {
  document.getElementById('filter-country').value = '';
  document.getElementById('filter-region').value = '';
  document.getElementById('filter-gaps').checked = false;
  activeTypeFilter = '';
  document.querySelectorAll('#type-seg .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  renderMatrix();
}

// ---------------------------------------------------------------------------
// Matrix rendering
// ---------------------------------------------------------------------------

function renderMatrix() {
  if (!globalData) return;

  const countryFilter = document.getElementById('filter-country').value.toLowerCase().trim();
  const regionFilter  = document.getElementById('filter-region').value.toLowerCase();
  const gapsOnly      = document.getElementById('filter-gaps').checked;

  let matrix = globalData.matrix || [];

  matrix = matrix.filter((row) => {
    if (countryFilter && !row.country.toLowerCase().includes(countryFilter)) return false;
    if (regionFilter && (row.region || '').toLowerCase() !== regionFilter) return false;
    return true;
  });

  const changeIndex = buildChangeIndex(globalData.recent_changes || []);
  const container   = document.getElementById('matrix-accordion');
  container.innerHTML = '';

  let visibleCount = 0;

  for (const row of matrix) {
    let specs = row.specs;
    if (activeTypeFilter) specs = specs.filter((s) => s.plan_type === activeTypeFilter);
    if (gapsOnly) specs = specs.filter((s) => s.gap_count > 0);
    if (specs.length === 0) continue;

    visibleCount++;
    const id = `country-${(row.country_code || row.country).replace(/\W+/g, '-')}`;

    const totalGaps = specs.reduce((acc, s) => acc + (s.gap_count || 0), 0);
    const gapChip   = totalGaps > 0
      ? `<span class="gap-chip">${totalGaps} gap${totalGaps !== 1 ? 's' : ''}</span>`
      : '';

    const item = document.createElement('div');
    item.className = 'country-item';
    item.innerHTML = `
      <div class="country-header" onclick="toggleCountry('${id}')">
        <span class="country-flag">${flagEmoji(row.country_code)}</span>
        <span class="country-name">${esc(row.country)}</span>
        ${row.region ? `<span class="region-badge">${esc(row.region)}</span>` : ''}
        <span class="plan-count-chip">${specs.length} plan${specs.length !== 1 ? 's' : ''}</span>
        ${gapChip}
        <i class="bi bi-chevron-down country-header-chevron" id="chev-${id}"></i>
      </div>
      <div class="country-body" id="body-${id}">
        ${buildTable(row.country_code, specs, changeIndex)}
      </div>
    `;
    container.appendChild(item);
  }

  document.getElementById('country-count').textContent =
    `${visibleCount} countr${visibleCount !== 1 ? 'ies' : 'y'}`;
  document.getElementById('matrix-container').classList.toggle('d-none', visibleCount === 0);
  document.getElementById('no-data').classList.toggle('d-none', visibleCount > 0);
}

function toggleCountry(id) {
  const body   = document.getElementById(`body-${id}`);
  const chevron = document.getElementById(`chev-${id}`);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if (chevron) chevron.classList.toggle('open', !isOpen);
}

// ---------------------------------------------------------------------------
// Table builder
// ---------------------------------------------------------------------------

function buildTable(countryCode, specs, changeIndex) {
  const providerHeaders = PROVIDERS.map((p) => {
    const koletClass = p === 'kolet' ? ' th-kolet' : '';
    return `
      <th class="th-provider${koletClass}">
        <div class="th-provider-inner">
          <span class="prov-dot prov-dot--${p}"></span>
          ${PROVIDER_LABELS[p]}
        </div>
      </th>
    `;
  }).join('');

  const TYPE_BADGES = {
    data:      '<span class="badge-pill badge-data">Data</span>',
    unlimited: '<span class="badge-pill badge-unlimited">Unlimited</span>',
    daily:     '<span class="badge-pill badge-daily">Daily</span>',
  };

  const rows = specs.map((spec) => {
    // Find cheapest non-zero price across all providers for this row
    const prices = PROVIDERS
      .map((p) => spec.by_provider[p]?.price_eur)
      .filter((x) => x !== undefined && x !== null && x > 0);
    const minPrice = prices.length > 1 ? Math.min(...prices) : null;

    const typeBadge = TYPE_BADGES[spec.plan_type] || '';

    const cells = PROVIDERS.map((p) => {
      const plan = spec.by_provider[p];
      const isKolet = p === 'kolet';

      if (!plan || !plan.price_eur) {
        return `<td class="gap-cell${isKolet ? ' td-kolet' : ''}">—</td>`;
      }

      const key    = changeKey(p, countryCode, spec);
      const change = changeIndex.get(key);

      let cellClass = 'price-cell';
      if (isKolet) cellClass += ' td-kolet';

      let changeBadge = '';
      if (change) {
        cellClass += ' cell-changed';
        const isDown = change.direction === 'decrease';
        const sign   = change.change_percent > 0 ? '+' : '';
        changeBadge  = `<div><span class="price-change-badge price-change-badge--${isDown ? 'down' : 'up'}">${sign}${change.change_percent}%</span></div>`;
      }

      const isCheapest = minPrice !== null && plan.price_eur === minPrice;
      if (isCheapest) cellClass += ' cell-cheapest';

      return `
        <td class="${cellClass}">
          <div class="price-eur">€${Number(plan.price_eur).toFixed(2)}</div>
          <div class="price-usd">$${Number(plan.price_usd).toFixed(2)}</div>
          ${changeBadge}
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td>
          <div class="plan-label">
            <span>${esc(spec.label)}</span>
            ${typeBadge}
          </div>
        </td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <table class="comparison-table">
      <thead>
        <tr>
          <th class="th-plan">Plan</th>
          ${providerHeaders}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Change index helpers
// ---------------------------------------------------------------------------

function buildChangeIndex(changes) {
  const index = new Map();
  for (const c of changes) {
    const k = `${c.provider}|${(c.country_code || '').toUpperCase()}|${c.plan_type || ''}|${c.data_gb === null || c.data_gb === undefined ? 'unlimited' : c.data_gb}|${normalizeDays(c.validity_days)}`;
    index.set(k, c);
  }
  return index;
}

function changeKey(provider, countryCode, spec) {
  return `${provider}|${(countryCode || '').toUpperCase()}|${spec.plan_type}|${spec.data_gb === null || spec.data_gb === undefined ? 'unlimited' : spec.data_gb}|${spec.validity_days}`;
}

function normalizeDays(days) {
  if (!days) return '0';
  const d = parseInt(days);
  if (d >= 28 && d <= 31) return '30';
  if (d >= 7  && d <= 8)  return '7';
  if (d >= 14 && d <= 16) return '15';
  return String(d);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(c.charCodeAt(0) + offset)).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Bootstrap JS (accordion is replaced by custom, but load for any modal etc.)
// ---------------------------------------------------------------------------
(function () {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js';
  document.head.appendChild(s);
})();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadData();
