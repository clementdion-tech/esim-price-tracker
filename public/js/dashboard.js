const PROVIDERS = ['kolet', 'airalo', 'saily', 'holafly'];
const PROVIDER_LABELS = { kolet: 'Kolet', airalo: 'Airalo', saily: 'Saily', holafly: 'Holafly' };
const PROVIDER_COLORS = { kolet: '#6366f1', airalo: '#f97316', saily: '#10b981', holafly: '#e91e63' };

let globalData = null;

async function loadData() {
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

function renderLastUpdated() {
  const el = document.getElementById('last-updated');
  if (!globalData.scraped_at) { el.textContent = 'No data yet'; return; }
  const d = new Date(globalData.scraped_at);
  el.textContent = `Last scraped: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function renderStats() {
  for (const p of PROVIDERS) {
    const el = document.getElementById(`stat-${p}`);
    if (!el) continue;
    const s = globalData.stats?.[p] || { plan_count: 0, country_count: 0 };
    el.innerHTML = `
      <div class="stat-provider ${p}" style="color:${PROVIDER_COLORS[p]}">${PROVIDER_LABELS[p]}</div>
      <div class="stat-plans">${s.plan_count.toLocaleString()}</div>
      <div class="stat-sub">${s.country_count} countries / destinations</div>
    `;
  }
}

function renderChanges() {
  const changes = globalData.recent_changes || [];
  const panel = document.getElementById('changes-panel');
  if (changes.length === 0) { panel.classList.add('d-none'); return; }
  panel.classList.remove('d-none');
  document.getElementById('changes-badge').textContent = changes.length;

  const list = document.getElementById('changes-list');
  list.innerHTML = changes.slice(0, 30).map((c) => {
    const dir = c.direction === 'decrease';
    const sign = c.change_percent > 0 ? '+' : '';
    const pct = `${sign}${c.change_percent}%`;
    return `
      <div class="change-card">
        <div class="provider-tag" style="color:${PROVIDER_COLORS[c.provider]}">${PROVIDER_LABELS[c.provider]}</div>
        <div class="country">${c.country}</div>
        <div class="plan-name">${c.plan_name}</div>
        <div class="change-price-row">
          <span class="old-price">€${c.old_price_eur}</span>
          <i class="bi bi-arrow-right text-muted" style="font-size:0.7rem"></i>
          <span class="new-price ${dir ? 'text-success' : 'text-danger'}">€${c.new_price_eur}</span>
          <span class="change-badge ${dir ? 'decrease' : 'increase'}">${pct}</span>
        </div>
        <div class="price-usd">$${c.old_price_usd} → $${c.new_price_usd}</div>
        <div class="text-muted" style="font-size:0.68rem;margin-top:4px">${formatDate(c.detected_at)}</div>
      </div>
    `;
  }).join('');
}

function renderNewCountries() {
  const nc = globalData.new_countries || [];
  const panel = document.getElementById('new-countries-panel');
  if (nc.length === 0) { panel.classList.add('d-none'); return; }
  panel.classList.remove('d-none');

  const list = document.getElementById('new-countries-list');
  list.innerHTML = nc.map((c) => `
    <span class="new-country-badge" style="background:${PROVIDER_COLORS[c.provider]}22;border:1px solid ${PROVIDER_COLORS[c.provider]}44;color:#e2e8f0">
      <span class="provider-dot dot-${c.provider}"></span>
      <strong>${c.country}</strong>
      <span style="color:${PROVIDER_COLORS[c.provider]};font-size:0.68rem">${PROVIDER_LABELS[c.provider]}</span>
      ${c.region ? `<span style="color:#6b7280;font-size:0.68rem">${c.region}</span>` : ''}
    </span>
  `).join('');
}

function populateFilters() {
  const regionSel = document.getElementById('filter-region');
  const regions = globalData.all_regions || [];
  regionSel.innerHTML = '<option value="">All regions</option>' +
    regions.map((r) => `<option value="${esc(r)}">${r}</option>`).join('');
}

function renderMatrix() {
  if (!globalData) return;

  const countryFilter = document.getElementById('filter-country').value.toLowerCase().trim();
  const regionFilter = document.getElementById('filter-region').value.toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const gapsOnly = document.getElementById('filter-gaps').checked;

  let matrix = globalData.matrix || [];

  // Filter countries
  matrix = matrix.filter((row) => {
    if (countryFilter && !row.country.toLowerCase().includes(countryFilter)) return false;
    if (regionFilter && (row.region || '').toLowerCase() !== regionFilter) return false;
    return true;
  });

  // Build price change index for quick lookup
  const changeIndex = buildChangeIndex(globalData.recent_changes || []);

  // Filter and render
  const accordion = document.getElementById('matrix-accordion');
  accordion.innerHTML = '';

  let visibleCount = 0;

  for (const row of matrix) {
    let specs = row.specs;

    if (typeFilter) specs = specs.filter((s) => s.plan_type === typeFilter);
    if (gapsOnly) specs = specs.filter((s) => s.gap_count > 0);
    if (specs.length === 0) continue;

    visibleCount++;
    const id = `country-${(row.country_code || row.country).replace(/\W/g, '-')}`;

    const item = document.createElement('div');
    item.className = 'accordion-item';

    const gapBadge = specs.some((s) => s.gap_count > 0)
      ? `<span class="badge bg-secondary ms-2" style="font-size:0.65rem">${specs.filter(s => s.gap_count > 0).length} gaps</span>`
      : '';

    item.innerHTML = `
      <h2 class="accordion-header">
        <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#${id}">
          <span class="me-3">${flagEmoji(row.country_code)}${row.country}</span>
          ${row.region ? `<span class="text-muted small me-2">${row.region}</span>` : ''}
          <span class="text-muted small">${specs.length} plan${specs.length !== 1 ? 's' : ''}</span>
          ${gapBadge}
        </button>
      </h2>
      <div id="${id}" class="accordion-collapse collapse">
        <div class="accordion-body">
          <div class="table-scroll">
            ${buildTable(row.country_code, specs, changeIndex)}
          </div>
        </div>
      </div>
    `;

    accordion.appendChild(item);
  }

  document.getElementById('country-count').textContent = `${visibleCount} countr${visibleCount !== 1 ? 'ies' : 'y'}`;
  document.getElementById('matrix-container').classList.toggle('d-none', matrix.length === 0);
  document.getElementById('no-data').classList.toggle('d-none', matrix.length > 0);
}

function buildTable(countryCode, specs, changeIndex) {
  const headers = PROVIDERS.map((p) =>
    `<th class="provider-header"><span class="provider-dot dot-${p}"></span>${PROVIDER_LABELS[p]}</th>`
  ).join('');

  const rows = specs.map((spec) => {
    // Find cheapest price across providers for this spec
    const prices = PROVIDERS
      .map((p) => spec.by_provider[p]?.price_eur)
      .filter((x) => x !== undefined && x > 0);
    const minPrice = prices.length > 0 ? Math.min(...prices) : null;

    const typeBadge = {
      data: '<span class="plan-type-badge badge-data">Data</span>',
      unlimited: '<span class="plan-type-badge badge-unlimited">Unlimited</span>',
      daily: '<span class="plan-type-badge badge-daily">Daily</span>',
    }[spec.plan_type] || '';

    const cells = PROVIDERS.map((p) => {
      const plan = spec.by_provider[p];
      if (!plan) {
        return `<td class="gap-cell ${spec.gap_count > 2 ? 'highlighted' : ''}">—</td>`;
      }

      const key = changeKey(p, countryCode, spec);
      const change = changeIndex.get(key);
      let changeBadge = '';
      let cellClass = 'price-cell';

      if (change) {
        cellClass += ' price-changed';
        const dir = change.direction === 'decrease';
        const sign = change.change_percent > 0 ? '+' : '';
        changeBadge = `<div><span class="price-tag-${dir ? 'decreased' : 'increased'}">${sign}${change.change_percent}%</span></div>`;
      }

      const isCheapest = minPrice !== null && plan.price_eur === minPrice && prices.length > 1;
      if (isCheapest) cellClass += ' price-cheapest';

      return `
        <td class="${cellClass}">
          <div class="price-eur">€${plan.price_eur.toFixed(2)}</div>
          <div class="price-usd">$${plan.price_usd.toFixed(2)}</div>
          ${changeBadge}
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td class="plan-label">${spec.label}${typeBadge}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <table class="comparison-table">
      <thead>
        <tr>
          <th style="min-width:160px">Plan</th>
          ${headers}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildChangeIndex(changes) {
  const index = new Map();
  for (const c of changes) {
    // Use multiple possible key forms
    const k = `${c.provider}|${(c.country_code || '').toUpperCase()}|${c.plan_type || ''}|${c.data_gb === null ? 'unlimited' : c.data_gb}|${normalizeDays(c.validity_days)}`;
    index.set(k, c);
  }
  return index;
}

function changeKey(provider, countryCode, spec) {
  return `${provider}|${(countryCode || '').toUpperCase()}|${spec.plan_type}|${spec.data_gb === null ? 'unlimited' : spec.data_gb}|${spec.validity_days}`;
}

function normalizeDays(days) {
  if (!days) return '0';
  const d = parseInt(days);
  if (d >= 28 && d <= 31) return '30';
  if (d >= 7 && d <= 8) return '7';
  if (d >= 14 && d <= 16) return '15';
  return String(d);
}

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(c.charCodeAt(0) + offset)).join('') + ' ';
}

function esc(str) {
  return String(str).replace(/"/g, '&quot;');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Bootstrap JS for accordion
const bsScript = document.createElement('script');
bsScript.src = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js';
document.head.appendChild(bsScript);

// Initial load
loadData();
