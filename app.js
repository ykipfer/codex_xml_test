const DATA_URL =
  'https://data.gr.ch/api/explore/v2.1/catalog/exports/csv?select=dataset_id%2c%20include%28dcat%2a%29%2c%20include%28default%2a%29%2c%20include%28custom%2a%29%2c%20fields&limit=-1&offset=0&lang=de&timezone=UTC';

const PERIODICITY_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 31,
  quarterly: 92,
  semiannual: 184,
  biannual: 184,
  annual: 366,
  yearly: 366,
};

const state = {
  raw: [],
  lateSort: { key: 'lateWeight', direction: 'desc' },
  sizeSort: { key: 'records', direction: 'desc' },
};

init();

async function init() {
  wireTabs();
  wireControls();

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const csvText = await response.text();

    // CSV parsing approach:
    // - d3.csvParse handles quoted fields, commas inside text, escaped quotes,
    //   and missing values correctly.
    // - We normalize each row into the fields the dashboard needs.
    const parsed = d3.csvParse(csvText);
    state.raw = parsed.map(normalizeRecord);

    renderLateTable();
    renderSizeTable();
  } catch (error) {
    showError(`Failed to load CSV data: ${error.message}`);
    console.error(error);
  }
}

function normalizeRecord(row) {
  const datasetId = safeText(row['dataset_id']);
  const title = safeText(row['default.title']) || datasetId || '—';
  const periodicityRaw = safeText(row['dcat.accrualperiodicity']);
  const periodicityKey = periodicityRaw.toLowerCase().trim();

  const expectedDays = mapPeriodicity(periodicityKey);
  const lastUpdate = parseUTC(row['default.data_processed']);
  const now = new Date();

  // Lateness calculation (all UTC via millisecond timestamps):
  // elapsedDays = (now - lastUpdate) / 86_400_000
  // late when expectedDays is known and elapsedDays > expectedDays.
  const elapsedDays = lastUpdate ? (now.getTime() - lastUpdate.getTime()) / 86400000 : null;
  const late = expectedDays != null && elapsedDays != null && elapsedDays > expectedDays;
  const daysUntilDue = expectedDays != null && elapsedDays != null ? expectedDays - elapsedDays : null;
  const overdueDays = daysUntilDue != null && daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0;

  const records = parseNumber(row['default.records_count']);
  const remaining = records != null ? 500000 - records : null;
  const sourceRef = safeText(row['default.references']);

  return {
    datasetId,
    title,
    periodicityRaw,
    periodicityKey,
    periodicityDisplay: periodicityRaw || 'unknown',
    expectedDays,
    lastUpdate,
    elapsedDays,
    late,
    daysUntilDue,
    overdueDays,
    sourceRef,
    records,
    remaining,
    lateWeight: late ? overdueDays : -1,
  };
}

function mapPeriodicity(raw) {
  if (!raw) return null;
  if (PERIODICITY_DAYS[raw] != null) return PERIODICITY_DAYS[raw];

  // Handle URI-style periodicity values by matching known keywords.
  const hit = Object.keys(PERIODICITY_DAYS).find((key) => raw.includes(key));
  return hit ? PERIODICITY_DAYS[hit] : null;
}

function parseUTC(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).replace(/[\s']/g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function safeText(v) {
  return v == null ? '' : String(v).trim();
}

function renderLateTable() {
  const searchText = document.getElementById('lateSearch').value.trim().toLowerCase();
  const onlyLate = document.getElementById('lateOnly').checked;

  const filtered = state.raw.filter((d) => {
    const matchesSearch = !searchText || d.title.toLowerCase().includes(searchText) || d.datasetId.toLowerCase().includes(searchText);
    const matchesLate = !onlyLate || d.late;
    return matchesSearch && matchesLate;
  });

  const sorted = sortRows(filtered, state.lateSort);

  const summaryRoot = d3.select('#lateSummary');
  const lateCount = state.raw.filter((d) => d.late).length;
  const unknownPeriodicity = state.raw.filter((d) => d.expectedDays == null).length;

  summaryRoot.html('');
  summaryRoot
    .selectAll('div.metric')
    .data([
      `Total datasets: ${state.raw.length}`,
      `Late: ${lateCount}`,
      `Unknown periodicity: ${unknownPeriodicity}`,
    ])
    .join('div')
    .attr('class', 'metric')
    .text((d) => d);

  const columns = [
    { key: 'title', label: 'Dataset title' },
    { key: 'periodicityDisplay', label: 'Accrual Periodicity' },
    { key: 'lastUpdate', label: 'Last Update (UTC)' },
    { key: 'daysUntilDue', label: 'Time to next update' },
    { key: 'sourceRef', label: 'Data Source' },
  ];

  drawTable('#lateTable', columns, sorted, state.lateSort, (d, key) => {
    if (key === 'title') {
      const href = d.datasetId ? `https://data.gr.ch/explore/dataset/${encodeURIComponent(d.datasetId)}/` : null;
      const lateBadge = d.late ? '<span class="badge late">LATE</span>' : '';
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.title)}</a>${lateBadge}` : `${escapeHtml(d.title)}${lateBadge}`;
    }

    if (key === 'lastUpdate') {
      return d.lastUpdate ? formatUtc(d.lastUpdate) : '—';
    }

    if (key === 'daysUntilDue') {
      if (d.daysUntilDue == null) return '—';
      const absDays = Math.round(Math.abs(d.daysUntilDue));
      return d.daysUntilDue < 0 ? `Overdue by ${absDays} days` : `${absDays} days remaining`;
    }

    if (key === 'sourceRef') {
      if (!d.sourceRef) return '—';
      if (looksLikeUrl(d.sourceRef)) {
        return `<a href="${escapeAttr(d.sourceRef)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.sourceRef)}</a>`;
      }
      return escapeHtml(d.sourceRef);
    }

    return d[key] || '—';
  }, (row) => row.late);
}

function renderSizeTable() {
  const searchText = document.getElementById('sizeSearch').value.trim().toLowerCase();
  const knownOnly = document.getElementById('knownCountOnly').checked;

  const filtered = state.raw.filter((d) => {
    const matchesSearch = !searchText || d.title.toLowerCase().includes(searchText) || d.datasetId.toLowerCase().includes(searchText);
    const matchesKnown = !knownOnly || d.records != null;
    return matchesSearch && matchesKnown;
  });

  const sorted = sortRows(filtered, state.sizeSort);
  d3.select('#sizeSummary').html('').append('div').attr('class', 'metric').text(`Datasets shown: ${sorted.length}`);

  const columns = [
    { key: 'title', label: 'Dataset title' },
    { key: 'records', label: 'Number of Records' },
    { key: 'remaining', label: 'Remaining Records (500000 - records)' },
  ];

  drawTable('#sizeTable', columns, sorted, state.sizeSort, (d, key) => {
    if (key === 'title') {
      const href = d.datasetId ? `https://data.gr.ch/explore/dataset/${encodeURIComponent(d.datasetId)}/` : null;
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.title)}</a>` : escapeHtml(d.title);
    }

    if (key === 'records') {
      if (d.records == null) return '—';
      const pct = d.records / 500000;
      const color = pct >= 0.95 ? 'var(--critical)' : pct >= 0.8 ? 'var(--warn)' : 'var(--ok)';
      return `${formatNumber(d.records)}
        <div class="progress" title="${(pct * 100).toFixed(1)}% used">
          <span style="width:${Math.min(100, pct * 100)}%; background:${color}"></span>
        </div>`;
    }

    if (key === 'remaining') {
      if (d.remaining == null) return '—';
      if (d.remaining < 0) return `Exceeded by ${formatNumber(Math.abs(d.remaining))}`;
      return formatNumber(d.remaining);
    }

    return d[key] ?? '—';
  });
}

// Sorting implementation:
// - Click same column toggles asc/desc.
// - New column defaults to ascending.
function drawTable(selector, columns, rows, sortState, cellRenderer, latePredicate = () => false) {
  const table = d3.select(selector);

  const thead = table.select('thead');
  const tbody = table.select('tbody');

  const headRow = thead.selectAll('tr').data([null]).join('tr');
  headRow
    .selectAll('th')
    .data(columns)
    .join('th')
    .html((col) => {
      const active = sortState.key === col.key;
      const arrow = active ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
      return `${col.label}${arrow}`;
    })
    .on('click', (_, col) => {
      if (sortState.key === col.key) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = col.key;
        sortState.direction = 'asc';
      }
      if (selector === '#lateTable') {
        renderLateTable();
      } else {
        renderSizeTable();
      }
    });

  const tableRows = tbody.selectAll('tr').data(rows, (d) => d.datasetId || d.title);
  tableRows.exit().remove();

  const tableRowsEnter = tableRows.join('tr').classed('late', (d) => latePredicate(d));

  tableRowsEnter
    .selectAll('td')
    .data((d) => columns.map((col) => ({ col, d })))
    .join('td')
    .html(({ d, col }) => cellRenderer(d, col.key));
}

function sortRows(rows, sortState) {
  const direction = sortState.direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = sortableValue(a, sortState.key);
    const bv = sortableValue(b, sortState.key);

    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;

    return a.title.localeCompare(b.title);
  });
}

function sortableValue(row, key) {
  if (key === 'lastUpdate') return row.lastUpdate ? row.lastUpdate.getTime() : null;
  if (key === 'records') return row.records;
  if (key === 'remaining') return row.remaining;
  if (key === 'daysUntilDue') return row.daysUntilDue;
  if (key === 'lateWeight') {
    // late first then most overdue (default sort desc).
    return row.late ? row.overdueDays + 100000 : 0;
  }

  const v = row[key];
  return typeof v === 'string' ? v.toLowerCase() : v;
}

function wireTabs() {
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const target = btn.dataset.tab === 'late' ? '#lateTab' : '#sizeTab';
      document.querySelector(target).classList.add('active');
    });
  });
}

function wireControls() {
  document.getElementById('lateSearch').addEventListener('input', renderLateTable);
  document.getElementById('lateOnly').addEventListener('change', renderLateTable);
  document.getElementById('sizeSearch').addEventListener('input', renderSizeTable);
  document.getElementById('knownCountOnly').addEventListener('change', renderSizeTable);
}

function formatUtc(date) {
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatNumber(n) {
  return new Intl.NumberFormat('de-CH').format(Math.round(n));
}

function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll('`', '&#96;');
}

function showError(message) {
  const box = document.getElementById('errorBox');
  box.classList.remove('hidden');
  box.textContent = message;
}
