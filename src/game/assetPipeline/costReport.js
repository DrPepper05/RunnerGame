/**
 * Downloadable cost report — turns the per-run usage tally (assetMeta.cost, built by
 * providers/geminiImage.js), the run-outcome telemetry (assetMeta.run, stamped by the
 * asset cache), the per-slot provenance and the cross-run cache stats into a
 * human-readable text file, so testers can inspect spend without the DevTools console.
 *
 * assetMeta.cost is ALWAYS the CURRENT run's spend (an exact cache hit reports $0.00
 * with an empty call log); the matched art's original generation cost survives as
 * assetMeta.originalCost. All dollar figures are ESTIMATES (Gemini usageMetadata × a
 * static price table); Google's billing console is the authoritative number.
 */

import { getSessionSpend } from './providers/geminiImage';
import { getCacheStats } from '../assetCache/index.js';

const pad = (value, len) => String(value ?? '').padEnd(len);
const usd = (n, dp = 3) => `$${(n || 0).toFixed(dp)}`;
const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);

const TIER_WORDS = {
  exact: 'EXACT CACHE HIT — instant restore, $0.00, zero API calls',
  reuse: 'MATCHED REUSE — whole cached set reused (matcher call only)',
  'reuse-partial': 'PARTIAL REUSE — cached base + selected slots redrawn',
  fresh: 'FRESH GENERATION — full pipeline run',
  restored: 'RESTORED — share link / reload, no generation',
  restyle: 'RESTYLE — selected slots redrawn on a running game'
};

export function buildCostReport(liveParams) {
  const meta = liveParams?.assetMeta || {};
  const cost = meta.cost;
  const run = meta.run;
  const slots = meta.slots || {};
  const lines = [];

  lines.push('PlayMint — AI Generation Cost Report');
  lines.push('====================================');
  lines.push(`Game:       ${liveParams?.gameName || 'Untitled'}`);
  lines.push(`Mode:       ${liveParams?.gameType || 'unknown'}`);
  lines.push(`Design via: ${meta.designSource || 'n/a'}`);
  lines.push(`Downloaded: ${new Date().toISOString()}`);
  lines.push('');

  // ── Run outcome ────────────────────────────────────────────────────────────
  if (run) {
    lines.push('RUN OUTCOME');
    lines.push(`  ${TIER_WORDS[run.tier] || run.tier}`);
    if (run.matchedLabel) lines.push(`  Matched cached game: "${run.matchedLabel}"${run.reason ? ` — ${run.reason}` : ''}`);
    lines.push(`  Total time:  ${secs(run.elapsedMs)}`);
    lines.push(`  Run cost:    ${usd(run.estUsd)}`);
    if (run.reusedSlots?.length) lines.push(`  From cache:  ${run.reusedSlots.join(', ')}`);
    if (run.generatedSlots?.length) lines.push(`  Generated:   ${run.generatedSlots.join(', ')}`);
    lines.push('');
  }

  // ── This run's spend ───────────────────────────────────────────────────────
  if (!cost || (!cost.imageCalls && !cost.visionCalls)) {
    if (meta.restoredFromCache) {
      lines.push('THIS RUN COST $0.00 — artwork restored from cache, no Gemini calls.');
    } else {
      lines.push('No Gemini usage was recorded for this game (built-in theme art,');
      lines.push('preset, or share-link import) — this game cost $0.');
    }
    if (cost && (cost.imageFailures || cost.visionFailures)) {
      lines.push(`WARNING: ${cost.imageFailures || 0} image and ${cost.visionFailures || 0} vision ` +
        'call(s) FAILED — Gemini was attempted but never succeeded.');
    }
    lines.push('');
  } else {
    lines.push(`THIS RUN — ESTIMATED TOTAL: ${usd(cost.estUsd)}`);
    lines.push(`Calls:  ${cost.imageCalls} image (${cost.imageFailures || 0} failed), ` +
      `${cost.visionCalls} vision (${cost.visionFailures || 0} failed)`);
    lines.push(`Tokens: ${cost.promptTokens} input, ${cost.outputTokens} output, ${cost.thoughtsTokens} thinking`);
    if (cost.thoughtsTokens > 0) {
      lines.push('NOTE: thinking tokens are billed — a large number here means the');
      lines.push('model ignored/rejected the thinking-off request.');
    }
    if (cost.visionFailures > 0) {
      lines.push(`WARNING: ${cost.visionFailures} vision call(s) failed — art direction / QA may have`);
      lines.push('silently degraded this run; check the DevTools console for details.');
    }
    lines.push('');
    if (cost.calls?.length) {
      // "size" = requested imageSize → actually served pixels; a mismatch is proof
      // the API ignored the size request (billed tokens alone can't show that).
      lines.push('Per-call log:');
      lines.push(pad('#', 4) + pad('time (UTC)', 26) + pad('what', 20) + pad('model', 28) +
        pad('size (req→served)', 20) + pad('in', 7) + pad('out', 7) + pad('think', 7) +
        pad('ms', 8) + 'est $');
      cost.calls.forEach((c, i) => {
        const size = c.kind === 'image'
          ? `${c.requestedSize || 'default'}→${c.servedW ? `${c.servedW}×${c.servedH}` : '?'}`
          : '';
        lines.push(pad(i + 1, 4) + pad(c.at, 26) + pad(c.label || c.kind, 20) + pad(c.model, 28) +
          pad(size, 20) + pad(c.promptTokens, 7) + pad(c.outputTokens, 7) + pad(c.thoughtsTokens, 7) +
          pad(c.elapsedMs ?? '?', 8) + `$${(c.estUsd ?? 0).toFixed(4)}`);
      });
      lines.push('');
    }
  }

  // ── Per-asset cost rollup (group this run's calls by label) ────────────────
  const byLabel = {};
  for (const c of cost?.calls || []) {
    const key = c.label || c.kind;
    const g = byLabel[key] || (byLabel[key] = { calls: 0, estUsd: 0, ms: 0 });
    g.calls += 1;
    g.estUsd += c.estUsd || 0;
    g.ms += c.elapsedMs || 0;
  }

  // ── Per-asset summary with provenance + cost + time ────────────────────────
  const slotEntries = Object.entries(slots);
  if (slotEntries.length) {
    // Shared combined calls (e.g. props_grid): one API call delivered several
    // slots — split its cost evenly across the delivered members at render time
    // (billing is flat per image, so there is no per-cell signal to weight by).
    // The per-call log above stays 1:1 with real API calls.
    const sharedCalls = {};
    for (const [label, g] of Object.entries(byLabel)) {
      const members = slotEntries
        .filter(([, m]) => m && !m.dropped && m.via === label)
        .map(([s]) => s);
      if (members.length) sharedCalls[label] = { ...g, members, share: g.estUsd / members.length, msShare: g.ms / members.length };
    }
    lines.push('Per-asset summary (this run):');
    slotEntries.forEach(([slot, m]) => {
      if (m.dropped) {
        lines.push(`- ${slot}: DROPPED (${m.reason || 'quality gates'})`);
        return;
      }
      const roll = byLabel[slot];
      const shared = m.via && sharedCalls[m.via];
      const costBit = roll ? `, ${usd(roll.estUsd, 4)} in ${secs(roll.ms)} (${roll.calls} call(s))`
        : shared ? `, via ${m.via} ≈ ${usd(shared.share, 4)} share` : '';
      const origin = m.source === 'cache' ? 'CACHE' : m.source === 'generated' ? 'GENERATED' : '?';
      lines.push(`- ${slot} [${origin}]: ${m.provider || 'cache'}${m.model ? ` (${m.model})` : ''}` +
        `${m.attempts ? `, ${m.attempts} attempt(s)` : ''}` +
        `${m.sheet ? `, animated${m.perFrame ? ' per-frame' : ''}` : ''}` +
        `${m.mirrored ? ', mirrored' : ''}${costBit}`);
    });
    // Non-slot calls: shared combined calls get their member list; the rest
    // (design, cache-match, QA labels not matching a slot name) stay [overhead].
    const slotNames = new Set(Object.keys(slots));
    const other = Object.entries(byLabel).filter(([k]) => !slotNames.has(k));
    other.forEach(([k, g]) => {
      const shared = sharedCalls[k];
      lines.push(shared
        ? `- ${k} [shared → ${shared.members.join(', ')}]: ${g.calls} call(s), ${usd(g.estUsd, 4)} in ${secs(g.ms)}`
        : `- ${k} [overhead]: ${g.calls} call(s), ${usd(g.estUsd, 4)} in ${secs(g.ms)}`);
    });
    lines.push('');
  }

  if (meta.restoredFromCache && meta.originalCost?.estUsd != null) {
    lines.push(`This artwork originally cost ≈ ${usd(meta.originalCost.estUsd)} to generate ` +
      `(${meta.originalCost.imageCalls || 0} image calls) — reused here for ${usd(run?.estUsd ?? 0)}.`);
    lines.push('');
  }

  const session = getSessionSpend();
  if (session) {
    lines.push(`All games in this browser since ${String(session.since).slice(0, 10)}: ` +
      `≈ $${session.estUsd.toFixed(2)} (${session.imageCalls} image / ${session.visionCalls} vision calls).`);
    lines.push("Reset the running total with: localStorage.removeItem('PM_SPEND_TOTAL')");
    lines.push('');
  }

  // ── Cache performance + pricing projection ─────────────────────────────────
  const stats = getCacheStats();
  if (stats) {
    const hits = (stats.exact || 0) + (stats.reuse || 0) + (stats.reusePartial || 0);
    const total = hits + (stats.fresh || 0);
    const hitRate = total ? hits / total : 0;
    const avgFresh = stats.fresh ? stats.freshUsd / stats.fresh : null;
    const avgPartial = stats.reusePartial ? stats.partialUsd / stats.reusePartial : null;
    const spendAll = (stats.freshUsd || 0) + (stats.partialUsd || 0) + (stats.matcherUsd || 0);
    lines.push('CACHE PERFORMANCE (this browser, since ' + String(stats.since).slice(0, 10) + ')');
    lines.push(`  Generations: ${total} — ${stats.exact || 0} exact hit(s), ${stats.reuse || 0} matched reuse, ` +
      `${stats.reusePartial || 0} partial, ${stats.fresh || 0} fresh` +
      `${stats.staticMiss ? `, ${stats.staticMiss} cache-only static fallback(s)` : ''}`);
    lines.push(`  Measured cache hit rate: ${(hitRate * 100).toFixed(0)}%`);
    if (avgFresh != null) lines.push(`  Measured avg fresh generation: ${usd(avgFresh)}`);
    if (avgPartial != null) lines.push(`  Measured avg partial reuse:    ${usd(avgPartial)}`);
    if (total) lines.push(`  Measured blended avg per generation: ${usd(spendAll / total)}`);
    lines.push('');
    const fullAvg = avgFresh ?? 0.38;
    lines.push('PRICING PROJECTION — average cost per user generation vs cache hit rate');
    lines.push(`(fresh generation ≈ ${usd(fullAvg)} measured${avgFresh == null ? ' [default estimate]' : ''}; ` +
      'a cache hit costs ≈ $0.001 in matching; partial reuse lands between):');
    [0, 0.25, 0.5, 0.75, 0.9].forEach((h) => {
      const avg = h * 0.001 + (1 - h) * fullAvg;
      lines.push(`  ${String(Math.round(h * 100)).padStart(3)}% hit rate → ≈ ${usd(avg)} per generation`);
    });
    lines.push("Reset these counters with: localStorage.removeItem('PM_CACHE_STATS')");
    lines.push('');
  }

  lines.push('All dollar figures are estimates from Gemini usage metadata and a');
  lines.push('static price table; the authoritative spend is the Google billing console.');
  lines.push('(Per-call ms includes retries and the local image-decode probe.)');
  lines.push('');
  lines.push('Raw data (JSON):');
  lines.push(JSON.stringify({
    run: run || null,
    cost: cost || null,
    originalCost: meta.originalCost || null,
    slots,
    cacheStats: stats || null
  }, null, 2));
  return lines.join('\n');
}

export function downloadCostReport(liveParams) {
  const blob = new Blob([buildCostReport(liveParams)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `playmint-cost-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
