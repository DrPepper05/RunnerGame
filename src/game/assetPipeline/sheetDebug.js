/**
 * Sheet debug capture + $0 replay harness (console: window.__PM_SHEET_DEBUG).
 *
 * Every sheet attempt costs real money, and until 2026-08-16 its raw output was
 * discarded — a failed run told us nothing but "bad". This module records every
 * attempt's raw sheet, scorer verdict and vision review in memory so that ONE
 * paid test yields complete diagnostic material:
 *
 *   __PM_SHEET_DEBUG.list()       — one row per recorded attempt
 *   __PM_SHEET_DEBUG.download()   — save everything (raw sheets inline as data
 *                                   URLs) as one JSON file to send for analysis
 *   __PM_SHEET_DEBUG.replay(i)    — re-run slicing + the CURRENT scorer on a
 *                                   captured raw sheet at $0 (no API calls) —
 *                                   the offline tuning loop for sheet gates.
 *                                   i = record index (default -1 = latest) or a
 *                                   raw data URL string.
 *
 * In-memory only (lost on reload — download right after the run). The pipeline
 * registers the scorer/slicer via registerSheetReplayDeps to avoid an import
 * cycle.
 */

const records = [];
const deps = {};

export function registerSheetReplayDeps(d) {
  Object.assign(deps, d);
}

// Returns the entry so the caller can keep mutating it as the attempt
// progresses (verdicts and reviews arrive after the raw image).
export function recordSheetAttempt(entry) {
  const rec = { ts: new Date().toISOString(), ...entry };
  records.push(rec);
  return rec;
}

function list() {
  return records.map((r, i) => ({
    i,
    ts: r.ts,
    attempt: r.attempt ?? null,
    model: r.model || null,
    issue: r.scorerIssue || null,
    outcome: r.outcome || null
  }));
}

function download() {
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `playmint-sheet-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function replay(which = -1) {
  const entry = typeof which === 'string'
    ? { rawDataUrl: which }
    : records[which < 0 ? records.length + which : which];
  if (!entry?.rawDataUrl) {
    console.warn('[SHEET-DEBUG] no captured raw sheet at', which);
    return null;
  }
  if (!deps.processSheet || !deps.evaluateAndCullCells || !deps.sheetSpec) {
    console.warn('[SHEET-DEBUG] replay deps not registered (pipeline not loaded yet)');
    return null;
  }
  const spec = deps.sheetSpec;
  const { previewImg, cells: allCells } = await deps.processSheet(entry.rawDataUrl, spec, { chroma: entry.chroma || null });
  const cells = allCells.slice(0, spec.frames.usedCells ?? allCells.length);
  const verdict = deps.evaluateAndCullCells(cells, null, spec.frames.runFrameCount);
  console.log(
    '[SHEET-DEBUG] replay verdict:',
    verdict.issue
      ? `REJECT — ${verdict.issue} (bad cells: ${(verdict.badIndices || []).join(', ') || 'n/a'})`
      : `PASS — ${verdict.keptCells.length} cell(s) kept, ${verdict.dropped || 0} culled`,
    verdict
  );
  console.table(list());
  return { verdict, previewDataUrl: previewImg.src };
}

if (typeof window !== 'undefined') {
  window.__PM_SHEET_DEBUG = { records, list, download, replay };
}
