'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MotoGP Analytics — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Config ─────────────────────────────────────────────────────────────────
const DATA_PATH = 'data';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Canonical display names for each track_folder value. */
const TRACK_NAMES = {
  AUTODROMO_INTERNACIONAL_DE_GOIANIA_AYRTON_SENNA: 'Goiânia',
  AUTODROMO_INTERNACIONAL_DO_ALGARVE:              'Algarve International Circuit',
  AUTODROMO_INTERNAZIONALE_DEL_MUGELLO:            'Mugello',
  AUTOMOTODROM_BRNO:                               'Brno',
  BALATON_PARK_CIRCUIT:                            'Balaton Park Circuit',
  BUDDH_INTERNATIONAL_CIRCUIT:                     'Buddh International Circuit',
  CHANG_INTERNATIONAL_CIRCUIT:                     'Chang International Circuit',
  CIRCUITO_DE_JEREZ_ANGEL_NIETO:                   'Jerez',
  CIRCUIT_DE_BARCELONA_CATALUNYA:                  'Circuit de Barcelona-Catalunya',
  CIRCUIT_OF_THE_AMERICAS:                         'Circuit of the Americas',
  CREDITAS_AUTODROM_BRNO:                          'Brno',
  LE_MANS:                                         'Le Mans',
  LUSAIL_INTERNATIONAL_CIRCUIT:                    'Lusail International Circuit',
  MISANO_WORLD_CIRCUIT_MARCO_SIMONCELLI:           'Misano',
  MOBILITY_RESORT_MOTEGI:                          'Motegi',
  MOTORLAND_ARAGON:                                'MotorLand Aragón',
  PERTAMINA_MANDALIKA_CIRCUIT:                     'Mandalika',
  PETRONAS_SEPANG_INTERNATIONAL_CIRCUIT:           'Sepang',
  PHILLIP_ISLAND:                                  'Phillip Island',
  RED_BULL_RING_SPIELBERG:                         'Red Bull Ring',
  SACHSENRING:                                     'Sachsenring',
  SILVERSTONE_CIRCUIT:                             'Silverstone',
  TERMAS_DE_RIO_HONDO:                             'Termas de Río Hondo',
  TT_CIRCUIT_ASSEN:                                'TT Circuit Assen',
};

/**
 * Format a track_folder into a human-readable circuit name.
 * Uses TRACK_NAMES lookup; falls back to title-casing the folder name.
 */
/**
 * Title-case a rider name from the PDF (ALL CAPS → Title Case).
 * Handles hyphenated surnames and "Mc" prefixes.
 */
function fmtName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/Mc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase());
}

function fmtTrack(trackFolder) {
  if (!trackFolder) return '—';
  if (TRACK_NAMES[trackFolder]) return TRACK_NAMES[trackFolder];
  return trackFolder
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── Constants ───────────────────────────────────────────────────────────────
const SESSION_COLOR = {
  FP1: '#3b9eff', FP2: '#3b9eff', FP3: '#3b9eff', FP: '#3b9eff',
  PR:  '#00d4f0',
  Q1:  '#ffc200', Q2:  '#ffc200', QP: '#ffc200',
  SPR: '#b47fff',
  WUP: '#667788',
  RAC: '#e8002d',
};

const MFR_COLOR = {
  DUCATI:   '#e8002d',
  HONDA:    '#c30000',
  YAMAHA:   '#004fcc',
  APRILIA:  '#0099ff',
  KTM:      '#ff5a00',
  SUZUKI:   '#00a0cc',
  KALEX:    '#888899',
};

// Distinct palette for rider lines in charts
const PALETTE = [
  '#e8002d','#3b9eff','#00e676','#ffc200',
  '#ff6535','#b47fff','#00d4f0','#ff4081',
  '#76ff03','#ff9100','#40c4ff','#ea80fc',
];

const SESSION_ORDER = ['FP1','FP2','FP3','FP','PR','Q1','Q2','QP','SPR','WUP','RAC'];

// ── State ───────────────────────────────────────────────────────────────────
let INDEX = null;
const FILE_CACHE = new Map();

// Sessions state
let selectedYear  = '';   // active year chip; '' = all
let filterCircuit = '';   // circuit search string

// Session detail
let detailData          = null;
let detailPaneWasOpen   = false;   // remembers pane state while on another tab
let detailSelectedRiders = [];   // [{rider, color}]
let detailShowFlying    = true;
let detailChart         = null;

// Compare
let cmpData         = null;
let cmpRiders       = [];   // [{rider, color}]
let cmpChart        = null;
let cmpMode         = 'laptimes';   // 'laptimes' | 'sectors'
let cmpSectorCharts = [];           // [Chart, Chart, Chart, Chart]

// Trends
let trendsRiderName  = '';
let trendsYear       = '';
let trendsType       = '';
let trendsChart      = null;
let ALL_RIDERS       = null;   // cached map: lowercase name → [{name, sessions[]}]

// Manufacturers
let mfrChart = null;
let mfrSectorChart = null;

// ── Data layer ──────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  if (FILE_CACHE.has(path)) return FILE_CACHE.get(path);
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${path}`);
  const d = await r.json();
  FILE_CACHE.set(path, d);
  return d;
}

const loadIndex   = ()    => fetchJSON(`${DATA_PATH}/index.json`);
const loadSession = file  => fetchJSON(`${DATA_PATH}/${file}`);

// ── Utilities ───────────────────────────────────────────────────────────────
function fmt(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return `${m}'${s}`;
}

function fmtSec(sec) {
  if (sec == null || isNaN(sec)) return '—';
  return sec.toFixed(3);
}

function fmtSpeed(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(1) + ' km/h';
}

function sessionColor(type) {
  return SESSION_COLOR[type] || '#556677';
}

function mfrColor(mfr) {
  if (!mfr) return '#888899';
  const key = mfr.toUpperCase().split(' ')[0];
  return MFR_COLOR[key] || '#888899';
}

function sortedUnique(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

function destroyChart(chartRef) {
  if (chartRef) { try { chartRef.destroy(); } catch (_) {} }
  return null;
}

function setStatus(text, type = '') {
  document.getElementById('status-text').textContent = text;
  const dot = document.querySelector('.status-dot');
  dot.className = 'status-dot ' + type;
}

// ── Chart defaults ──────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 220 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1c1c2e',
      borderColor: '#3c3c5c',
      borderWidth: 1,
      titleColor: '#8888aa',
      bodyColor: '#f0f0f8',
      padding: 10,
    },
  },
  scales: {
    x: {
      grid:  { color: '#1c1c2e' },
      ticks: { color: '#44445a', font: { family: 'Rajdhani', size: 12 } },
      title: { display: true, color: '#44445a', font: { family: 'Rajdhani', size: 11 } },
    },
    y: {
      grid:  { color: '#1c1c2e' },
      ticks: { color: '#44445a', font: { family: 'Rajdhani', size: 12 } },
      title: { display: true, color: '#44445a', font: { family: 'Rajdhani', size: 11 } },
    },
  },
};

function mergeDeep(target, ...sources) {
  // Simple deep merge for chart options
  for (const src of sources) {
    for (const k in src) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        if (!target[k]) target[k] = {};
        mergeDeep(target[k], src[k]);
      } else {
        target[k] = src[k];
      }
    }
  }
  return target;
}

// ── GP country code → flag emoji ────────────────────────────────────────────
const GP_FLAG = {
  ARG:'🇦🇷', AUS:'🇦🇺', AUT:'🇦🇹', CAT:'🇪🇸', CZE:'🇨🇿',
  FIN:'🇫🇮', FRA:'🇫🇷', GBR:'🇬🇧', GER:'🇩🇪', INA:'🇮🇩',
  IND:'🇮🇳', ITA:'🇮🇹', JPN:'🇯🇵', MAL:'🇲🇾', NED:'🇳🇱',
  POR:'🇵🇹', QAT:'🇶🇦', RSM:'🇸🇲', SPA:'🇪🇸', THA:'🇹🇭',
  USA:'🇺🇸', AME:'🇺🇸', VLC:'🇪🇸', EMI:'🇮🇹', KAZ:'🇰🇿',
  ALG:'🇩🇿', IDN:'🇮🇩',
};

// ══════════════════════════════════════════════════════════════════════════════
//  SESSIONS VIEW — Race Weekend Layout
// ══════════════════════════════════════════════════════════════════════════════

/** Group sessions into race weekends keyed by (year, track_folder, gp) */
function buildWeekends(sessions) {
  const map = new Map();
  sessions.forEach(s => {
    const key = `${s.year}__${s.track_folder}__${s.gp || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        year:         s.year,
        track_folder: s.track_folder,
        gp_code:      s.gp_code || '',
        date:         s.date || '',
        sessions:     [],
      });
    }
    const w = map.get(key);
    w.sessions.push(s);
    // Keep the earliest date as the weekend anchor
    if (s.date && (!w.date || s.date < w.date)) w.date = s.date;
  });

  // Sort sessions within each weekend by canonical order
  map.forEach(w => {
    w.sessions.sort((a, b) =>
      SESSION_ORDER.indexOf(a.session) - SESSION_ORDER.indexOf(b.session));
  });

  // Sort weekends newest → oldest
  return [...map.values()].sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return (b.date || '').localeCompare(a.date || '');
  });
}

function initSessionsView() {
  // Default to latest year
  const years = sortedUnique(INDEX.sessions.map(s => String(s.year))).reverse();
  selectedYear = years[0] || '';

  renderYearChips(years);
  renderWeekends();

  document.getElementById('year-chips').addEventListener('click', e => {
    const y = e.target.dataset.year;
    if (!y) return;
    selectedYear = selectedYear === y ? '' : y;
    renderYearChips(years);
    renderWeekends();
  });

  document.getElementById('circuit-search').addEventListener('input', e => {
    filterCircuit = e.target.value.trim();
    renderWeekends();
  });

  document.getElementById('weekends-list').addEventListener('click', e => {
    const pill = e.target.closest('.session-pill');
    if (pill) openSessionDetail(pill.dataset.file);
  });
}

function renderYearChips(years) {
  document.getElementById('year-chips').innerHTML = years.map(y =>
    `<button class="chip ${selectedYear === y ? 'active' : ''}" data-year="${y}">${y}</button>`
  ).join('');
}

function renderWeekends() {
  const list = document.getElementById('weekends-list');

  let sessions = INDEX.sessions;

  // Filter by year
  if (selectedYear) {
    sessions = sessions.filter(s => String(s.year) === selectedYear);
  }

  // Filter by circuit search
  if (filterCircuit) {
    const q = filterCircuit.toLowerCase();
    sessions = sessions.filter(s => {
      const hay = `${fmtTrack(s.track_folder)} ${s.gp_code || ''} ${s.circuit || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const weekends = buildWeekends(sessions);

  if (!weekends.length) {
    list.innerHTML = `<div class="empty-state">No sessions found</div>`;
    return;
  }

  list.innerHTML = weekends.map(w => {
    const flag    = GP_FLAG[w.gp_code] || '🏁';
    const circuit = fmtTrack(w.track_folder);
    const dateStr = w.date ? new Date(w.date).toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: 'numeric' }) : '';

    const pills = w.sessions.map(s => {
      const col = sessionColor(s.session);
      return `<button class="session-pill" data-file="${s.file}"
        style="--pill-color:${col}">${s.session}</button>`;
    }).join('');

    return `<div class="weekend-row">
      <div class="weekend-left">
        <span class="weekend-flag">${flag}</span>
        <div class="weekend-info">
          <div class="weekend-circuit">${circuit}</div>
          <div class="weekend-meta-sub">${w.gp_code} · ${dateStr}</div>
        </div>
      </div>
      <div class="weekend-pills">${pills}</div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
//  SESSION DETAIL VIEW
// ══════════════════════════════════════════════════════════════════════════════
async function openSessionDetail(file) {
  detailData = null;
  detailSelectedRiders = [];
  detailChart = destroyChart(detailChart);
  detailShowFlying = true;

  // Show the detail view
  document.getElementById('view-session-detail').classList.add('active');

  // Reset UI
  document.getElementById('detail-gp-name').textContent = 'Loading…';
  document.getElementById('detail-circuit').textContent = '';
  document.getElementById('detail-date').textContent = '';
  document.getElementById('detail-rider-table').innerHTML = '';
  document.getElementById('chart-legend').innerHTML = '';
  document.getElementById('chart-placeholder').style.display = '';
  document.querySelectorAll('.chart-toggle').forEach((b, i) =>
    b.classList.toggle('active', i === 0));

  try {
    setStatus('Loading session…', 'loading');
    detailData = await loadSession(file);
    setStatus(`${INDEX.session_count} sessions`, 'ok');

    renderDetailHeader();
    renderDetailTable();
    // Auto-select top 3
    detailData.riders.slice(0, 3).forEach((r, i) =>
      detailSelectedRiders.push({ rider: r, color: PALETTE[i] }));
    updateDetailRowHighlights();
    renderDetailChart();
  } catch (err) {
    document.getElementById('detail-gp-name').textContent = 'Error loading session';
    document.getElementById('detail-circuit').textContent = err.message;
    setStatus('Error', 'error');
  }
}

function renderDetailHeader() {
  const m = detailData.meta;
  const badge = document.getElementById('detail-session-badge');
  badge.textContent = m.session || '';
  badge.style.background = sessionColor(m.session);
  document.getElementById('detail-gp-name').textContent = fmtTrack(m.track_folder);
  document.getElementById('detail-circuit').textContent = m.circuit && m.circuit.length < 60 ? m.circuit : fmtTrack(m.track_folder);
  document.getElementById('detail-date').textContent = m.date ? m.date.slice(0, 10) : '';
}

function renderDetailTable() {
  const riders = detailData.riders;
  if (!riders?.length) {
    document.getElementById('detail-rider-table').innerHTML =
      '<p style="padding:20px;color:var(--text-3)">No rider data found</p>';
    return;
  }

  // Find best sector times for highlighting
  const bestT = [1,2,3,4].map(i =>
    Math.min(...riders.map(r => r.summary[`best_t${i}`]).filter(v => v != null)));

  const html = `<table class="rider-table">
    <thead><tr>
      <th>POS</th><th>#</th><th>RIDER</th><th>BIKE</th>
      <th>BEST LAP</th><th>T1</th><th>T2</th><th>T3</th><th>T4</th><th>TOP SPD</th>
    </tr></thead>
    <tbody>
      ${riders.map(r => {
        const s = r.summary;
        const t1cls = s.best_t1 === bestT[0] ? ' best-sector' : '';
        const t2cls = s.best_t2 === bestT[1] ? ' best-sector' : '';
        const t3cls = s.best_t3 === bestT[2] ? ' best-sector' : '';
        const t4cls = s.best_t4 === bestT[3] ? ' best-sector' : '';
        return `<tr class="rider-row" data-pos="${r.position}">
          <td class="td-pos">${r.position}</td>
          <td class="td-num">#${r.number}</td>
          <td class="td-name">
            <span class="rider-name">${fmtName(r.name)}</span>
            <span class="team-name">${r.team || ''}</span>
          </td>
          <td class="td-bike" style="color:${mfrColor(r.bike)}">${r.bike || '—'}</td>
          <td class="td-laptime">${fmt(s.best_lap_sec)}</td>
          <td class="td-sector${t1cls}">${fmtSec(s.best_t1)}</td>
          <td class="td-sector${t2cls}">${fmtSec(s.best_t2)}</td>
          <td class="td-sector${t3cls}">${fmtSec(s.best_t3)}</td>
          <td class="td-sector${t4cls}">${fmtSec(s.best_t4)}</td>
          <td class="td-speed">${fmtSpeed(s.top_speed_kmh)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;

  document.getElementById('detail-rider-table').innerHTML = html;
}

function updateDetailRowHighlights() {
  document.querySelectorAll('.rider-row').forEach(row => {
    const pos  = parseInt(row.dataset.pos);
    const sel  = detailSelectedRiders.find(x => x.rider.position === pos);
    row.classList.toggle('selected', !!sel);
    if (sel) row.style.setProperty('--row-color', sel.color);
    else row.style.removeProperty('--row-color');
  });
}

function renderDetailChart() {
  const canvas = document.getElementById('lap-chart');
  const placeholder = document.getElementById('chart-placeholder');

  detailChart = destroyChart(detailChart);

  if (!detailSelectedRiders.length) {
    placeholder.style.display = '';
    document.getElementById('chart-legend').innerHTML = '';
    return;
  }
  placeholder.style.display = 'none';

  const datasets = detailSelectedRiders.map(({ rider, color }) => {
    const laps = (rider.laps || []).filter(l =>
      detailShowFlying ? l.type === 'Flying' : l.time_sec != null
    );
    return {
      label: fmtName(rider.name),
      data: laps.map(l => ({ x: l.lap, y: l.time_sec })),
      borderColor: color,
      backgroundColor: color + '18',
      pointBackgroundColor: color,
      pointRadius: 4,
      pointHoverRadius: 7,
      tension: 0.3,
      fill: false,
      spanGaps: false,
    };
  });

  const allTimes = datasets.flatMap(d => d.data.map(p => p.y)).filter(Boolean);
  if (!allTimes.length) {
    placeholder.style.display = '';
    document.getElementById('chart-legend').innerHTML = '';
    return;
  }

  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const pad  = Math.max((maxT - minT) * 0.12, 0.5);

  // Best lap reference line
  const maxLap = Math.max(...datasets.flatMap(d => d.data.map(p => p.x)).filter(Boolean));
  datasets.push({
    label: '_best',
    data: [{ x: 1, y: minT }, { x: maxLap, y: minT }],
    borderColor: '#ffffff0f',
    borderWidth: 1,
    borderDash: [4, 4],
    pointRadius: 0,
    fill: false,
    tension: 0,
  });

  detailChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: mergeDeep({}, CHART_DEFAULTS, {
      plugins: {
        tooltip: {
          callbacks: {
            title:  items => `Lap ${items[0].parsed.x}`,
            label:  item  => item.dataset.label.startsWith('_') ? null
                             : ` ${item.dataset.label}: ${fmt(item.parsed.y)}`,
            filter: item  => !item.dataset.label.startsWith('_'),
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { text: 'LAP' },
          ticks: { stepSize: 1 },
        },
        y: {
          min: minT - pad,
          max: maxT + pad,
          title: { text: 'LAP TIME' },
          ticks: { callback: v => fmt(v) },
        },
      },
    }),
  });

  // Legend
  document.getElementById('chart-legend').innerHTML =
    detailSelectedRiders.map(({ rider, color }) =>
      `<div class="legend-item">
        <span class="legend-dot" style="background:${color}"></span>
        <span class="legend-name">${fmtName(rider.name)}</span>
        <span class="legend-bike" style="color:${mfrColor(rider.bike)}">${rider.bike || ''}</span>
        <span class="legend-time">${fmt(rider.summary.best_lap_sec)}</span>
      </div>`
    ).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPARE VIEW
// ══════════════════════════════════════════════════════════════════════════════
function initCompareView() {
  const yearSel    = document.getElementById('cmp-year');
  const circuitSel = document.getElementById('cmp-circuit');
  const sessionSel = document.getElementById('cmp-session');

  // Populate year
  const years = [...new Set(INDEX.sessions.map(s => s.year))].sort((a,b) => b-a);
  yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');

  const populateCircuits = () => {
    const yr = yearSel.value;
    const circuits = sortedUnique(
      INDEX.sessions.filter(s => String(s.year) === yr).map(s => s.track_folder)
    );
    circuitSel.innerHTML = '<option value="">All Circuits</option>' +
      circuits.map(c => `<option value="${c}">${fmtTrack(c)}</option>`).join('');
    populateSessions();
  };

  const populateSessions = () => {
    const yr = yearSel.value;
    const circ = circuitSel.value;
    let list = INDEX.sessions.filter(s => String(s.year) === yr);
    if (circ) list = list.filter(s => s.track_folder === circ);
    list.sort((a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      if (da < db) return -1; if (da > db) return 1;
      return (SESSION_ORDER.indexOf(a.session)||99) - (SESSION_ORDER.indexOf(b.session)||99);
    });
    sessionSel.innerHTML = '<option value="">Select a session…</option>' +
      list.map(s => {
        const badge  = s.session || '?';
        const label  = `${badge} — ${fmtTrack(s.track_folder)} ${s.date ? s.date.slice(0,10) : ''}`;
        return `<option value="${s.file}">${label}</option>`;
      }).join('');
  };

  populateCircuits();
  yearSel.addEventListener('change', populateCircuits);
  circuitSel.addEventListener('change', populateSessions);

  sessionSel.addEventListener('change', async () => {
    const file = sessionSel.value;
    cmpData   = null;
    cmpRiders = [];
    cmpChart  = destroyChart(cmpChart);
    cmpSectorCharts.forEach(c => destroyChart(c));
    cmpSectorCharts = [];

    document.getElementById('cmp-chart-area').style.display = 'none';
    document.getElementById('cmp-step2').style.opacity = '0.3';
    document.getElementById('cmp-step2').style.pointerEvents = 'none';
    document.getElementById('cmp-rider-list').innerHTML = '';

    if (!file) return;

    try {
      setStatus('Loading…', 'loading');
      cmpData = await loadSession(file);
      setStatus(`${INDEX.session_count} sessions`, 'ok');
      renderCompareRiderList();
      document.getElementById('cmp-step2').style.opacity = '';
      document.getElementById('cmp-step2').style.pointerEvents = '';
    } catch (err) {
      setStatus('Error', 'error');
    }
  });

  document.querySelectorAll('.cmp-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cmp-mode-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cmpMode = btn.dataset.mode;
      document.getElementById('cmp-laptimes-panel').style.display = cmpMode === 'laptimes' ? '' : 'none';
      document.getElementById('cmp-sectors-panel').style.display  = cmpMode === 'sectors'  ? '' : 'none';
      if (cmpRiders.length >= 2) {
        if (cmpMode === 'laptimes') renderCompareChart();
        else renderSectorCharts();
      }
    });
  });
}

function renderCompareRiderList() {
  const list = document.getElementById('cmp-rider-list');
  list.innerHTML = cmpData.riders.map((r, i) => `
    <div class="rider-chip" data-pos="${r.position}">
      <span class="chip-color-dot" style="background:var(--text-3)"></span>
      <span>${fmtName(r.name)}</span>
      <span class="chip-bike" style="color:${mfrColor(r.bike)}">${r.bike || ''}</span>
    </div>`
  ).join('');

  list.addEventListener('click', e => {
    const chip = e.target.closest('.rider-chip');
    if (!chip) return;
    const pos   = parseInt(chip.dataset.pos);
    const rider = cmpData.riders.find(r => r.position === pos);
    if (!rider) return;

    const idx = cmpRiders.findIndex(x => x.rider.number === rider.number);
    if (idx >= 0) {
      cmpRiders.splice(idx, 1);
      chip.classList.remove('selected');
    } else if (cmpRiders.length < PALETTE.length) {
      const usedColors = new Set(cmpRiders.map(x => x.color));
      const color = PALETTE.find(c => !usedColors.has(c)) || PALETTE[0];
      cmpRiders.push({ rider, color });
      chip.classList.add('selected');
      chip.style.setProperty('--chip-color', color);
      chip.querySelector('.chip-color-dot').style.background = color;
    }

    if (cmpRiders.length >= 2) {
      if (cmpMode === 'sectors') renderSectorCharts();
      else renderCompareChart();
    } else {
      cmpChart = destroyChart(cmpChart);
      cmpSectorCharts.forEach(c => destroyChart(c));
      cmpSectorCharts = [];
      document.getElementById('cmp-chart-area').style.display = 'none';
    }
  });
}

function renderCompareChart() {
  const area = document.getElementById('cmp-chart-area');
  area.style.display = '';
  document.getElementById('cmp-laptimes-panel').style.display = '';
  document.getElementById('cmp-sectors-panel').style.display  = 'none';

  const canvas = document.getElementById('cmp-chart');
  cmpChart = destroyChart(cmpChart);

  const datasets = cmpRiders.map(({ rider, color }) => {
    const all = (rider.laps || []).filter(l => l.time_sec != null && l.type !== 'Cancelled');
    const flying = all.filter(l => l.type === 'Flying');
    const laps = flying.length > 0 ? flying : all;
    return {
      label: fmtName(rider.name),
      data: laps.map(l => ({ x: l.lap, y: l.time_sec })),
      borderColor: color,
      backgroundColor: color + '18',
      pointBackgroundColor: color,
      pointRadius: 4,
      pointHoverRadius: 7,
      tension: 0.3,
      fill: false,
    };
  });

  const allTimes = datasets.flatMap(d => d.data.map(p => p.y)).filter(Boolean);
  if (!allTimes.length) return;
  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const pad  = Math.max((maxT - minT) * 0.12, 0.5);

  cmpChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: mergeDeep({}, CHART_DEFAULTS, {
      plugins: {
        tooltip: {
          callbacks: {
            title: items => `Lap ${items[0].parsed.x}`,
            label: item  => ` ${item.dataset.label}: ${fmt(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { type: 'linear', title: { text: 'LAP' }, ticks: { stepSize: 1 } },
        y: { min: minT - pad, max: maxT + pad, title: { text: 'LAP TIME' }, ticks: { callback: v => fmt(v) } },
      },
    }),
  });

  // Legend
  document.getElementById('cmp-legend').innerHTML = cmpRiders.map(({ rider, color }) =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${fmtName(rider.name)}</span>
      <span class="legend-bike" style="color:${mfrColor(rider.bike)}">${rider.bike || ''}</span>
      <span class="legend-time">${fmt(rider.summary.best_lap_sec)}</span>
    </div>`
  ).join('');

  // Sector breakdown
  renderSectorComparison();
}

function renderSectorComparison() {
  const container = document.getElementById('cmp-sectors');
  if (cmpRiders.length < 2) { container.innerHTML = ''; return; }

  const html = [1,2,3,4].map(i => {
    const key = `best_t${i}`;
    const vals = cmpRiders.map(({ rider, color }) => ({
      name:  fmtName(rider.name),
      val:   rider.summary[key],
      color,
    })).filter(v => v.val != null);

    if (!vals.length) return '';

    const best = Math.min(...vals.map(v => v.val));
    const worst = Math.max(...vals.map(v => v.val));
    const range = worst - best || 0.001;

    const rows = vals.map(v => {
      const pct  = Math.round(((v.val - best) / range) * 100);
      const fill = 100 - pct;   // inverted: best fills 100%
      return `<div class="sector-bar-row">
        <span class="sector-bar-name" title="${v.name}">${v.name.split(' ').pop()}</span>
        <span class="sector-bar-track"><span class="sector-bar-fill" style="width:${fill}%;background:${v.color}"></span></span>
        <span class="sector-bar-val${v.val === best ? ' best-sector' : ''}">${fmtSec(v.val)}</span>
      </div>`;
    }).join('');

    return `<div class="sector-card">
      <div class="sector-card-title">SECTOR ${i}</div>
      ${rows}
    </div>`;
  }).join('');

  container.innerHTML = html;
}

function renderSectorCharts() {
  const area = document.getElementById('cmp-chart-area');
  area.style.display = '';
  document.getElementById('cmp-laptimes-panel').style.display = 'none';
  document.getElementById('cmp-sectors-panel').style.display  = '';

  // Destroy old sector charts
  cmpSectorCharts.forEach(c => destroyChart(c));
  cmpSectorCharts = [];

  // Shared legend
  document.getElementById('cmp-sector-legend').innerHTML = cmpRiders.map(({ rider, color }) =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${fmtName(rider.name)}</span>
      <span class="legend-bike" style="color:${mfrColor(rider.bike)}">${rider.bike || ''}</span>
    </div>`
  ).join('');

  const sectorKeys = ['t1', 't2', 't3', 't4'];
  const canvasIds  = ['cmp-s1-chart', 'cmp-s2-chart', 'cmp-s3-chart', 'cmp-s4-chart'];

  sectorKeys.forEach((key, i) => {
    const datasets = cmpRiders.map(({ rider, color }) => {
      const laps = (rider.laps || []).filter(l =>
        l.type === 'Flying' && l[key] != null && l[key] > 0
      );
      return {
        label:              fmtName(rider.name),
        data:               laps.map(l => ({ x: l.lap, y: l[key] })),
        borderColor:        color,
        backgroundColor:    color + '18',
        pointBackgroundColor: color,
        pointRadius:        3,
        pointHoverRadius:   6,
        tension:            0.3,
        fill:               false,
      };
    });

    const allVals = datasets.flatMap(d => d.data.map(p => p.y));
    if (!allVals.length) return;
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const pad  = Math.max((maxV - minV) * 0.15, 0.05);

    const ctx = document.getElementById(canvasIds[i]).getContext('2d');
    cmpSectorCharts.push(new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: mergeDeep({}, CHART_DEFAULTS, {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => `Lap ${items[0].parsed.x}`,
              label: item  => ` ${item.dataset.label}: ${fmtSec(item.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { type: 'linear', title: { display: false }, ticks: { stepSize: 1, maxTicksLimit: 10 } },
          y: {
            min: minV - pad,
            max: maxV + pad,
            title: { display: false },
            ticks: { callback: v => fmtSec(v) },
          },
        },
      }),
    }));
  });

  // Best sector summary table
  const bestPerSector = sectorKeys.map(key => {
    const vals = cmpRiders.map(({ rider }) => {
      const flying = (rider.laps || []).filter(l => l.type === 'Flying' && l[key] > 0);
      return flying.length ? Math.min(...flying.map(l => l[key])) : null;
    });
    const min = Math.min(...vals.filter(v => v != null));
    return { vals, min };
  });

  const headerCells = sectorKeys.map((_, i) => `<th>Best T${i + 1}</th>`).join('');
  const rows = cmpRiders.map(({ rider, color }, ri) => {
    const cells = sectorKeys.map((key, si) => {
      const val = bestPerSector[si].vals[ri];
      const isBest = val != null && val === bestPerSector[si].min;
      return `<td class="${isBest ? 'best-sector' : ''}">${val != null ? fmtSec(val) : '—'}</td>`;
    }).join('');
    return `<tr>
      <td class="rider-name-cell">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>
        ${fmtName(rider.name)}
      </td>
      ${cells}
    </tr>`;
  }).join('');

  document.getElementById('cmp-sector-best').innerHTML =
    `<table><thead><tr><th>Rider</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRENDS VIEW
// ══════════════════════════════════════════════════════════════════════════════
function initTrendsView() {
  // Populate year dropdown
  const years = [...new Set(INDEX.sessions.map(s => s.year))].sort((a,b) => b-a);
  document.getElementById('trends-year').innerHTML =
    '<option value="">All Years</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');

  const riderInput  = document.getElementById('trends-rider-input');
  const suggestions = document.getElementById('trends-rider-suggestions');
  const loadBtn     = document.getElementById('trends-load-btn');

  // Build rider name index lazily from files already in cache
  const getRiderNames = () => {
    const names = new Set();
    FILE_CACHE.forEach((data, key) => {
      if (key.endsWith('.json') && data.riders) {
        data.riders.forEach(r => { if (r.name) names.add(r.name); });
      }
    });
    return [...names].sort();
  };

  riderInput.addEventListener('input', () => {
    const q = riderInput.value.trim().toLowerCase();
    trendsRiderName = '';
    loadBtn.disabled = true;

    if (q.length < 2) { suggestions.style.display = 'none'; return; }

    const matches = getRiderNames().filter(n => n.toLowerCase().includes(q)).slice(0, 12);
    if (!matches.length) { suggestions.style.display = 'none'; return; }

    suggestions.innerHTML = matches.map(n => {
      const display = fmtName(n);
      const hi = display.replace(new RegExp(`(${q})`, 'ig'), '<mark>$1</mark>');
      return `<div class="suggestion-item" data-name="${n}">${hi}</div>`;
    }).join('');
    suggestions.style.display = '';
  });

  suggestions.addEventListener('click', e => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    trendsRiderName = item.dataset.name;
    riderInput.value = fmtName(trendsRiderName);
    suggestions.style.display = 'none';
    loadBtn.disabled = false;
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.rider-autocomplete')) suggestions.style.display = 'none';
  });

  loadBtn.addEventListener('click', async () => {
    trendsYear = document.getElementById('trends-year').value;
    trendsType = document.getElementById('trends-session-type').value;
    if (!trendsRiderName) return;
    await renderTrendsChart();
  });
}

async function renderTrendsChart() {
  const area  = document.getElementById('trends-chart-area');
  const ph    = document.getElementById('trends-placeholder');
  const table = document.getElementById('trends-table');
  area.style.display = 'none';
  ph.style.display   = 'flex';

  // Find matching sessions in index
  let sessions = INDEX.sessions.filter(s => {
    if (trendsYear && String(s.year) !== trendsYear) return false;
    if (trendsType && s.session !== trendsType) return false;
    return true;
  });

  if (!sessions.length) return;

  setStatus('Loading rider data…', 'loading');

  // Load all matching sessions (only ones not already cached are new fetches)
  const results = [];
  await Promise.allSettled(sessions.map(async s => {
    try {
      const data = await loadSession(s.file);
      const rider = data.riders?.find(r =>
        r.name?.toLowerCase() === trendsRiderName.toLowerCase());
      if (rider) {
        results.push({
          circuit: fmtTrack(s.track_folder),
          gp:      fmtTrack(s.track_folder),
          date:    s.date || '',
          session: s.session,
          best_sec: rider.summary.best_lap_sec,
          position: rider.position,
          bike:     rider.bike,
        });
      }
    } catch (_) {}
  }));

  setStatus(`${INDEX.session_count} sessions`, 'ok');

  if (!results.length) {
    ph.style.display = 'flex';
    ph.querySelector('p').textContent = `No data found for "${trendsRiderName}"`;
    return;
  }

  results.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return (SESSION_ORDER.indexOf(a.session)||99) - (SESSION_ORDER.indexOf(b.session)||99);
  });

  ph.style.display   = 'none';
  area.style.display = '';

  // Chart
  const canvas = document.getElementById('trends-chart');
  trendsChart = destroyChart(trendsChart);

  const labels = results.map(r => `${r.circuit}\n${r.session}`);
  const data   = results.map(r => r.best_sec);
  const color  = PALETTE[0];

  trendsChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: fmtName(trendsRiderName),
        data,
        borderColor: color,
        backgroundColor: color + '18',
        pointBackgroundColor: results.map(r => sessionColor(r.session)),
        pointRadius: 6,
        pointHoverRadius: 9,
        tension: 0.2,
        fill: true,
      }],
    },
    options: mergeDeep({}, CHART_DEFAULTS, {
      plugins: {
        tooltip: {
          callbacks: {
            title:  items  => results[items[0].dataIndex].gp,
            label:  item   => ` Best Lap: ${fmt(item.parsed.y)}`,
            footer: items  => `P${results[items[0].dataIndex].position} · ${results[items[0].dataIndex].bike || ''}`,
          },
        },
      },
      scales: {
        x: { title: { text: 'EVENT' }, ticks: { maxRotation: 45 } },
        y: { title: { text: 'BEST LAP' }, ticks: { callback: v => fmt(v) } },
      },
    }),
  });

  // Results table
  table.innerHTML = results.map(r => `
    <div class="trends-stat-card">
      <div class="tsc-circuit">${r.circuit}</div>
      <div class="tsc-time">${fmt(r.best_sec)}</div>
      <div class="tsc-pos">P${r.position} · <span style="color:${sessionColor(r.session)}">${r.session}</span></div>
    </div>`
  ).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
//  HOME VIEW
// ══════════════════════════════════════════════════════════════════════════════

const NAT_FLAG = {
  SPA:'🇪🇸', ITA:'🇮🇹', JPN:'🇯🇵', FRA:'🇫🇷', GBR:'🇬🇧', GER:'🇩🇪',
  AUS:'🇦🇺', POR:'🇵🇹', USA:'🇺🇸', ARG:'🇦🇷', RSA:'🇿🇦', THA:'🇹🇭',
  FIN:'🇫🇮', AUT:'🇦🇹', SUI:'🇨🇭', IND:'🇮🇳', MAL:'🇲🇾', BRA:'🇧🇷',
  NED:'🇳🇱', CZE:'🇨🇿', POL:'🇵🇱', EST:'🇪🇪', TUR:'🇹🇷', IDN:'🇮🇩',
};

function fmtDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function initHomeView() {
  const races = INDEX.sessions
    .filter(s => s.session === 'RAC' && s.class !== 'Moto2' && s.class !== 'Moto3')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!races.length) {
    const ph = document.getElementById('home-placeholder');
    ph.querySelector('.spinner').style.display = 'none';
    ph.querySelector('p').textContent = 'No race data found';
    return;
  }

  const meta = races[0];
  try {
    const data = await loadSession(meta.file);
    renderHomeView(meta, data);
  } catch (e) {
    document.getElementById('home-placeholder').querySelector('p').textContent = 'Could not load race data';
  }
}

function renderHomeView(meta, data) {
  document.getElementById('home-placeholder').style.display = 'none';
  const content = document.getElementById('home-content');
  content.style.display = '';

  // ── Header ───────────────────────────────────────────────────────────────
  document.getElementById('home-race-name').textContent = fmtTrack(meta.track_folder);
  document.getElementById('home-race-sub').innerHTML =
    `<span class="home-race-year">${meta.year}</span>
     <span>${fmtDate(meta.date)}</span>
     <span class="session-badge" style="background:${sessionColor('RAC')}">RACE</span>`;

  // ── Podium riders ─────────────────────────────────────────────────────────
  const podium = (data.riders || [])
    .filter(r => r.position >= 1 && r.position <= 3)
    .sort((a, b) => a.position - b.position);

  if (!podium.length) return;

  // Attach computed stats
  podium.forEach(r => {
    const times = (r.laps || [])
      .filter(l => l.type === 'Flying' && l.time_sec)
      .map(l => l.time_sec)
      .sort((a, b) => a - b);
    r._median = times.length ? times[Math.floor(times.length / 2)] : null;
  });

  const p1sec = podium[0].summary?.best_lap_sec;
  const gapStr = r => {
    if (r.position === 1) return 'LEADER';
    const g = r.summary?.best_lap_sec != null && p1sec != null
      ? r.summary.best_lap_sec - p1sec : null;
    return g != null ? `+${g.toFixed(3)}s` : '—';
  };

  // Classic stepped display: P2 · P1 · P3
  const stepped = [podium[1], podium[0], podium[2]].filter(Boolean);
  const posClass = { 1: 'podium-p1', 2: 'podium-p2', 3: 'podium-p3' };
  const posLabel = { 1: '🥇 P1', 2: '🥈 P2', 3: '🥉 P3' };

  document.getElementById('home-podium').innerHTML = stepped.map(r => {
    const flag = NAT_FLAG[r.nationality] || '';
    const col  = mfrColor(r.bike);
    return `<div class="podium-card ${posClass[r.position] || ''}">
      <div class="podium-pos">${posLabel[r.position] || `P${r.position}`}</div>
      <div class="podium-name">${fmtName(r.name)}</div>
      <div class="podium-nat">${flag} ${r.nationality || ''}</div>
      <div class="podium-team">${r.team || ''}</div>
      <div class="podium-bike" style="color:${col}">${r.bike || ''}</div>
      <div class="podium-lap">${r.summary?.best_lap || '—'}</div>
      <div class="podium-gap ${r.position === 1 ? 'podium-gap-winner' : ''}">${gapStr(r)}</div>
    </div>`;
  }).join('');

  // ── Stats table ───────────────────────────────────────────────────────────
  const bestSec = key => Math.min(...podium.map(r => r.summary?.[key]).filter(Boolean));
  const dSec = (v, b) => v == null ? null : v - b;
  const fmtDelta = (v, b) => {
    if (v == null || b == null) return '—';
    const d = v - b;
    return d < 0.0005 ? v.toFixed(3) + 's' : `+${d.toFixed(3)}s`;
  };

  const bT1 = bestSec('best_t1'), bT2 = bestSec('best_t2'),
        bT3 = bestSec('best_t3'), bT4 = bestSec('best_t4');

  const rows = [
    { label: 'Best Lap',    vals: podium.map(r => r.summary?.best_lap || '—'),
      mets: podium.map(r => r.summary?.best_lap_sec) },
    { label: 'Gap (best lap)', vals: podium.map(r => gapStr(r)),
      mets: podium.map(r => r.position === 1 ? 0 : (r.summary?.best_lap_sec != null && p1sec != null ? r.summary.best_lap_sec - p1sec : null)) },
    { label: 'Race Pace (median)', vals: podium.map(r => r._median ? fmt(r._median) : '—'),
      mets: podium.map(r => r._median) },
    { label: 'Total Laps', vals: podium.map(r => r.summary?.total_laps ?? '—'),
      mets: podium.map(r => -(r.summary?.total_laps || 0)) },
    { label: 'Best T1', vals: podium.map(r => fmtDelta(r.summary?.best_t1, bT1)),
      mets: podium.map(r => dSec(r.summary?.best_t1, bT1)) },
    { label: 'Best T2', vals: podium.map(r => fmtDelta(r.summary?.best_t2, bT2)),
      mets: podium.map(r => dSec(r.summary?.best_t2, bT2)) },
    { label: 'Best T3', vals: podium.map(r => fmtDelta(r.summary?.best_t3, bT3)),
      mets: podium.map(r => dSec(r.summary?.best_t3, bT3)) },
    { label: 'Best T4', vals: podium.map(r => fmtDelta(r.summary?.best_t4, bT4)),
      mets: podium.map(r => dSec(r.summary?.best_t4, bT4)) },
  ];

  const thNames = podium.map(r =>
    `<th><span style="color:${mfrColor(r.bike)}">${posLabel[r.position]}</span><br>
     <span style="font-weight:700;color:var(--text-1)">${fmtName(r.name.split(' ').slice(-1)[0])}</span></th>`
  ).join('');

  const bodyRows = rows.map(row => {
    const valid = row.mets.filter(v => v != null && isFinite(v));
    const best  = valid.length ? Math.min(...valid) : null;
    const tds   = podium.map((_, i) => {
      const isBest = best != null && Math.abs((row.mets[i] ?? Infinity) - best) < 0.0001;
      return `<td class="${isBest ? 'stats-best' : ''}">${row.vals[i]}</td>`;
    }).join('');
    return `<tr><td class="stats-label">${row.label}</td>${tds}</tr>`;
  }).join('');

  document.getElementById('home-stats-table').innerHTML =
    `<table class="home-stats-table">
       <thead><tr><th></th>${thNames}</tr></thead>
       <tbody>${bodyRows}</tbody>
     </table>`;

  // ── View full session link ─────────────────────────────────────────────────
  const link = document.getElementById('home-session-link');
  link.onclick = e => { e.preventDefault(); openSessionDetail(meta.file); showView('sessions'); };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANUFACTURERS VIEW
// ══════════════════════════════════════════════════════════════════════════════

// ── Stat helpers ──────────────────────────────────────────────────────────────
function mfrAvg(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function mfrMedian(arr) {
  const v = [...arr.filter(x => x != null && isFinite(x))].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function mfrSD(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length < 2) return null;
  const mu = mfrAvg(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length);
}
function mfrPaceDeg(lapsBySessRider) {
  // lapsBySessRider: array of flying-lap-time arrays, one per rider per session
  const deltas = [];
  for (const times of lapsBySessRider) {
    if (times.length < 6) continue;
    const n = Math.max(3, Math.floor(times.length * 0.25));
    const early = mfrAvg(times.slice(0, n));
    const late  = mfrAvg(times.slice(-n));
    if (early != null && late != null) deltas.push(late - early);
  }
  return deltas.length ? mfrAvg(deltas) : null;
}

// ── Heat colouring helpers ────────────────────────────────────────────────────
// ratio 0 = best (green), 1 = worst (red). Returns bg rgba string.
function heatBg(ratio) {
  if (ratio == null) return '';
  const r = Math.round(220 * ratio);
  const g = Math.round(180 * (1 - ratio));
  return `rgba(${r},${g},0,0.22)`;
}
function heatFg(ratio) {
  if (ratio == null) return '';
  if (ratio <= 0.05) return 'var(--green)';
  if (ratio >= 0.85) return '#ff4455';
  return '';
}
// Apply heat to a column of cells given values (lower = better unless invert).
function applyHeat(cells, values, { invert = false } = {}) {
  const valid = values.filter(v => v != null && isFinite(v));
  if (!valid.length) return;
  const mn = Math.min(...valid), mx = Math.max(...valid);
  const span = mx - mn || 1;
  cells.forEach((td, i) => {
    if (values[i] == null) return;
    let ratio = (values[i] - mn) / span;
    if (invert) ratio = 1 - ratio;
    td.style.background = heatBg(ratio);
    td.style.color      = heatFg(ratio) || td.style.color;
  });
}

function initManufacturersView() {
  const years = [...new Set(INDEX.sessions.map(s => s.year))].sort((a, b) => b - a);
  document.getElementById('mfr-year').innerHTML =
    '<option value="">Select year…</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');

  document.getElementById('mfr-year').addEventListener('change', () => {
    const yr = document.getElementById('mfr-year').value;
    const circuits = sortedUnique(
      INDEX.sessions.filter(s => String(s.year) === yr).map(s => s.track_folder)
    );
    document.getElementById('mfr-circuit').innerHTML =
      '<option value="">All Circuits</option>' +
      circuits.map(c => `<option value="${c}">${fmtTrack(c)}</option>`).join('');
  });

  document.getElementById('mfr-load-btn').addEventListener('click', renderManufacturersView);
}

async function renderManufacturersView() {
  const year        = document.getElementById('mfr-year').value;
  const circuit     = document.getElementById('mfr-circuit').value;
  const sessionType = document.getElementById('mfr-session-type').value;

  const ph         = document.getElementById('mfr-placeholder');
  const tableWrap  = document.getElementById('mfr-table-wrap');
  const chartsArea = document.getElementById('mfr-charts-area');

  if (!year) {
    ph.style.display = 'flex';
    tableWrap.innerHTML = '';
    chartsArea.style.display = 'none';
    return;
  }

  ph.style.display         = 'none';
  chartsArea.style.display = 'none';
  tableWrap.innerHTML      = '<div class="loading-overlay" style="position:static;height:80px"><div class="spinner"></div></div>';

  let sessions = INDEX.sessions.filter(s => String(s.year) === year && s.class !== 'Moto2' && s.class !== 'Moto3');
  if (circuit)     sessions = sessions.filter(s => s.track_folder === circuit);
  if (sessionType) sessions = sessions.filter(s => s.session === sessionType);

  const isRacePace = !sessionType || sessionType === 'RAC' || sessionType === 'SPR';

  setStatus('Loading manufacturer data…', 'loading');

  // ── Aggregate per manufacturer ─────────────────────────────────────────────
  // byMfr[mfr] = { riders, flyingLaps, t1s, t2s, t3s, t4s, speeds, bestLapSec,
  //                degGroups (array of time-ordered lap arrays per rider-session) }
  const byMfr = {};

  await Promise.allSettled(sessions.map(async s => {
    try {
      const data = await loadSession(s.file);
      (data.riders || []).forEach(r => {
        const mfr = (r.bike || 'UNKNOWN').toUpperCase().split(' ')[0];
        if (!byMfr[mfr]) byMfr[mfr] = {
          riders: new Set(), flyingLaps: [], t1s: [], t2s: [], t3s: [], t4s: [],
          speeds: [], bestLapSec: Infinity, degGroups: [],
        };
        const d = byMfr[mfr];
        d.riders.add(r.name);

        // Best lap from summary
        if (r.summary?.best_lap_sec != null && r.summary.best_lap_sec < d.bestLapSec)
          d.bestLapSec = r.summary.best_lap_sec;

        // Per-lap detail
        const flying = (r.laps || []).filter(l => l.type === 'Flying' && l.time_sec);
        flying.forEach(l => {
          d.flyingLaps.push(l.time_sec);
          if (l.t1 > 0) d.t1s.push(l.t1);
          if (l.t2 > 0) d.t2s.push(l.t2);
          if (l.t3 > 0) d.t3s.push(l.t3);
          if (l.t4 > 0) d.t4s.push(l.t4);
          // Filter obviously-wrong speed values (parser artefact: <100 km/h)
          if (l.top_speed_kmh > 100) d.speeds.push(l.top_speed_kmh);
        });

        // Pace degradation group (sorted by lap number within run)
        if (isRacePace && flying.length >= 5) {
          const ordered = [...flying].sort((a, b) => (a.run - b.run) || (a.lap - b.lap));
          d.degGroups.push(ordered.map(l => l.time_sec));
        }
      });
    } catch (_) {}
  }));

  setStatus(`${INDEX.session_count} sessions`, 'ok');

  // ── Build metric objects ───────────────────────────────────────────────────
  const mfrData = Object.entries(byMfr)
    .filter(([, d]) => d.flyingLaps.length > 0)
    .map(([mfr, d]) => ({
      mfr,
      color:      mfrColor(mfr),
      riders:     [...d.riders].sort(),
      lapCount:   d.flyingLaps.length,
      bestLap:    d.bestLapSec < Infinity ? d.bestLapSec : null,
      medianLap:  mfrMedian(d.flyingLaps),
      consistency: mfrSD(d.flyingLaps),   // lower = better
      avgT1: mfrAvg(d.t1s), avgT2: mfrAvg(d.t2s),
      avgT3: mfrAvg(d.t3s), avgT4: mfrAvg(d.t4s),
      avgSpeed: d.speeds.length ? mfrAvg(d.speeds) : null,
      maxSpeed: d.speeds.length ? Math.max(...d.speeds) : null,
      paceDeg:  mfrPaceDeg(d.degGroups),
    }))
    .sort((a, b) => (a.medianLap ?? 999) - (b.medianLap ?? 999));

  if (!mfrData.length) {
    tableWrap.innerHTML = '<p style="color:var(--text-3);padding:20px">No lap data found for this selection.</p>';
    return;
  }

  // ── Sector deltas (best sector across all manufacturers = 0) ──────────────
  const bestT1 = Math.min(...mfrData.map(d => d.avgT1).filter(Boolean));
  const bestT2 = Math.min(...mfrData.map(d => d.avgT2).filter(Boolean));
  const bestT3 = Math.min(...mfrData.map(d => d.avgT3).filter(Boolean));
  const bestT4 = Math.min(...mfrData.map(d => d.avgT4).filter(Boolean));
  const fmtDelta = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3) + 's';
  const fmtSec   = v => v == null ? '—' : v.toFixed(3) + 's';

  const hasDeg   = mfrData.some(d => d.paceDeg != null);
  const hasSpeed = mfrData.some(d => d.avgSpeed != null);

  // ── Render table ──────────────────────────────────────────────────────────
  const degHeader = hasDeg
    ? `<th class="th-deg" title="Avg lap time change from first 25% of stint to last 25%. Positive = tyre deg.">PACE DEG</th>` : '';

  tableWrap.innerHTML = `
    <div class="mfr-table-wrap">
      <table class="mfr-table">
        <thead>
          <tr>
            <th>MANUFACTURER</th>
            <th>RIDERS</th>
            <th title="Fastest single flying lap">BEST LAP</th>
            <th title="Median of all flying laps — more robust than average">MEDIAN LAP</th>
            <th title="Lap time standard deviation — lower means more consistent">CONSISTENCY</th>
            <th class="th-sector" title="Avg Sector 1 time delta vs fastest manufacturer">T1 Δ</th>
            <th class="th-sector" title="Avg Sector 2 time delta vs fastest manufacturer">T2 Δ</th>
            <th class="th-sector" title="Avg Sector 3 time delta vs fastest manufacturer">T3 Δ</th>
            <th class="th-sector" title="Avg Sector 4 time delta vs fastest manufacturer">T4 Δ</th>
            ${hasSpeed ? `<th class="th-speed" title="Average top speed across all flying laps">AVG SPEED</th>` : ''}
            ${hasSpeed ? `<th class="th-speed" title="Maximum recorded top speed">MAX SPEED</th>` : ''}
            ${degHeader}
            <th style="color:var(--text-3)">LAPS</th>
          </tr>
        </thead>
        <tbody>
          ${mfrData.map(d => {
            const d1 = d.avgT1 != null ? d.avgT1 - bestT1 : null;
            const d2 = d.avgT2 != null ? d.avgT2 - bestT2 : null;
            const d3 = d.avgT3 != null ? d.avgT3 - bestT3 : null;
            const d4 = d.avgT4 != null ? d.avgT4 - bestT4 : null;
            const degStr = d.paceDeg == null ? '—'
              : (d.paceDeg >= 0 ? '+' : '') + d.paceDeg.toFixed(3) + 's';
            const speedAvg = d.avgSpeed ? d.avgSpeed.toFixed(1) + ' km/h' : '—';
            const speedMax = d.maxSpeed ? d.maxSpeed.toFixed(1) + ' km/h' : '—';
            return `<tr>
              <td style="color:${d.color}">${d.mfr}</td>
              <td class="td-riders" title="${d.riders.join(', ')}">${d.riders.length} rider${d.riders.length !== 1 ? 's' : ''}</td>
              <td class="td-best">${fmt(d.bestLap)}</td>
              <td>${fmt(d.medianLap)}</td>
              <td class="td-consistency">${d.consistency != null ? (d.consistency * 1000).toFixed(0) + ' ms' : '—'}</td>
              <td class="td-sect td-s1">${fmtDelta(d1)}</td>
              <td class="td-sect td-s2">${fmtDelta(d2)}</td>
              <td class="td-sect td-s3">${fmtDelta(d3)}</td>
              <td class="td-sect td-s4">${fmtDelta(d4)}</td>
              ${hasSpeed ? `<td class="td-speed-avg">${speedAvg}</td>` : ''}
              ${hasSpeed ? `<td class="td-speed-max">${speedMax}</td>` : ''}
              ${hasDeg   ? `<td class="td-deg">${degStr}</td>` : ''}
              <td style="color:var(--text-3);font-size:11px">${d.lapCount}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // ── Apply heat colouring per column ───────────────────────────────────────
  const rows = [...tableWrap.querySelectorAll('tbody tr')];
  const col  = cls => rows.map(r => r.querySelector(`.${cls}`));

  // Median lap: lower = better
  applyHeat(col('td-best'),        mfrData.map(d => d.bestLap));
  // Consistency: lower std dev = better
  applyHeat(col('td-consistency'), mfrData.map(d => d.consistency));
  // Sector deltas: lower delta = better
  applyHeat(col('td-s1'), mfrData.map(d => d.avgT1 != null ? d.avgT1 - bestT1 : null));
  applyHeat(col('td-s2'), mfrData.map(d => d.avgT2 != null ? d.avgT2 - bestT2 : null));
  applyHeat(col('td-s3'), mfrData.map(d => d.avgT3 != null ? d.avgT3 - bestT3 : null));
  applyHeat(col('td-s4'), mfrData.map(d => d.avgT4 != null ? d.avgT4 - bestT4 : null));
  // Speed: higher = better
  if (hasSpeed) {
    applyHeat(col('td-speed-avg'), mfrData.map(d => d.avgSpeed), { invert: true });
    applyHeat(col('td-speed-max'), mfrData.map(d => d.maxSpeed), { invert: true });
  }
  // Pace deg: lower (less degradation) = better
  if (hasDeg) applyHeat(col('td-deg'), mfrData.map(d => d.paceDeg));

  // ── Sector delta chart ────────────────────────────────────────────────────
  chartsArea.style.display = '';
  mfrChart = destroyChart(mfrChart);
  mfrSectorChart = destroyChart(mfrSectorChart);

  const sCtx = document.getElementById('mfr-sector-chart').getContext('2d');
  const sectors = ['T1', 'T2', 'T3', 'T4'];
  const bestSectors = [bestT1, bestT2, bestT3, bestT4];

  mfrSectorChart = new Chart(sCtx, {
    type: 'bar',
    data: {
      labels: sectors,
      datasets: mfrData.map(d => ({
        label: d.mfr,
        data: [
          d.avgT1 != null ? d.avgT1 - bestT1 : null,
          d.avgT2 != null ? d.avgT2 - bestT2 : null,
          d.avgT3 != null ? d.avgT3 - bestT3 : null,
          d.avgT4 != null ? d.avgT4 - bestT4 : null,
        ],
        backgroundColor: d.color + 'bb',
        borderColor: d.color,
        borderWidth: 1.5,
        borderRadius: 3,
      })),
    },
    options: mergeDeep({}, CHART_DEFAULTS, {
      plugins: {
        tooltip: {
          callbacks: {
            label: item => {
              const v = item.parsed.y;
              return ` ${item.dataset.label}: ${v != null ? (v >= 0 ? '+' : '') + v.toFixed(3) + 's' : '—'}`;
            },
          },
        },
      },
      scales: {
        x: { title: { text: 'SECTOR' } },
        y: {
          title: { text: 'DELTA (s)' },
          ticks: { callback: v => (v >= 0 ? '+' : '') + v.toFixed(3) },
        },
      },
    }),
  });

  // ── Speed chart ───────────────────────────────────────────────────────────
  if (hasSpeed) {
    const spCtx = document.getElementById('mfr-speed-chart').getContext('2d');
    const spSorted = [...mfrData].filter(d => d.avgSpeed).sort((a, b) => b.avgSpeed - a.avgSpeed);
    mfrChart = new Chart(spCtx, {
      type: 'bar',
      data: {
        labels: spSorted.map(d => d.mfr),
        datasets: [{
          label: 'Avg Speed',
          data: spSorted.map(d => d.avgSpeed),
          backgroundColor: spSorted.map(d => d.color + 'bb'),
          borderColor:     spSorted.map(d => d.color),
          borderWidth: 1.5,
          borderRadius: 3,
        }],
      },
      options: mergeDeep({}, CHART_DEFAULTS, {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: item => ` ${item.parsed.x?.toFixed(1)} km/h` } },
        },
        scales: {
          x: { title: { text: 'km/h' }, ticks: { callback: v => v.toFixed(0) } },
          y: { title: { display: false } },
        },
      }),
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════
function showView(name) {
  const detail = document.getElementById('view-session-detail');

  if (name === 'sessions') {
    // Restore the detail pane if it was open when we left
    if (detailPaneWasOpen) detail.classList.add('active');
  } else {
    // Park the detail pane so it doesn't cover other tabs
    detailPaneWasOpen = detail.classList.contains('active');
    detail.classList.remove('active');
  }

  document.querySelectorAll('.view:not(.view-detail)').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  const link = document.querySelector(`.nav-link[data-view="${name}"]`);
  if (view) view.classList.add('active');
  if (link) link.classList.add('active');
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════════════
async function init() {
  // Nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      showView(link.dataset.view);
    });
  });

  // Back button closes detail pane
  document.getElementById('back-btn').addEventListener('click', () => {
    document.getElementById('view-session-detail').classList.remove('active');
    detailPaneWasOpen = false;
  });

  // Rider table — single delegated listener, always reads live detailData
  document.getElementById('detail-rider-table').addEventListener('click', e => {
    if (!detailData) return;
    const row = e.target.closest('.rider-row');
    if (!row) return;
    const pos = parseInt(row.dataset.pos);
    const rider = detailData.riders.find(r => r.position === pos);
    if (!rider) return;

    const idx = detailSelectedRiders.findIndex(x => x.rider.position === rider.position);
    if (idx >= 0) {
      detailSelectedRiders.splice(idx, 1);
    } else if (detailSelectedRiders.length < PALETTE.length) {
      const usedColors = new Set(detailSelectedRiders.map(x => x.color));
      const color = PALETTE.find(c => !usedColors.has(c)) || PALETTE[0];
      detailSelectedRiders.push({ rider, color });
    }
    updateDetailRowHighlights();
    renderDetailChart();
  });

  // Flying / all laps toggle
  document.querySelectorAll('.chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      detailShowFlying = btn.dataset.type === 'flying';
      if (detailData) renderDetailChart();
    });
  });

  // Load index
  try {
    setStatus('Connecting…', 'loading');
    INDEX = await loadIndex();
    const n = INDEX.session_count || INDEX.sessions?.length || 0;
    setStatus(`${n} sessions`, 'ok');

    initHomeView();
    initSessionsView();
    initCompareView();
    initTrendsView();
    initManufacturersView();
  } catch (err) {
    setStatus('Cannot load data', 'error');
    document.getElementById('weekends-list').innerHTML =
      `<div class="empty-state">
        <strong>Could not load data/index.json</strong><br><br>
        Make sure you're running a local server:<br>
        <code style="color:var(--text-2);font-size:11px">python3 -m http.server 8080</code><br>
        then open <code style="color:var(--text-2);font-size:11px">http://localhost:8080/frontend/</code>
      </div>`;
    console.error('[MotoGP Analytics]', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
