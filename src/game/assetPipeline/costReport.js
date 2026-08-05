/**
 * Downloadable cost report — turns the per-run usage tally (assetMeta.cost, built by
 * providers/geminiImage.js) and the per-slot metadata into a human-readable text
 * file, so testers can inspect spend without opening the DevTools console.
 * All dollar figures are ESTIMATES (Gemini usageMetadata × a static price table);
 * Google's billing console is the authoritative number.
 */

import { getSessionSpend } from './providers/geminiImage';

const pad = (value, len) => String(value ?? '').padEnd(len);

export function buildCostReport(liveParams) {
  const cost = liveParams?.assetMeta?.cost;
  const slots = liveParams?.assetMeta?.slots || {};
  const lines = [];

  lines.push('PlayMint — AI Generation Cost Report');
  lines.push('====================================');
  lines.push(`Game:       ${liveParams?.gameName || 'Untitled'}`);
  lines.push(`Mode:       ${liveParams?.gameType || 'unknown'}`);
  lines.push(`Design via: ${liveParams?.assetMeta?.designSource || 'n/a'}`);
  lines.push(`Downloaded: ${new Date().toISOString()}`);
  lines.push('');

  if (!cost || (!cost.imageCalls && !cost.visionCalls)) {
    lines.push('No Gemini usage was recorded for this game (built-in theme art,');
    lines.push('preset, or share-link import) — this game cost $0.');
    if (cost && (cost.imageFailures || cost.visionFailures)) {
      lines.push(`WARNING: ${cost.imageFailures || 0} image and ${cost.visionFailures || 0} vision ` +
        'call(s) FAILED — Gemini was attempted but never succeeded.');
    }
  } else {
    lines.push(`ESTIMATED TOTAL: $${cost.estUsd.toFixed(3)}`);
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
        pad('size (req→served)', 20) + pad('in', 7) + pad('out', 7) + pad('think', 7) + 'est $');
      cost.calls.forEach((c, i) => {
        const size = c.kind === 'image'
          ? `${c.requestedSize || 'default'}→${c.servedW ? `${c.servedW}×${c.servedH}` : '?'}`
          : '';
        lines.push(pad(i + 1, 4) + pad(c.at, 26) + pad(c.label || c.kind, 20) + pad(c.model, 28) +
          pad(size, 20) + pad(c.promptTokens, 7) + pad(c.outputTokens, 7) + pad(c.thoughtsTokens, 7) +
          `$${(c.estUsd ?? 0).toFixed(4)}`);
      });
      lines.push('');
    }
  }

  const session = getSessionSpend();
  if (session) {
    lines.push(`All games in this browser since ${String(session.since).slice(0, 10)}: ` +
      `≈ $${session.estUsd.toFixed(2)} (${session.imageCalls} image / ${session.visionCalls} vision calls).`);
    lines.push("Reset the running total with: localStorage.removeItem('PM_SPEND_TOTAL')");
    lines.push('');
  }

  const slotEntries = Object.entries(slots);
  if (slotEntries.length) {
    lines.push('Per-asset summary:');
    slotEntries.forEach(([slot, m]) => {
      if (m.dropped) {
        lines.push(`- ${slot}: DROPPED (${m.reason || 'quality gates'})`);
        return;
      }
      lines.push(`- ${slot}: ${m.provider}${m.model ? ` (${m.model})` : ''}, ` +
        `${m.attempts} attempt(s)` +
        `${m.sheet ? `, animated${m.perFrame ? ' per-frame' : ''}` : ''}` +
        `${m.mirrored ? ', mirrored' : ''}`);
    });
    lines.push('');
  }

  lines.push('All dollar figures are estimates from Gemini usage metadata and a');
  lines.push('static price table; the authoritative spend is the Google billing console.');
  lines.push('');
  lines.push('Raw data (JSON):');
  lines.push(JSON.stringify({ cost: cost || null, slots }, null, 2));
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
