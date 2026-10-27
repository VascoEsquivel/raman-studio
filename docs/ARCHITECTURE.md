# Raman Studio — architecture & module contracts

Static, client-side, no build step. Plain ES modules loaded by `index.html`.
Lab data never leaves the browser: nothing is uploaded, nothing is fetched except
the app's own files, the band libraries, Google Fonts and (only when a spreadsheet
is opened) SheetJS from its CDN.

```
index.html            app shell
css/                  tokens.css (themes) · app.css · print.css
js/main.js            boot + wiring           js/state.js   store + undo/redo
js/io/                file → spectra          js/process/   spectrum → cleaned spectrum
js/detect/            peak detection          js/match/     band libraries + matching
js/fit/               pseudo-Voigt + LM        js/analysis/  ratios + "read your spectrum"
js/render/            plot, labels, minimap   js/ui/        panels, dialogs, shortcuts
js/export/            PNG/SVG/CSV/report      js/sample/    synthetic demo spectra
data/libraries/       index.json manifest + band libraries (graphene-go.json)
tests/                browser unit tests (tests/index.html), fixtures
tools/                atlas extraction/verification, fixture generation, test runner, dev server
```

## Conventions (all modules)

- Named exports only. 2-space indent, semicolons, single quotes, JSDoc on every export.
  Comments explain *why* (PeakForge style), not what.
- **Pure modules** — `io` (except the SheetJS loader), `process`, `detect`, `match`,
  `fit`, `analysis`, `sample`, `export/csv.js`, `render/label-layout.js` — must not touch
  `document`, `window`, `localStorage` or the console. They take numbers in, give numbers out.
- Signal arrays: accept any array-like of numbers; return `Float64Array`.
- After import every spectrum has **ascending x** (cm⁻¹). Processing code may assume
  ascending x but not uniform spacing unless it says so.
- Throw `Error` with a user-readable message for unrecoverable input; collect
  recoverable problems in a `warnings: string[]` array.
- Relative imports only (the app is served from a subpath on GitHub Pages).
- Tests: `tests/<area>.<module>.test.js`, registered in `tests/suites.js`, using
  `tests/harness.js`. Run headless with `python tools/run_tests.py [--only prefix]`.

## Shared data shapes

```js
/** Spectrum — produced by io, consumed everywhere. */
{
  id: string,                 // unique within the session
  name: string,               // display name, e.g. "sample.xlsx · Sheet2 · Intensity 3"
  x: Float64Array,            // ascending Raman shift, cm⁻¹
  y: Float64Array,            // intensity
  xLabel: 'Raman shift', xUnit: 'cm⁻¹',
  yLabel: string,             // column header or 'Intensity'
  source: { file: string, format: string, sheet?: string, column?: string|number },
  meta: object,               // header key/values, e.g. { laserNm: 532, synthetic: true }
}

/** Table — intermediate result of text / spreadsheet parsing. */
{
  headers: string[],          // one per column ('' if none)
  columns: Float64Array[],    // numeric columns, NaN where a cell is not a number
  nRows: number,
  meta: { delimiter?, decimal?: '.'|',', headerLines?: string[], ... },
  warnings: string[],
}

/** Mapping — which columns are x and y. */
{
  x: number|null,             // column index of the wavenumber axis
  ys: number[],               // intensity column indices
  layout: 'columns'|'rows'|'long',
  //  columns: x in one column, one spectrum per other column (the usual export)
  //  rows:    transposed — first row is x, each further row is a spectrum
  //  long:    map export (X, Y, Wave, Intensity): spectra stacked, x repeats
  groupBy?: number[],         // long layout: coordinate columns identifying each spectrum
  confidence: number,         // 0..1
  reasons: string[],          // human-readable evidence, shown in the mapping dialog
}

/** ImportResult — what io/import.js returns for any file. */
{
  format: 'csv'|'tsv'|'txt'|'xlsx'|'xls'|'jcamp'|'spc',
  spectra: Spectrum[],        // empty when needsMapping and no usable guess
  needsMapping: boolean,      // true when confidence < CONFIDENT (0.6): show the mapping preview
  confidence: number,
  table?: Table, mapping?: Mapping,           // single-table formats
  sheets?: [{ name, table, mapping }],        // spreadsheets: one entry per sheet with data
  warnings: string[],
}

/** DetectedPeak — tier-1 detection. */
{ id: string, index: number, x: number, y: number, prominence: number,
  fwhm: number /* cm⁻¹ */, leftX: number, rightX: number, snr: number }

/** PreparedBand — a library band shifted for the selected laser. */
{ id, label, name, order: 'first'|'second',  // atlas `region`
  center: number,            // atlas posSort + shift
  shift: number,             // cm⁻¹ applied for laser vs reference excitation
  range: [lo, hi],           // atlas posText range + shift
  window: [lo, hi],          // range ± (tolerance + widen) — the match/fit window
  widen: number,             // extra half-width for bands with unknown dispersion
  fwhmSeed: number, dispersion: { cmPerEV, stated, widenWindow? }, band: object /* raw atlas band */ }

/** Assignment — a peak matched to a band. */
{ peakId, x, kind: 'band'|'region'|'unassigned', bandId: string|null,
  label: string,             // band label, region label, or 'unassigned'
  confidence: number,        // 0..1; 0 for unassigned
  delta: number|null,        // x − band centre, cm⁻¹
  alternatives: [{ bandId, label, confidence, delta }] }

/** FitComponent — tier-2 deconvolution result for one band. */
{ bandId, label, x0, w, h, g, area, se: { x0, w, h, g }, significant: boolean, windowIndex }
```

## io — `js/io/`

| module | exports |
|---|---|
| `spectrum.js` | `makeSpectrum({ x, y, name, source, meta, yLabel })` → Spectrum (sorts ascending, drops non-finite pairs, removes exact duplicate x by averaging, assigns id) |
| `parse-text.js` | `parseDelimitedText(text, { filename })` → Table. Auto-detects delimiter (tab, comma, semicolon, pipe, whitespace) and decimal comma; skips comment lines (`#`, `;`, `%`, `!`, `//`, `*`), blank lines and metadata blocks; finds the longest run of numeric rows with a consistent column count; the non-numeric line right above it becomes the header. Parses `key: value` / `key=value` header lines into `meta` (laser wavelength if present). |
| `detect-columns.js` | `CONFIDENT = 0.6`; `detectColumns(table)` → Mapping; `tableToSpectra(table, mapping, { file, format, sheet })` → Spectrum[] |
| `parse-jcamp.js` | `parseJcamp(text, { filename })` → ImportResult. JCAMP-DX 4.24/5: `##XYDATA=(X++(Y..Y))` with AFFN and ASDF compression (SQZ, DIF, DUP, with DIF Y-checks), `##XYPOINTS`/`##PEAK TABLE=(XY..XY)`, `##XFACTOR/YFACTOR/FIRSTX/LASTX/NPOINTS/DELTAX/XUNITS/YUNITS`, multi-block (`##BLOCKS`/LINK) files → one spectrum per block. XUNITS of 1/CM accepted; NANOMETERS reported as a warning (needs laser to convert). |
| `parse-spc.js` | `parseSpc(arrayBuffer, { filename })` → ImportResult. Thermo/Galactic SPC new format (0x4B, little-endian): single and multi-subfile, evenly spaced (ffirst/flast) and XY (TXVALS / TXYXYS) variants, 32-bit integer (exponent-scaled) and IEEE float Y. Old format (0x4D) → clear error. Experimental. |
| `parse-wdf.js` | `parseWdf(arrayBuffer, { filename })` → ImportResult (`needsMapping: false`, `confidence: 1`). Renishaw WiRE WDF: blocks of 4-char type, uint32 uid, uint64 size; header counts at 0x3C–0x5C, measurement type at 0x84 (1 single, 2 series, 3 map), laser wavenumber at 0x9C, title at 0xF0. DATA float32 spectra on one shared XLST axis (descending in the file, ascending after `makeSpectrum`); ORGN lists give stage X/Y/Z (µm); WMAP gives the grid. Map spectra carry `meta.map = { index, x, y, z, unit, grid: { nx, ny, x0, y0, dx, dy } }`; series spectra `meta.series = { index }`. `meta.header` holds Laser, Accumulations, Software, Measurement, Map and Title (the operator name at 0xD0 is not read); `meta.laserNm`; `meta.wdf = { measurement, capacity, count }`. Errors: too short, not WDF, spectral image (y-list length > 1), more than 20 000 spectra, truncated or missing DATA/XLST. Warnings: x unit other than Raman shift, more than 5000 spectra. |
| `parse-xlsx.js` | `SHEETJS_URL` (pinned 0.20.3 ESM); `loadSheetJS()` → module (dynamic import, cached); `parseWorkbook(arrayBuffer, XLSX, { filename })` → ImportResult with `sheets`. Cells that are numeric strings with decimal commas are converted. |
| `import.js` | `SUPPORTED_EXTENSIONS`; `importFile(file)` → Promise<ImportResult> (file = File or `{ name, arrayBuffer() }`). Dispatch by extension, confirmed by sniffing (JCAMP `##`, SPC byte 1 = 0x4B/0x4D, WDF `WDF1`, XLSX zip `PK`, XLS OLE `D0 CF 11 E0`). Text decoding: UTF-8, UTF-16 LE/BE by BOM, fallback windows-1252. `applyMapping(table, mapping, info)` → Spectrum[] |

Column detection scores each column: monotonic (either direction; allow tiny jitter),
roughly uniform spacing, and values overlapping 50–4000 cm⁻¹; header names like
*shift, wavenumber, raman, cm-1, wave, #wave* boost, *index, #, time* penalise. An integer
1..N index column must not win over a real wavenumber column.

## process — `js/process/`

| module | exports |
|---|---|
| `despike.js` | `despike(x, y, { threshold = 6, maxWidth = 15, minBandCm = null, companions = null, edits = null })` → `{ y, removed: [{ index, x, y, replacedY }], spikes: [{ start, end, xStart, xEnd, height, kind, misfit, share }], suspects: [{ …, kind, misfit, share }], restored: [{ …, kind, share }], info: { sigma, shotNoise, spacing, minBandPts, minBandCm, minBandAuto, maxWidth, threshold, companions } }` — model-based: candidates come from a hole predictor at every scale up to `maxWidth` points (σ from Whitaker–Hayes, signal-dependent); a candidate is removed only if no smooth model (quadratic background, optional step, one or two non-negative pseudo-Voigts with FWHM ≥ `minBandCm`, default 3 sample spacings) explains it, judged both statistically (χ²) and materially (share of its height), and it stands above its neighbours. `companions` (≥ 4 other spectra on the same x): a removed feature they share is put back (`restored` kind `recurring`), or labelled `artifact` if one point wide. `edits.keep` (cm⁻¹) restores removals (`kept`), `edits.zaps` ([lo, hi] cm⁻¹) interpolates by hand (spike kind `manual`). Spike kinds: `cosmic`, `artifact`, `manual`. `suspects` are features left in place that a person should judge. Runs ≤ 3 points are replaced by a quadratic through 2 clean points each side, longer runs and zaps by linear interpolation. The header comment documents every constant. |
| `baseline.js` | `BASELINE_METHODS = ['none','constant','linear','quadratic','als']`; `baselinePoly(x, y, { order, maxIter = 100, tol = 1e-3 })` (modified polyfit, Lieber & Mahadevan-Jansen 2003 — the fit is clipped under the data so peaks don't lift it; x normalised to u ∈ [0,1] as in PeakForge); `baselineALS(y, { lambda = 1e5, p = 0.01, maxIter = 10 })` (Eilers & Boelens 2005, banded O(n) solver); `computeBaseline(x, y, { method, lambda, p })` → Float64Array or null for 'none' |
| `smooth.js` | `sgCoefficients(window, order, deriv = 0)`; `savitzkyGolay(y, { window = 11, order = 3, deriv = 0 })` → Float64Array; edges by polynomial fit to the first/last window (scipy `mode='interp'`) |
| `normalize.js` | `normalize(x, y, { mode = 'none', window })` → `{ y, factor, ref }`; modes `none`, `max`, `band` (max within `window` [lo,hi], e.g. the G band), `area` (trapezoid ∫y dx = 1) |
| `pipeline.js` | `DEFAULT_SETTINGS`; `runPipeline(spectrum, settings, { bandWindow, companions, spikeEdits })` → Processed. `companions`: y arrays of other spectra on exactly this x, cropped with it and passed to despike when `settings.despike.useSet`; `spikeEdits`: `{ keep, zaps }` for despike. |

Pipeline order: crop → despike → baseline (on despiked) → smooth → normalize.

```js
DEFAULT_SETTINGS = {
  crop:      { on: false, lo: null, hi: null },
  despike:   { on: true, threshold: 6, maxWidth: 15, minBandCm: 0, useSet: true },   // minBandCm 0 = auto (3 spacings)
  baseline:  { on: true, method: 'als', lambda: 1e5, p: 0.01 },
  smooth:    { on: false, window: 11, order: 3 },
  normalize: { on: false, mode: 'max' },      // 'max' | 'band' | 'area'
}
Processed = {
  x, raw,                       // cropped input
  despiked, removed, spikes,    // after spike removal (raw units)
  suspects, restored, despikeInfo,   // despike's review lists and info (null when despike is off)
  baseline,                     // Float64Array (raw units) or null
  corrected,                    // despiked − baseline
  smoothed,                     // corrected, smoothed if enabled
  y,                            // final: smoothed / normFactor
  normFactor, normRef,          // e.g. 1, 'max', 'band', 'area'
  steps: { despike, baseline, smooth, normalize },   // booleans actually applied
  warnings: string[],
}
```

## detect — `js/detect/`

| module | exports |
|---|---|
| `find-peaks.js` | Faithful port of `scipy.signal.find_peaks` (SciPy 1.18): `findPeaks(x, { height, threshold, distance, prominence, width, wlen, relHeight = 0.5, plateauSize })` → `{ peaks: number[], properties }` with SciPy's snake_case property names; `localMaxima1d`, `selectByPeakDistance`, `peakProminences(x, peaks, wlen)`, `peakWidths(x, peaks, relHeight, prominenceData, wlen)`. Interval arguments are a number (minimum) or `[min, max]` with `null` for open ends, as in SciPy. Results are cross-checked against SciPy output in `tests/fixtures/find_peaks_vectors.json`. |
| `noise.js` | `estimateNoise(y)` — PeakForge's robust σ: median |Δy| / (0.6745·√2) |
| `detect.js` | `DEFAULT_DETECT = { sensitivity: 0.5, minWidthCm: 4, minDistanceCm: 8, maxPeaks: 30 }`; `sensitivityToK(s)` → prominence multiple of σ (s=0 → 50σ, s=1 → 3σ, log-spaced); `detectPeaks(x, y, opts)` → DetectedPeak[] sorted by x. Converts cm⁻¹ options to samples using the median spacing; min prominence = max(k·σ, 0.005·(max−min)); peak x refined by 3-point parabolic interpolation; fwhm from `peakWidths` at rel_height 0.5 via interpolated positions. |

## match — `js/match/`

| module | exports |
|---|---|
| `dispersion.js` | `photonEnergyEV(nm)` = 1239.841984 / nm; `dispersionShift(cmPerEV, laserNm, refNm)` = cmPerEV × (E(laser) − E(ref)) |
| `library.js` | `loadLibraries(baseUrl)` → `{ libraries, errors }` (reads `index.json`, then each file; invalid files are reported in `errors`, never thrown); `validateLibrary(obj)` → `{ ok, errors }`; `prepareLibrary(lib, { laserNm, toleranceCm })` → `{ library, laserNm, referenceNm, deltaEV, toleranceCm, bands: PreparedBand[], regions }` |
| `matcher.js` | `bandConfidence(x, preparedBand)` → `exp(−2·(d/dmax)²)` inside the window, 0 outside, where d = |x − centre| and dmax is the distance from the centre to the window edge on x's side; `matchPeaks(peaks, prepared)` → Assignment[] (same order as peaks) |

Matching rules: a band's window is its atlas range (shifted by `dispersion.cmPerEV × ΔE`)
± `toleranceCm`, plus `unknownDispersionAllowanceCmPerEV × |ΔE|` on each side for bands
whose dispersion the atlas doesn't state. Assignment is one-to-one, greedy by descending
confidence (ties → smaller |delta|). A peak left without a band gets `kind: 'region'` if it
falls in a library region (the sp³ C–H window) else `kind: 'unassigned'`. Every candidate
band (confidence > 0) appears in `alternatives`.

## fit — `js/fit/`

| module | exports |
|---|---|
| `profile.js` | PeakForge's WiRE-compatible linear pseudo-Voigt, **unchanged**: `FOURLN2`, `GAREA`, `LAREA`, `peakY(p, x)`, `peakArea(p)`, `peakType(p)` with `p = { x0, w, h, g }` (g = % Gaussian). Do not "upgrade" to a true Voigt — comparability with the instrument software is the point (regression: PeakForge's Curve 1 → area 225343). |
| `lm.js` | PeakForge's Levenberg–Marquardt, decoupled from global state but algorithmically identical (scale-based steps, inward finite differences at bounds, step clamp, λ schedule, χ²ᵣ·(JᵀJ)⁻¹ uncertainties, windowed fit quality). `fitPeaks({ x, y, peaks, baseline, weighting = 'unit', maxIter = 200 })` → FitResult; `evaluateModel(peaks, baseline, x)`; `fitQuality(x, y, model)`; `estimateNoise(y)` |
| `deconvolve.js` | `deconvolve(x, y, preparedBands, { fitDefaults, weighting = 'unit', maxIter = 300, select = true })` → Deconvolution — seeds one component per atlas band (atlas centre, `fwhmSeed`, height from the data), bounds centres to the band window and widths to `[fwhmMin, fwhmMax]`, heights ≥ 0, fits first- and second-order regions separately with a linear local baseline. With `fitDefaults.modelSelection` (`{ criterion: 'BIC', optional, closeCall }`) and `select`, every subset of a window's optional bands is fitted on the window the full set defines, and the lowest BIC = n·ln(χ²/n) + k·ln n wins (k = free parameters, χ² weighted). Left-out bands go to `skipped` with `selection: true` and the BIC cost of adding each back. |
| `uncertainty.js` | `ratioUncertainty(deconv, num, den, measure = 'height'\|'area')` → 1σ of num/den (or null) by first-order propagation through the window covariance; area gradient from the analytic pseudo-Voigt area. `covarianceOf(deconv, a, ka, b, kb)` → covariance of two component parameters (0 across windows or for a fixed parameter; null when the window's matrix is singular). A *fit-model standard uncertainty*: noise for the fitted model only, not model choice, and not a probability. |

```js
// fitPeaks input
peaks: [{ x0, w, h, g, lock?: { x0, w, h, g }, bounds?: { x0?: [lo,hi], w?: [lo,hi], h?: [lo,hi], g?: [lo,hi] }, ...passthrough }]
baseline: { mode: 'none'|'const'|'linear'|'quad', c0, c1, c2, fit: boolean, xMin, xMax }   // u = (x − xMin)/(xMax − xMin)
FitResult = {
  peaks,                       // copies with fitted values, `se` {x0,w,h,g} (null when locked) and `area`
  baseline,
  stats: { chiRed, r2, rmse, sigma, quality, qualityWorst, qualityAt, iters, ms, npar, n, conv },
  worstCorrelation,            // { rho, a, b } or null
  undersampled: number[],      // peak indices with < 4 points across the FWHM
  insignificant: number[],     // |h| < 2σ_h
  residual: Float64Array,      // y − model at the data x
  covariance,                  // { params: [{ peak, k }], matrix } = χ²ᵣ·(JᵀJ)⁻¹ over free parameters (peak −1: baseline), or null
}
Deconvolution = {
  windows: [{ lo, hi, bandIds, stats, baseline, residual: { x, r }, covariance,      // covariance params keyed { bandId, k }
    selection }],              // null, or { criterion, optional, kept, closeCall, models: [{ kept, n, k, bic, dBic }] best first,
                               //   runnerUp: { kept, dBic, components } when the next-best is within closeCall }
  components: FitComponent[],
  skipped: [{ bandId, reason, selection? }],   // selection: true = left out by model selection
  model(x) → number,           // NaN outside fitted windows
}
```

## analysis — `js/analysis/`

| module | exports |
|---|---|
| `ratios.js` | `computeRatios(prepared, { assignments, peaks, components, laserNm })` → RatioResult[] — one per `library.ratioMap` entry. Heights come from significant fit components when available, else from detected peaks matched to the band; areas only from fit components. I_D/I_G adds the atlas's Cançado crystallite size (Lₐ[nm] = (560/E_l⁴)·(I_D/I_G)⁻¹, E_l from the selected laser) and the G FWHM; I_D/I_D′ reports the nearest atlas reference value (13 / 7 / 3.5). |
| `workflow.js` | `evaluateWorkflow(prepared, { ratios, components, assignments, peaks, noiseSigma })` → `{ steps: [{ index, html, status: 'match'|'partial'|'no'|'info'|'insufficient', evidence: string[] }], summary }` — walks the atlas's eight steps with the measured numbers. Only numeric criteria the atlas states are used as thresholds (e.g. 2D FWHM < 30 cm⁻¹, I_2D/I_G ≥ 2); anything else is reported as a number for the user to judge. Library-specific: evaluates only for `graphene-go`; other libraries get their steps back as `info`. |
| `acquisition.js` | `acquisition(meta)` → `{ fields: [{ label, value, key }], laserNm, exposureS, accumulations, cosmicRayRemoval, hasHeader }` from `meta.header` (WiRE's SPC log lines, or the WDF reader's Measurement and Map fields; exposure converted only from WiRE's "Time: <ms>" form; operator and serial numbers are not surfaced). `qualityFlags(spectrum, acq)` → `[{ level: 'warn'|'info', id, text }]`: instrument cosmic-ray removal off (and single accumulation), maximum held over ≥ 3 points (saturation), the 16-bit ceiling, flat segments. Reports only; never changes data. |
| `map.js` | `bandHeight(x, y, lo, hi)` → height of the largest excess over a straight line joining the window edges (each edge the median of its 3 outermost points; WiRE's "signal to baseline"); NaN for fewer than 7 points in the window. `mapValues(spectra, num, den?)` → Float64Array, one value per spectrum; ratios are NaN where the denominator is ≤ `DEN_FLOOR` (0.05) of its largest height in the map. `correlation(a, b)` → `{ r, n }`, Pearson over points where both are finite (r NaN for n < 3 or a constant map). `layout(points)` → `{ xs, ys, nx, ny, cell, dx, dy }` (distinct stage coordinates within 1e-6 of the span; holes allowed). `RAMP` (13-step sequential blue) and `rampColor(t, dark)` (low values recede into the surface in both themes). |

```js
RatioResult = {
  ratioIndex, name, title,                 // atlas ratio card n / t (verbatim)
  num, den,                                // band ids
  height: { value, source: 'fit'|'detected', numValue, denValue, se } | null,   // se: fit-model 1σ, null for detected
  area:   { value, numValue, denValue, se } | null,
  classify?: { nearest, label, value },    // I_D / I_D′ only
  extras: { crystalliteSize?: [{ basis: 'height'|'area', valueNm, El, se }], gWidth?, twoDWidth? },
  missing: string[],                       // why parts could not be computed
}
```

## render — `js/render/`

`label-layout.js` (pure): `layoutLabels(items, opts)` → placements. Items
`{ id, ax, ay, w, h, priority }` (anchor = peak apex in px, box size in px); opts
`{ left, right, top, bottom, gap = 4, lift = 14, ceiling(xa, xb) → topmost trace y in px
over [xa, xb], maxTiers = 6 }`. Placement `{ id, x, y, cx, anchorX, anchorY, tier,
leader: [[x, y], …], overflow }`. Guarantees: no two boxes overlap (including `gap`), every
box sits above the trace beneath it, deterministic output. Leader lines avoid crossing
other boxes where possible.

The interactive plot draws traces on a `<canvas>` (fast zoom/pan for large spectra) with
an SVG overlay for axes, labels, leader lines and markers. Exports build a standalone SVG
from the same layout, so PNG/SVG match the screen.

## sample, export

- `sample/synth.js`: `synthFromLibrary(lib, opts)` (graphene-oxide-like spectrum from the
  atlas schematic: `plot.mu/A/sig` → pseudo-Voigt components, fluorescence baseline, Poisson
  noise, a few cosmic-ray spikes) and `synthMonolayer(lib, opts)` (G + sharp 2D, no D, using the
  atlas's monolayer criteria). Both return Spectrum with `meta.synthetic = true`; seeded.
- `export/csv.js`: `toCSV(headers, rows)` (RFC 4180), `peakTableCSV(rows)` (columns label, kind,
  tier, position_cm-1, height, fwhm_cm-1, prominence, area, match_score, delta_cm-1, band_id,
  band_name; `match_score` is the matcher's distance score, not a probability),
  `fitParamsCSV(components, windows)`, `spectrumCSV(processed)` (x, raw, baseline, corrected,
  final, despiked).
- UI (`main.js`, `ui/panels.js`): the **Data** tab renders acquisition fields, quality flags and
  the despike lists (`spikes` with Keep, `restored`, `suspects` with Remove, a zap form).
  Keeps and zaps live in `S.spikeEdits` per active spectrum, go through undo/redo, project files
  and the report. Companions for despike are the other spectra of the same file and sheet on an
  identical x axis. Match confidence is always shown as a score with a tooltip, never as "%".
- The **Map** tab (`renderMap`) is shown only when the active spectrum belongs to a map (≥ 2 spectra
  of the same file and sheet with `meta.map`). `mapModel()` measures the despiked spectra
  (`processedFor`, cached per spectrum; switching the active spectrum keeps the cache) for the
  selected band window, an optional ratio band and an optional comparison band, each a library
  band or a custom range (`S.map`). Clicking a cell or scatter dot makes that spectrum active;
  `exportMapCSV()` writes point, x, y, value[, compared value].

## Band libraries

`data/libraries/index.json` lists library files (GitHub Pages can't list folders).
A library is one JSON file (`schema: "raman-studio/band-library@1"`, see
`data/libraries/schema.json`). `graphene-go.json` is generated from the atlas by
`tools/extract_atlas.py` and checked by `tools/verify_atlas.py` — regenerate, never hand-edit.
