# Tactrix / EvoScan Log Visualizer

A small browser-based tool to plot car-tuning CSV logs from a Tactrix OpenPort cable or from EvoScan. Drag a `.csv` in, pick the columns you want to see, and explore the run.

Built as a single static page — no build step, no server. Open `index.html` in a browser, or host it on GitHub Pages.

## Features

- Drag-and-drop CSV upload
- Auto-detects Tactrix vs EvoScan format (manual override available)
- Pick any numeric columns to plot, with per-series multiplier (e.g. `RPM × 0.01` so it fits next to AFR)
- Auto-scale mode: normalizes every series to 0–1 so shapes are comparable regardless of unit
- Time-window slider plus mouse pan/scroll-wheel zoom inside the chart
- Toggle between elapsed seconds and absolute timestamp (EvoScan only)
- Knock highlighting — markers wherever a knock column crosses a threshold
- WOT preset — one click to plot TPS, RPM, AFR, timing, and knock
- Compare two logs side-by-side (second file plotted as dashed lines)
- Export the current chart as PNG
- Min / Avg / Max stats for the visible window, per series

## Usage

1. Open `index.html` in a modern browser (or visit the GitHub Pages URL).
2. Drag a CSV onto the **Primary log** box. The format auto-detects.
3. Tick the columns you want to plot in the **Columns** section. Adjust the multiplier next to any column if needed (e.g. set RPM to `0.01`).
4. Use the time-window sliders to zoom into a portion of the run, or drag inside the chart.
5. Optional — drag a second CSV into **Compare against** to overlay it.
6. Click **Export PNG** to save the chart.

## Supported formats

### Tactrix OpenPort

Headers begin with `sample,time,...`. Quoted values like `"2,000.00"` for RPM are handled.

### EvoScan

Headers begin with `LogID,LogEntryDate,LogEntryTime,LogEntrySeconds,...`. Absolute timestamps are reconstructed from the date+time columns.

## Project structure

- `index.html` — markup and CDN script tags
- `styles.css` — styling
- `app.js` — all logic (CSV parsing, charting, controls)

Libraries used (loaded from CDN, no install needed):

- [PapaParse](https://www.papaparse.com/) — CSV parsing
- [Chart.js](https://www.chartjs.org/) — charting
- [chartjs-plugin-zoom](https://www.chartjs.org/chartjs-plugin-zoom/latest/) — pan & zoom
- [Luxon](https://moment.github.io/luxon/) — time-axis adapter

## Running locally

Just open `index.html` in a browser. If your browser blocks loading local CSVs for any reason, serve the folder over a quick local server:

```bash
# Python 3
python -m http.server 8000

# or Node
npx serve .
```

Then go to `http://localhost:8000`.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. Repo → **Settings** → **Pages**.
3. Source: **Deploy from a branch**, Branch: **main**, Folder: **/(root)**, Save.
4. Wait a minute, then visit the URL GitHub shows.

## License

MIT — do whatever you like.
