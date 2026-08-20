/**
 * Segmented timing report — the client-facing deliverable for "how long does
 * each kind of load take" (2026-08-20).
 *
 * Deliberately SEPARATE from costReport.js: that report is already long, and
 * its Creator-Panel button is gated on `assetMeta`, which can be absent on
 * exactly the share-link path this report exists to measure. This one renders
 * from the PM_TIMING_LOG ring buffer alone, so it works on any boot.
 *
 * Console harness (mirrors __PM_SHEET_DEBUG / __PM_LAYER_DEBUG):
 *   __PM_METRICS.list()        — one row per recorded run
 *   __PM_METRICS.summary()     — per-scenario aggregate, as a console table
 *   __PM_METRICS.report()      — the full text report, printed
 *   __PM_METRICS.download()    — save the text report
 *   __PM_METRICS.json()        — save the raw records
 *   __PM_METRICS.reset()       — clear the log
 */

import { getRecords, clearRecords, scenarioFor, SCENARIO_LABELS } from './metrics.js';

// ScreenZero deliberately plays a two-step 1s fade after the game is playable.
// It is a design choice, not engine time, so it is reported apart from the
// engineering numbers instead of silently inflating them.
const UI_FADE_MS = 2000;

const SCENARIO_ORDER = [
  'fresh',
  'cache-assisted',
  'exact',
  'share-link',
  'share-link-miss',
  'restyle',
  'static',
  'unknown'
];

const secs = (ms) => (ms == null || Number.isNaN(ms) ? '   —  ' : `${(ms / 1000).toFixed(2)}s`);
const pad = (v, n) => String(v ?? '').padEnd(n);
const padL = (v, n) => String(v ?? '').padStart(n);

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// Nearest-rank percentile — honest on the tiny sample sizes a test session
// produces (an interpolated p90 over 4 runs invents precision we don't have).
const percentile = (nums, p) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
};

const groupByScenario = (records) => {
  const groups = {};
  for (const r of records) {
    const key = r.scenario || scenarioFor(r);
    (groups[key] = groups[key] || []).push(r);
  }
  return groups;
};

export function summarize(records = getRecords()) {
  const groups = groupByScenario(records);
  const rows = [];
  for (const key of SCENARIO_ORDER) {
    const rs = groups[key];
    if (!rs || !rs.length) continue;
    const totals = rs.map((r) => r.totalMs).filter((n) => typeof n === 'number');
    rows.push({
      scenario: key,
      label: SCENARIO_LABELS[key] || key,
      n: rs.length,
      median: median(totals),
      p90: percentile(totals, 90),
      min: totals.length ? Math.min(...totals) : null,
      max: totals.length ? Math.max(...totals) : null,
      firstFrame: median(rs.map((r) => r.firstFrameMs).filter((n) => typeof n === 'number'))
    });
  }
  // Any scenario key not in SCENARIO_ORDER still gets reported rather than lost.
  for (const [key, rs] of Object.entries(groups)) {
    if (SCENARIO_ORDER.includes(key)) continue;
    const totals = rs.map((r) => r.totalMs).filter((n) => typeof n === 'number');
    rows.push({
      scenario: key,
      label: key,
      n: rs.length,
      median: median(totals),
      p90: percentile(totals, 90),
      min: totals.length ? Math.min(...totals) : null,
      max: totals.length ? Math.max(...totals) : null,
      firstFrame: null
    });
  }
  return rows;
}

// Median cumulative offset per phase, in the order the phases actually occurred.
// A timeline reads the same as a delta breakdown for "where do the seconds go",
// and cannot be corrupted by marks that overlap or nest.
const phaseTimeline = (records) => {
  const order = [];
  const byPhase = {};
  for (const r of records) {
    // A phase can legitimately repeat inside one run — a share link fires `boot`
    // twice (theme art, then cached art). Collapsing those into a single median
    // row invents a boot that happened at neither time, so repeats are kept
    // apart and the two share-link boots get their real names.
    const seen = {};
    for (const m of r.marks || []) {
      seen[m.phase] = (seen[m.phase] || 0) + 1;
      let key = m.phase;
      if (seen[m.phase] > 1) key = `${m.phase} #${seen[m.phase]}`;
      if (m.phase === 'boot') key = seen.boot === 1 ? 'boot (first frame)' : 'boot (final art)';
      if (!byPhase[key]) {
        byPhase[key] = { at: [], ms: [] };
        order.push(key);
      }
      if (typeof m.at === 'number') byPhase[key].at.push(m.at);
      if (typeof m.ms === 'number') byPhase[key].ms.push(m.ms);
    }
  }
  return order
    .map((phase) => ({
      phase,
      at: median(byPhase[phase].at),
      ms: median(byPhase[phase].ms),
      n: byPhase[phase].at.length
    }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
};

export function buildMetricsReport() {
  const records = getRecords();
  const lines = [];

  lines.push('PLAYMINT — GENERATION & LOAD TIMING REPORT');
  lines.push('='.repeat(78));
  lines.push(`Generated:  ${new Date().toISOString()}`);
  lines.push(`Runs logged: ${records.length}${records.length ? `  (oldest ${records[0].ts})` : ''}`);
  lines.push('Measured from the user\'s action — or, for shared links, from navigation');
  lines.push('start — through to the game being on screen and playable.');
  lines.push('');

  if (!records.length) {
    lines.push('No runs recorded yet in this browser.');
    lines.push('');
    lines.push('Generate a game, open a shared link, or reload one, then download again.');
    lines.push('Timing is stored in localStorage PM_TIMING_LOG (last 100 runs).');
    return lines.join('\n');
  }

  lines.push('TIME TO PLAYABLE, BY SCENARIO');
  lines.push('-'.repeat(78));
  lines.push(pad('scenario', 34) + padL('runs', 6) + padL('median', 10) + padL('p90', 10) + padL('min', 9) + padL('max', 9));
  for (const row of summarize(records)) {
    lines.push(
      pad(row.label, 34) +
      padL(row.n, 6) +
      padL(secs(row.median), 10) +
      padL(secs(row.p90), 10) +
      padL(secs(row.min), 9) +
      padL(secs(row.max), 9)
    );
  }
  lines.push('');

  // Share links boot twice by design: static theme art first, then a remount
  // onto cached art. The split below is what makes "the link opened fast" and
  // "the art arrived fast" two separate, honest numbers.
  const shareRuns = records.filter((r) => r.kind === 'sharelink');
  if (shareRuns.length) {
    lines.push('SHARED / CONFIG LINK BREAKDOWN');
    lines.push('-'.repeat(78));
    const firstFrames = shareRuns.map((r) => r.firstFrameMs).filter((n) => typeof n === 'number');
    lines.push(`  First frame on screen (static art):  ${secs(median(firstFrames))}   n=${firstFrames.length}`);
    for (const src of ['local', 'server']) {
      const rs = shareRuns.filter((r) => r.source === src);
      if (!rs.length) continue;
      const totals = rs.map((r) => r.totalMs).filter((n) => typeof n === 'number');
      const where = src === 'local' ? 'restored from this browser\'s cache' : 'downloaded from the server cache';
      lines.push(`  Final art playable (${where}): ${secs(median(totals))}   n=${rs.length}`);
    }
    const missed = shareRuns.filter((r) => !r.tier);
    if (missed.length) {
      const totals = missed.map((r) => r.totalMs).filter((n) => typeof n === 'number');
      lines.push(`  No cached art — stayed on theme art:  ${secs(median(totals))}   n=${missed.length}`);
    }
    const bytes = shareRuns.map((r) => r.bytes).filter((n) => typeof n === 'number' && n > 0);
    if (bytes.length) {
      lines.push(`  Art downloaded from server:          ${(median(bytes) / 1024).toFixed(0)} KB median   n=${bytes.length}`);
    }
    lines.push('');
  }

  lines.push('WHERE THE TIME GOES  (median timeline offset from the start of the run)');
  lines.push('-'.repeat(78));
  const groups = groupByScenario(records);
  for (const key of SCENARIO_ORDER) {
    const rs = groups[key];
    if (!rs || !rs.length) continue;
    const timeline = phaseTimeline(rs);
    if (!timeline.length) continue;
    lines.push(`  ${SCENARIO_LABELS[key] || key}  (n=${rs.length})`);
    for (const p of timeline) {
      lines.push(
        '    ' + pad(p.phase, 26) + padL(secs(p.at), 10) +
        (p.ms != null ? `   (step took ${secs(p.ms)})` : '')
      );
    }
    lines.push('');
  }

  const generated = records.filter((r) => r.kind === 'generate');
  if (generated.length) {
    lines.push('COST ALONGSIDE TIME  (generation runs only)');
    lines.push('-'.repeat(78));
    const withUsd = generated.filter((r) => typeof r.estUsd === 'number');
    if (withUsd.length) {
      const total = withUsd.reduce((a, r) => a + r.estUsd, 0);
      lines.push(`  Runs with a cost estimate: ${withUsd.length}   total ≈ $${total.toFixed(2)}   median ≈ $${(median(withUsd.map((r) => r.estUsd * 10000)) / 10000).toFixed(3)}`);
    } else {
      lines.push('  No cost estimates recorded (all runs were free cache hits).');
    }
    lines.push('');
  }

  lines.push('NOTES');
  lines.push('-'.repeat(78));
  lines.push(`  · After a generation run reaches "playable", the start screen plays a fixed`);
  lines.push(`    ${(UI_FADE_MS / 1000).toFixed(1)}s reveal animation before handing over. That is a deliberate UI`);
  lines.push('    choice and is NOT included in any number above.');
  lines.push('  · Shared links intentionally boot twice: theme art immediately, then a');
  lines.push('    remount onto cached art. "First frame" and "final art" are both listed.');
  lines.push('  · Timings are wall clock in the user\'s browser and include network,');
  lines.push('    device decode and render — they are what the user actually waits.');
  lines.push('  · Sample sizes are small; median and p90 are nearest-rank, not interpolated.');
  lines.push('');
  lines.push('RAW RECORDS');
  lines.push('-'.repeat(78));
  lines.push(JSON.stringify(records, null, 2));

  return lines.join('\n');
}

const saveBlob = (text, ext, type) => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `playmint-timing-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export function downloadMetricsReport() {
  saveBlob(buildMetricsReport(), 'txt', 'text/plain');
}

export function downloadMetricsJson() {
  saveBlob(JSON.stringify(getRecords(), null, 2), 'json', 'application/json');
}

if (typeof window !== 'undefined') {
  window.__PM_METRICS = {
    get records() { return getRecords(); },
    list: () => getRecords().map((r, i) => ({
      i,
      scenario: r.scenario,
      total: r.totalMs != null ? `${(r.totalMs / 1000).toFixed(2)}s` : '—',
      firstFrame: r.firstFrameMs != null ? `${(r.firstFrameMs / 1000).toFixed(2)}s` : '—',
      tier: r.tier || null,
      source: r.source || null,
      ts: r.ts
    })),
    summary: () => summarize(),
    report: () => { console.log(buildMetricsReport()); },
    download: downloadMetricsReport,
    json: downloadMetricsJson,
    reset: clearRecords
  };
}
