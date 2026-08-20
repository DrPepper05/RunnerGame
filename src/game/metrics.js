/**
 * Run timing telemetry — the segmented "how long did it take" counterpart to
 * costReport's "how much did it cost" (2026-08-20).
 *
 * WHY THIS EXISTS: before this module the app measured exactly one number,
 * `assetMeta.run.elapsedMs`, and it started INSIDE generateOrRestoreAssets —
 * after prompt parsing, and ending long before the game was on screen. The
 * share-link path (the one users actually quote: "5-7 seconds on mobile") had
 * no end-to-end clock at all, because App never listened for the one event that
 * says the game is up.
 *
 * WHAT IT MEASURES: user-perceived time to playable, split into the four
 * scenarios the client reports on — fresh generation, cache-assisted
 * generation, exact cache hit, and share/config-link load.
 *
 * SHAPE OF A RUN: beginRun() at the moment the user acts (or at navigation
 * start for a share link) -> mark() at each phase boundary -> annotate() for
 * facts learned mid-run (tier, source, cost) -> notePlayable() when Phaser
 * reports the scene is up. The run finalizes itself shortly after the LAST
 * boot, which is what makes the share link's double boot (static art, then a
 * gameKey remount onto cached art) land in one record instead of two.
 *
 * HARD RULE: telemetry may never break generation. Every entry point is
 * wrapped and swallows its own failures; a run that is never finalized is
 * simply absent from the log. Records live in localStorage PM_TIMING_LOG as a
 * bounded ring buffer so numbers survive reloads (assetMeta.run is stripped by
 * persistRun by design and cannot serve this purpose).
 */

const LOG_KEY = 'PM_TIMING_LOG';
const MAX_RECORDS = 100;
// A run ends this long after the last Phaser boot. Longer than the gap between
// a share link's two boots, short enough to never merge two user actions.
const FINALIZE_DELAY_MS = 1200;

let current = null;
let finalizeTimer = null;
// While held, a boot records its time but does NOT arm the finalize timer. A
// share link boots on theme art first and only remounts onto cached art once the
// lookup resolves; without a hold, a lookup slower than FINALIZE_DELAY_MS would
// close the record as a miss and the real restore would land on a dead run —
// precisely the slow server restores the report exists to measure.
let holds = 0;

const now = () => performance.now();

// The cache ladder's tier vocabulary mapped onto the client's report buckets.
// One vocabulary drives collection, reporting and the console summary.
const TIER_SCENARIOS = {
  fresh: 'fresh',
  exact: 'exact',
  reuse: 'cache-assisted',
  'reuse-partial': 'cache-assisted',
  restored: 'share-link',
  restyle: 'restyle'
};

export const SCENARIO_LABELS = {
  fresh: 'Fresh generation (new prompt)',
  'cache-assisted': 'Cache-assisted generation',
  exact: 'Exact cache hit',
  'share-link': 'Shared/config link load',
  'share-link-miss': 'Shared link (no cached art)',
  restyle: 'Creator-panel restyle',
  static: 'Static theme art (no AI)',
  unknown: 'Unclassified'
};

export function scenarioFor(rec) {
  if (!rec) return 'unknown';
  if (rec.tier && TIER_SCENARIOS[rec.tier]) return TIER_SCENARIOS[rec.tier];
  if (rec.kind === 'sharelink') return 'share-link-miss';
  if (rec.kind === 'restyle') return 'restyle';
  if (rec.kind === 'generate') return 'static';
  return 'unknown';
}

const readLog = () => {
  try {
    const arr = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

const writeLog = (arr) => {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-MAX_RECORDS)));
  } catch {
    /* timing telemetry is best-effort — a full quota must never break a run */
  }
};

/**
 * Open a run. kind: 'generate' | 'sharelink' | 'restyle'.
 * A share link's clock is the browser's own: performance.now() is already
 * milliseconds since navigation start, so t0 = 0 measures exactly what the user
 * waits (page load + JS + restore + boot), not just our function's body.
 */
export function beginRun(kind, meta = {}) {
  try {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    holds = 0;
    current = {
      kind,
      t0: kind === 'sharelink' ? 0 : now(),
      startedAt: new Date().toISOString(),
      marks: [],
      firstFrameMs: null,
      playableMs: null,
      meta: { ...meta }
    };
  } catch {
    current = null;
  }
  return current;
}

/** Record a phase boundary. Silently ignored when no run is open. */
export function mark(phase) {
  try {
    if (current && phase) current.marks.push({ phase, at: Math.round(now() - current.t0) });
  } catch {
    /* best-effort */
  }
}

/** Time a promise as one phase, whatever its outcome. */
export async function timed(phase, promise) {
  const t = now();
  try {
    return await promise;
  } finally {
    try {
      if (current) current.marks.push({ phase, at: Math.round(now() - current.t0), ms: Math.round(now() - t) });
    } catch {
      /* best-effort */
    }
  }
}

/** Merge facts learned mid-run (tier, source, gameId, cost, bytes). */
export function annotate(fields) {
  try {
    if (current && fields) Object.assign(current.meta, fields);
  } catch {
    /* best-effort */
  }
}

/** True when a run is open — lets callers skip work that only feeds telemetry. */
export function isRunning() {
  return !!current;
}

/**
 * Phaser reported the scene is up. Called for EVERY boot: the first one is the
 * first frame the user sees, the last one is when the final art is on screen.
 * Each call restarts the finalize timer, so a remount extends the same record.
 */
export function notePlayable() {
  try {
    if (!current) return;
    const at = Math.round(now() - current.t0);
    if (current.firstFrameMs == null) current.firstFrameMs = at;
    current.playableMs = at;
    current.marks.push({ phase: 'boot', at });
    armFinalize();
  } catch {
    /* best-effort */
  }
}

function armFinalize() {
  if (finalizeTimer) clearTimeout(finalizeTimer);
  finalizeTimer = null;
  if (holds > 0 || !current || current.playableMs == null) return;
  finalizeTimer = setTimeout(() => {
    finalizeTimer = null;
    endRun();
  }, FINALIZE_DELAY_MS);
}

/** Keep the run open across an in-flight step that may trigger another boot. */
export function holdRun() {
  try {
    if (current) holds += 1;
  } catch {
    /* best-effort */
  }
}

/** Release a hold; finalizes shortly after the last boot once all are released. */
export function releaseRun() {
  try {
    if (holds > 0) holds -= 1;
    armFinalize();
  } catch {
    /* best-effort */
  }
}

/** Finalize and persist. Safe to call twice; the second call is a no-op. */
export function endRun(extra = {}) {
  try {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    const run = current;
    current = null;
    holds = 0;
    if (!run) return null;

    const rec = {
      ts: run.startedAt,
      kind: run.kind,
      ...run.meta,
      ...extra,
      firstFrameMs: run.firstFrameMs,
      // The headline number: user action (or navigation) -> playable. Falls back
      // to wall clock when a run ends without ever booting (an error path).
      totalMs: run.playableMs ?? Math.round(now() - run.t0),
      reachedPlayable: run.playableMs != null,
      marks: run.marks
    };
    rec.scenario = scenarioFor(rec);

    const log = readLog();
    log.push(rec);
    writeLog(log);

    const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;
    console.log(
      `[METRICS] ${rec.scenario} · total ${secs(rec.totalMs)}` +
      (rec.firstFrameMs != null && rec.firstFrameMs !== rec.totalMs ? ` · first frame ${secs(rec.firstFrameMs)}` : '') +
      (rec.source ? ` · ${rec.source}` : '')
    );
    return rec;
  } catch {
    return null;
  }
}

/** Drop the open run without recording it (cancelled/failed before any result). */
export function cancelRun() {
  try {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    current = null;
    holds = 0;
  } catch {
    /* best-effort */
  }
}

export function getRecords() {
  return readLog();
}

export function clearRecords() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    /* best-effort */
  }
}
