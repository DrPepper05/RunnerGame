/**
 * Parallax-layer debug capture + $0 replay harness (console: window.__PM_LAYER_DEBUG).
 *
 * Mirror of sheetDebug.js for the background_mid/near slots: every layer attempt's
 * raw image, final keyed image and deterministic measurements (alpha/topBand/bright)
 * are recorded in memory so ONE paid test yields full diagnostics for the
 * white-patch failure mode:
 *
 *   __PM_LAYER_DEBUG.list()             — one row per recorded attempt
 *   __PM_LAYER_DEBUG.download()         — save everything as one JSON file
 *   __PM_LAYER_DEBUG.replay(i, opts?)   — re-run the CURRENT postProcessAsset +
 *                                         measurements on a captured raw at $0
 *                                         (offline threshold tuning). i = record
 *                                         index (default -1 = latest) or a raw
 *                                         data URL string (then pass opts.slot).
 *
 * In-memory only (lost on reload — download right after the run). The pipeline
 * registers deps via registerLayerReplayDeps to avoid an import cycle.
 */

const records = [];
const deps = {};

export function registerLayerReplayDeps(d) {
  Object.assign(deps, d);
}

export function recordLayerAttempt(entry) {
  const rec = { ts: new Date().toISOString(), ...entry };
  records.push(rec);
  return rec;
}

function list() {
  return records.map((r, i) => ({
    i,
    ts: r.ts,
    slot: r.slot || null,
    alpha: r.measurements?.transparent ?? null,
    topBand: r.measurements?.topBand ?? null,
    bright: r.measurements?.bright ?? null
  }));
}

function download() {
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `playmint-layer-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function replay(which = -1, opts = {}) {
  const entry = typeof which === 'string'
    ? { rawDataUrl: which, slot: opts.slot || 'background_mid' }
    : records[which < 0 ? records.length + which : which];
  if (!entry?.rawDataUrl) {
    console.warn('[LAYER-DEBUG] no captured raw layer at', which);
    return null;
  }
  if (!deps.postProcessAsset || !deps.specFor || !deps.measureLayer) {
    console.warn('[LAYER-DEBUG] replay deps not registered (pipeline not loaded yet)');
    return null;
  }
  const spec = deps.specFor(entry.slot);
  const img = await deps.postProcessAsset(entry.rawDataUrl, spec, {
    ...(opts.keyOverrides ? { keyOverrides: opts.keyOverrides } : {}),
    ...(opts.whiteOverrides ? { whiteOverrides: opts.whiteOverrides } : {})
  });
  const measurements = deps.measureLayer(img, spec);
  console.log(`[LAYER-DEBUG] replay ${entry.slot}:`, measurements);
  return { measurements, finalDataUrl: img.src };
}

if (typeof window !== 'undefined') {
  window.__PM_LAYER_DEBUG = { records, list, download, replay };
}
