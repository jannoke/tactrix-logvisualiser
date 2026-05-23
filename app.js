/* ====================================================================
   Tactrix / EvoScan Log Visualizer
   --------------------------------------------------------------------
   A single-file vanilla-JS app. Layout:
     1. State + constants
     2. CSV parsing + format detection
     3. UI wiring (file inputs, drag-drop, controls)
     4. Column picker rendering
     5. Chart rendering + updates
     6. Time-window slider
     7. Stats panel
     8. Presets + export
   ==================================================================== */

// ---------------------- 1. State ----------------------
const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
];

const state = {
  // Each dataset: { format, rows, columns, numericCols, timeCol, timeAbsCol, elapsedMin, elapsedMax }
  a: null,
  b: null,
  // selections: { [colName]: { selected: bool, multiplier: number, color: string } }
  selections: {},
  options: {
    formatOverride: 'auto',
    timeMode: 'elapsed',
    autoScale: false,
    knockThreshold: 2,
  },
  // Visible window in elapsed seconds (relative to dataset A start)
  window: { start: 0, end: 0 },
  chart: null,
};

// ---------------------- 2. CSV parsing ----------------------

/**
 * Convert a raw CSV cell to a number when it looks numeric.
 * Handles "2,000.00" (Tactrix style) by stripping commas.
 * Returns a number or null.
 */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'nan') return null;
  // Strip thousand-separator commas only if it looks like a number with commas as separators
  const cleaned = trimmed.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect file format from header names.
 */
function detectFormat(fields) {
  const lower = fields.map((f) => (f || '').toLowerCase());
  if (lower.includes('sample') && lower.includes('time')) return 'tactrix';
  if (lower.includes('logid') && lower.includes('logentrydate')) return 'evoscan';
  // Fallbacks
  if (lower.includes('logentryseconds')) return 'evoscan';
  if (lower.includes('rpm /20')) return 'tactrix';
  return 'unknown';
}

/**
 * Identify which column is the elapsed-seconds time, and which is the absolute timestamp.
 */
function identifyTimeColumns(format, fields) {
  if (format === 'tactrix') return { timeCol: 'time', timeAbsCol: null };
  if (format === 'evoscan') return { timeCol: 'LogEntrySeconds', timeAbsCol: 'LogEntryDate+LogEntryTime' };
  // Best-effort fallback for unknown format: pick the first numeric-ish column named like time
  const timeLike = fields.find((f) => /time|sec/i.test(f));
  return { timeCol: timeLike || fields[0], timeAbsCol: null };
}

/**
 * Build an absolute Date for an EvoScan row from date + time columns.
 * Returns ms-since-epoch or null.
 */
function evoAbsoluteMillis(row) {
  const d = row.LogEntryDate;   // "2026-05-17"
  const t = row.LogEntryTime;   // "12:25:15.38899"
  if (!d || !t) return null;
  const ms = Date.parse(`${d}T${t}Z`); // treat as UTC to avoid TZ shifts; only relative spacing matters
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse CSV text into a Dataset.
 */
async function parseCsv(file, overrideFormat = 'auto') {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = results.meta.fields || [];
        const rawRows = results.data;
        if (!fields.length || !rawRows.length) {
          reject(new Error('CSV appears empty or malformed.'));
          return;
        }

        // Detect format
        let format = overrideFormat;
        if (format === 'auto') format = detectFormat(fields);

        const { timeCol, timeAbsCol } = identifyTimeColumns(format, fields);

        // Convert rows: numeric where possible, leave strings otherwise
        const rows = rawRows.map((r) => {
          const out = {};
          for (const f of fields) {
            const v = r[f];
            const num = toNumber(v);
            out[f] = num !== null ? num : (v === undefined ? null : v);
          }
          return out;
        });

        // Determine which columns are mostly numeric (>=70% numeric values)
        const numericCols = [];
        for (const f of fields) {
          if (f === timeCol) continue;
          if (f === 'LogEntryDate' || f === 'LogEntryTime' || f === 'LogNotes' || f === 'LogID' || f === 'sample') continue;
          let numCount = 0, total = 0;
          for (const r of rows) {
            const v = r[f];
            if (v === null || v === undefined || v === '') continue;
            total++;
            if (typeof v === 'number') numCount++;
          }
          if (total >= 5 && numCount / total >= 0.7) numericCols.push(f);
        }

        // Compute elapsed min/max from timeCol
        let elapsedMin = Infinity, elapsedMax = -Infinity;
        for (const r of rows) {
          const t = r[timeCol];
          if (typeof t === 'number') {
            if (t < elapsedMin) elapsedMin = t;
            if (t > elapsedMax) elapsedMax = t;
          }
        }
        if (!Number.isFinite(elapsedMin)) elapsedMin = 0;
        if (!Number.isFinite(elapsedMax)) elapsedMax = 0;

        // For absolute mode, compute first absolute timestamp (EvoScan only) for alignment
        let absStartMs = null;
        if (timeAbsCol && rows.length) absStartMs = evoAbsoluteMillis(rows[0]);

        resolve({
          format,
          fields,
          rows,
          numericCols,
          timeCol,
          timeAbsCol,
          elapsedMin,
          elapsedMax,
          absStartMs,
          fileName: file.name,
        });
      },
      error: (err) => reject(err),
    });
  });
}

// ---------------------- 3. UI wiring ----------------------
const els = {
  dropA: document.getElementById('drop-a'),
  dropB: document.getElementById('drop-b'),
  fileA: document.getElementById('file-a'),
  fileB: document.getElementById('file-b'),
  infoA: document.getElementById('info-a'),
  infoB: document.getElementById('info-b'),
  clearB: document.getElementById('clear-b'),
  formatOverride: document.getElementById('format-override'),
  timeMode: document.getElementById('time-mode'),
  autoscale: document.getElementById('autoscale'),
  knockThreshold: document.getElementById('knock-threshold'),
  wotPreset: document.getElementById('wot-preset'),
  resetView: document.getElementById('reset-view'),
  exportPng: document.getElementById('export-png'),
  columnsSection: document.getElementById('columns-section'),
  columnsList: document.getElementById('columns-list'),
  windowSection: document.getElementById('window-section'),
  windowStart: document.getElementById('window-start'),
  windowEnd: document.getElementById('window-end'),
  windowStartLabel: document.getElementById('window-start-label'),
  windowEndLabel: document.getElementById('window-end-label'),
  windowFull: document.getElementById('window-full'),
  chartSection: document.getElementById('chart-section'),
  chartCanvas: document.getElementById('chart'),
  statsSection: document.getElementById('stats-section'),
  statsTable: document.getElementById('stats-table'),
};

function wireDropZone(zone, input) {
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); })
  );
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    }
  });
}

wireDropZone(els.dropA, els.fileA);
wireDropZone(els.dropB, els.fileB);

els.fileA.addEventListener('change', (e) => loadFile(e.target.files[0], 'a'));
els.fileB.addEventListener('change', (e) => loadFile(e.target.files[0], 'b'));

els.clearB.addEventListener('click', () => {
  state.b = null;
  els.fileB.value = '';
  els.infoB.innerHTML = '';
  els.clearB.hidden = true;
  updateChart();
  updateStats();
});

els.formatOverride.addEventListener('change', async () => {
  state.options.formatOverride = els.formatOverride.value;
  // Reload current files with the new override
  if (state.a) {
    const reloaded = await parseCsvFromBlob(state.a.fileName, state.a.rawText, state.options.formatOverride);
    if (reloaded) state.a = reloaded;
  }
  if (state.b) {
    const reloaded = await parseCsvFromBlob(state.b.fileName, state.b.rawText, state.options.formatOverride);
    if (reloaded) state.b = reloaded;
  }
  renderAfterLoad();
});

els.timeMode.addEventListener('change', () => {
  state.options.timeMode = els.timeMode.value;
  updateChart();
});

els.autoscale.addEventListener('change', () => {
  state.options.autoScale = els.autoscale.checked;
  updateChart();
  updateStats();
});

els.knockThreshold.addEventListener('input', () => {
  state.options.knockThreshold = parseFloat(els.knockThreshold.value) || 0;
  updateChart();
});

els.windowStart.addEventListener('input', onWindowChanged);
els.windowEnd.addEventListener('input', onWindowChanged);
els.windowFull.addEventListener('click', () => {
  if (!state.a) return;
  els.windowStart.value = 0;
  els.windowEnd.value = state.a.elapsedMax - state.a.elapsedMin;
  onWindowChanged();
});

els.resetView.addEventListener('click', () => {
  if (state.chart && state.chart.resetZoom) state.chart.resetZoom();
});

els.exportPng.addEventListener('click', () => {
  if (!state.chart) return;
  const url = state.chart.toBase64Image('image/png', 1);
  const a = document.createElement('a');
  a.href = url;
  a.download = `log-${Date.now()}.png`;
  a.click();
});

els.wotPreset.addEventListener('click', applyWotPreset);

/**
 * Re-parse a file from cached text (used when format override changes).
 */
async function parseCsvFromBlob(name, text, override) {
  const blob = new Blob([text], { type: 'text/csv' });
  // Papa.parse accepts a File or string; using a string is simpler here:
  return new Promise((resolve) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = results.meta.fields || [];
        const rawRows = results.data;
        let format = override;
        if (format === 'auto') format = detectFormat(fields);
        const { timeCol, timeAbsCol } = identifyTimeColumns(format, fields);
        const rows = rawRows.map((r) => {
          const out = {};
          for (const f of fields) {
            const v = r[f];
            const num = toNumber(v);
            out[f] = num !== null ? num : (v === undefined ? null : v);
          }
          return out;
        });
        const numericCols = [];
        for (const f of fields) {
          if (f === timeCol) continue;
          if (['LogEntryDate', 'LogEntryTime', 'LogNotes', 'LogID', 'sample'].includes(f)) continue;
          let numCount = 0, total = 0;
          for (const r of rows) {
            const v = r[f];
            if (v === null || v === undefined || v === '') continue;
            total++;
            if (typeof v === 'number') numCount++;
          }
          if (total >= 5 && numCount / total >= 0.7) numericCols.push(f);
        }
        let elapsedMin = Infinity, elapsedMax = -Infinity;
        for (const r of rows) {
          const t = r[timeCol];
          if (typeof t === 'number') {
            if (t < elapsedMin) elapsedMin = t;
            if (t > elapsedMax) elapsedMax = t;
          }
        }
        if (!Number.isFinite(elapsedMin)) elapsedMin = 0;
        if (!Number.isFinite(elapsedMax)) elapsedMax = 0;
        let absStartMs = null;
        if (timeAbsCol && rows.length) absStartMs = evoAbsoluteMillis(rows[0]);
        resolve({ format, fields, rows, numericCols, timeCol, timeAbsCol, elapsedMin, elapsedMax, absStartMs, fileName: name, rawText: text });
      },
    });
  });
}

async function loadFile(file, slot) {
  if (!file) return;
  // Read text so we can re-parse later when user toggles format override
  const text = await file.text();
  const ds = await parseCsvFromBlob(file.name, text, state.options.formatOverride);
  ds.rawText = text;
  state[slot] = ds;
  renderFileInfo(slot);
  renderAfterLoad();
}

function renderFileInfo(slot) {
  const ds = state[slot];
  const el = slot === 'a' ? els.infoA : els.infoB;
  if (!ds) { el.innerHTML = ''; return; }
  const duration = (ds.elapsedMax - ds.elapsedMin).toFixed(2);
  el.innerHTML = `
    <div><b>${escapeHtml(ds.fileName)}</b></div>
    <div>Format: <b>${ds.format}</b> · ${ds.rows.length} rows · ${ds.numericCols.length} numeric cols</div>
    <div>Time range: <b>${duration}s</b> (${ds.elapsedMin.toFixed(2)}s → ${ds.elapsedMax.toFixed(2)}s)</div>
  `;
  if (slot === 'b') els.clearB.hidden = false;
}

function renderAfterLoad() {
  if (!state.a) return;
  // Reset window to full range of dataset A
  const span = state.a.elapsedMax - state.a.elapsedMin;
  els.windowStart.min = 0;
  els.windowStart.max = span;
  els.windowEnd.min = 0;
  els.windowEnd.max = span;
  els.windowStart.value = 0;
  els.windowEnd.value = span;
  state.window.start = 0;
  state.window.end = span;
  els.windowStartLabel.textContent = '0.00s';
  els.windowEndLabel.textContent = `${span.toFixed(2)}s`;

  renderColumnPicker();
  els.columnsSection.hidden = false;
  els.windowSection.hidden = false;
  els.chartSection.hidden = false;
  els.statsSection.hidden = false;

  if (slot_selectionsEmpty()) {
    // Auto-select sensible defaults
    autoSelectDefaults();
    renderColumnPicker();
  }

  updateChart();
  updateStats();
}

function slot_selectionsEmpty() {
  return !Object.values(state.selections).some((s) => s.selected);
}

/**
 * If nothing's selected yet, pick a small useful default set.
 */
function autoSelectDefaults() {
  const candidates = ['RPM', 'TPS', 'WideBandAF', 'AFRMAP', 'TimingAdv', 'KnockSum', 'Knock'];
  const ds = state.a;
  for (const name of candidates) {
    if (ds.numericCols.includes(name)) {
      ensureSelection(name);
      state.selections[name].selected = true;
      if (name === 'RPM') state.selections[name].multiplier = 0.01;
    }
  }
}

function ensureSelection(name) {
  if (!state.selections[name]) {
    const idx = Object.keys(state.selections).length;
    state.selections[name] = {
      selected: false,
      multiplier: 1,
      color: COLORS[idx % COLORS.length],
    };
  }
}

// ---------------------- 4. Column picker ----------------------
function renderColumnPicker() {
  const ds = state.a;
  els.columnsList.innerHTML = '';
  for (const name of ds.numericCols) {
    ensureSelection(name);
    const sel = state.selections[name];
    const row = document.createElement('label');
    row.className = 'col-row';
    row.innerHTML = `
      <input type="checkbox" ${sel.selected ? 'checked' : ''} />
      <input type="color" class="color-picker" value="${sel.color}" title="Change color" />
      <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <input type="number" value="${sel.multiplier}" step="0.01" title="Multiplier" />
    `;
    const [checkbox, colorInput, , multInput] = row.children;
    checkbox.addEventListener('change', () => {
      sel.selected = checkbox.checked;
      updateChart();
      updateStats();
    });
    colorInput.addEventListener('input', () => {
      sel.color = colorInput.value;
      updateChart();
      updateStats();
    });
    multInput.addEventListener('input', () => {
      const v = parseFloat(multInput.value);
      sel.multiplier = Number.isFinite(v) ? v : 1;
      updateChart();
      updateStats();
    });
    els.columnsList.appendChild(row);
  }
}

// ---------------------- 5. Chart ----------------------

/**
 * Build a list of (x, y) points for one column in one dataset.
 * x is either elapsed seconds (from dataset start) or absolute Date object.
 */
function buildSeries(ds, colName, mode) {
  const out = [];
  const start = ds.elapsedMin;
  for (const r of ds.rows) {
    const t = r[ds.timeCol];
    const v = r[colName];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    let x;
    if (mode === 'absolute' && ds.timeAbsCol) {
      const ms = evoAbsoluteMillis(r);
      if (ms === null) continue;
      x = new Date(ms);
    } else {
      x = t - start; // elapsed
    }
    out.push({ x, y: v });
  }
  return out;
}

function minMax(series) {
  let mn = Infinity, mx = -Infinity;
  for (const p of series) {
    if (p.y < mn) mn = p.y;
    if (p.y > mx) mx = p.y;
  }
  return [mn, mx];
}

function normalize(series, mn, mx) {
  if (mx === mn) return series.map((p) => ({ x: p.x, y: 0.5, _orig: p.y }));
  return series.map((p) => ({ x: p.x, y: (p.y - mn) / (mx - mn), _orig: p.y }));
}

function findKnockColumn(ds) {
  // Prefer common knock columns by name
  const prefer = ['KnockSum', 'KnockVoltage', 'Knock'];
  for (const p of prefer) if (ds.numericCols.includes(p)) return p;
  return ds.numericCols.find((c) => /knock/i.test(c)) || null;
}

function updateChart() {
  if (!state.a) return;
  const ds = state.a;
  const mode = state.options.timeMode;
  const datasets = [];

  const selectedNames = Object.entries(state.selections)
    .filter(([, s]) => s.selected)
    .map(([n]) => n);

  for (const name of selectedNames) {
    const sel = state.selections[name];

    // Dataset A
    if (ds.numericCols.includes(name)) {
      let pts = buildSeries(ds, name, mode);
      const label = state.options.autoScale
        ? `${name} (norm)`
        : (sel.multiplier !== 1 ? `${name} ×${sel.multiplier}` : name);
      let plotPts;
      if (state.options.autoScale) {
        const [mn, mx] = minMax(pts);
        plotPts = normalize(pts, mn, mx);
      } else {
        plotPts = pts.map((p) => ({ x: p.x, y: p.y * sel.multiplier, _orig: p.y }));
      }
      datasets.push({
        label,
        data: plotPts,
        borderColor: sel.color,
        backgroundColor: sel.color,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        spanGaps: true,
        _origColumn: name,
        _source: 'A',
      });
    }

    // Dataset B (overlay)
    if (state.b && state.b.numericCols.includes(name)) {
      let pts = buildSeries(state.b, name, mode);
      const label = `${name} [B]`;
      let plotPts;
      if (state.options.autoScale) {
        const [mn, mx] = minMax(pts);
        plotPts = normalize(pts, mn, mx);
      } else {
        plotPts = pts.map((p) => ({ x: p.x, y: p.y * sel.multiplier, _orig: p.y }));
      }
      datasets.push({
        label,
        data: plotPts,
        borderColor: sel.color,
        backgroundColor: sel.color,
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0.1,
        spanGaps: true,
        _origColumn: name,
        _source: 'B',
      });
    }
  }

  // Knock highlight overlay — scatter on a separate near-invisible y position
  const knockCol = findKnockColumn(ds);
  if (knockCol && state.options.knockThreshold > 0) {
    const knockSeries = buildSeries(ds, knockCol, mode);
    const overThreshold = knockSeries.filter((p) => p.y >= state.options.knockThreshold);
    if (overThreshold.length) {
      datasets.push({
        type: 'scatter',
        label: `Knock ≥ ${state.options.knockThreshold} (${knockCol})`,
        data: overThreshold.map((p) => ({ x: p.x, y: state.options.autoScale ? 1.02 : null, _orig: p.y })),
        borderColor: '#ff3344',
        backgroundColor: '#ff3344',
        pointRadius: 4,
        pointStyle: 'triangle',
        showLine: false,
        _knock: true,
      });
      // If not autoscale, place markers near the top of the chart's current data range:
      if (!state.options.autoScale) {
        let maxY = -Infinity;
        for (const d of datasets) {
          if (d._knock) continue;
          for (const p of d.data) if (p.y > maxY) maxY = p.y;
        }
        if (Number.isFinite(maxY)) {
          const last = datasets[datasets.length - 1];
          last.data = last.data.map((p) => ({ ...p, y: maxY * 1.05 }));
        }
      }
    }
  }

  const isAbsolute = mode === 'absolute' && ds.timeAbsCol;
  const xType = isAbsolute ? 'time' : 'linear';

  const xMin = state.window.start;
  const xMax = state.window.end;

  const config = {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: xType,
          ...(isAbsolute ? {} : { min: xMin, max: xMax }),
          title: { display: true, text: isAbsolute ? 'Time' : 'Elapsed seconds' },
          ticks: { color: '#8b96a8' },
          grid: { color: '#1f2733' },
        },
        y: {
          title: { display: true, text: state.options.autoScale ? 'Normalized (0–1)' : 'Value' },
          ticks: { color: '#8b96a8' },
          grid: { color: '#1f2733' },
        },
      },
      plugins: {
        legend: { labels: { color: '#c4cdda' } },
        tooltip: {
          mode: 'nearest',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const orig = ctx.raw && ctx.raw._orig !== undefined ? ctx.raw._orig : ctx.parsed.y;
              const fmt = (v) => Number.isFinite(v) ? v.toFixed(3).replace(/\.?0+$/, '') : v;
              return `${ctx.dataset.label}: ${fmt(orig)}`;
            },
          },
        },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
        },
      },
    },
  };

  if (state.chart) {
    state.chart.destroy();
  }
  state.chart = new Chart(els.chartCanvas.getContext('2d'), config);
}

// ---------------------- 6. Time window ----------------------
function onWindowChanged() {
  let s = parseFloat(els.windowStart.value);
  let e = parseFloat(els.windowEnd.value);
  if (e < s) { [s, e] = [e, s]; }
  state.window.start = s;
  state.window.end = e;
  els.windowStartLabel.textContent = `${s.toFixed(2)}s`;
  els.windowEndLabel.textContent = `${e.toFixed(2)}s`;
  if (state.chart && state.options.timeMode === 'elapsed') {
    state.chart.options.scales.x.min = s;
    state.chart.options.scales.x.max = e;
    state.chart.update('none');
  }
  updateStats();
}

// ---------------------- 7. Stats ----------------------
function updateStats() {
  if (!state.a) return;
  const ds = state.a;
  const start = ds.elapsedMin;
  const wStart = state.window.start;
  const wEnd = state.window.end;

  const selected = Object.entries(state.selections).filter(([, s]) => s.selected).map(([n]) => n);

  // Header
  let html = '<div class="head name">Series</div><div class="head num">Min</div><div class="head num">Avg</div><div class="head num">Max</div>';

  for (const name of selected) {
    let mn = Infinity, mx = -Infinity, sum = 0, count = 0;
    for (const r of ds.rows) {
      const t = r[ds.timeCol];
      const v = r[name];
      if (typeof t !== 'number' || typeof v !== 'number') continue;
      const elapsed = t - start;
      if (elapsed < wStart || elapsed > wEnd) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
      count++;
    }
    if (!count) {
      html += `<div class="name"><span class="swatch" style="background:${state.selections[name].color}"></span>${escapeHtml(name)}</div><div class="num">–</div><div class="num">–</div><div class="num">–</div>`;
      continue;
    }
    const avg = sum / count;
    html += `
      <div class="name"><span class="swatch" style="background:${state.selections[name].color}"></span>${escapeHtml(name)}</div>
      <div class="num">${fmt(mn)}</div>
      <div class="num">${fmt(avg)}</div>
      <div class="num">${fmt(mx)}</div>
    `;
  }

  els.statsTable.innerHTML = html;
}

function fmt(v) {
  if (!Number.isFinite(v)) return '–';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

// ---------------------- 8. Presets ----------------------
function applyWotPreset() {
  if (!state.a) return;
  // Clear all
  for (const k of Object.keys(state.selections)) state.selections[k].selected = false;

  // Pick the WOT-relevant columns that exist in the dataset
  const tactrixCols = ['TPS', 'RPM', 'TimingAdv', 'Knock', 'Airflow'];
  const evoCols = ['TPS', 'RPM', 'WideBandAF', 'AFRMAP', 'TimingAdv', 'KnockSum'];
  const choose = state.a.format === 'evoscan' ? evoCols : tactrixCols;
  for (const name of choose) {
    if (state.a.numericCols.includes(name)) {
      ensureSelection(name);
      state.selections[name].selected = true;
      if (name === 'RPM') state.selections[name].multiplier = 0.01;
      if (name === 'Airflow') state.selections[name].multiplier = 0.1;
    }
  }
  renderColumnPicker();
  updateChart();
  updateStats();
}

// ---------------------- Utilities ----------------------
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
