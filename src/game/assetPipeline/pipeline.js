/**
 * Asset generation pipeline — the single entry point for every generation path
 * (ScreenZero prompt flow, App.jsx prompt flow, CreatorPanel regeneration).
 *
 * Per slot: Gemini with retry → post-process to the exact contract the game
 * expects. Gemini is the ONLY image provider (Pollinations was removed 2026-08-06
 * per client direction) — terminal failure of any required slot rejects, and
 * every caller handles it by downgrading to the built-in static theme asset set
 * (ScreenZero's toStaticThemeConfig; App surfaces it in the regen overlay).
 */
import { SLOT_SPECS, BASELINE_SLOTS, GENERATED_SLOTS, GEMINI_SHEET_MODEL, GEMINI_PRO_SHEET_MODEL, GEMINI_IMAGE_FALLBACK_MODEL, PROPS_GRID_SPEC, BG_CLAUSE, GAPS_CLAUSE } from './slotSpecs';
import { postProcessAsset, mirrorImage, drawToCanvas, alphaFraction, borderResidueFraction, topBandOpaqueFraction, contentBoundsOf, processSheet, finalizeSheetFrames, loadImage, keyCellWithQuality, cleanKeyedEdges, alignFrames, maskIoU, composeFilmstrip, lockPalette, sliceRawGrid, removeEnclosedPockets } from './postprocess';
import { reviewSprite } from './qa';
import * as gemini from './providers/geminiImage';
import { designAssetPrompts, buildFinalPrompt, buildPropsGridPrompt, chromaFromPrompt } from './promptDesigner';
import { parsePromptKeywords } from '../promptUtils';
import { recordSheetAttempt, registerSheetReplayDeps } from './sheetDebug';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Cooperative cancellation for a generation run. The UI cancels the token when the
 * user abandons the run (closes the prompt overlay, starts a new generation, or
 * unmounts ScreenZero); the pipeline checks it between attempts and bails, and the
 * caller ignores results from a cancelled run. Cancellation is a REJECTION of the
 * whole run (never "drop optional slot and continue") flagged with err.cancelled,
 * so callers can tell it apart from a real failure and skip the static-theme boot.
 */
export const createCancelToken = () => ({
  cancelled: false,
  cancel() { this.cancelled = true; }
});

const cancelledError = () => Object.assign(new Error('Generation cancelled'), { cancelled: true });

// The $0 replay harness re-runs the sheet slicer + scorer on captured raws with
// the CURRENT code — registration (instead of an import in sheetDebug) avoids a
// module cycle.
registerSheetReplayDeps({
  processSheet,
  evaluateAndCullCells: (...args) => evaluateAndCullCells(...args),
  sheetSpec: SLOT_SPECS.player_sheet
});

/**
 * Generate one slot's raw image on Gemini (the only image provider).
 * `runState.skipGemini` is shared across a run: once one slot hits a hard failure
 * (dead quota, bad key), the remaining slots fail fast instead of each burning
 * retries and long quota waits — the caller downgrades to static theme art.
 * Returns { dataUrl, provider, attempts }.
 */
async function generateSlotImage(slot, prompt, seed, onProgress, maxAttemptsPerProvider, runState, onAttempt = () => {}, referenceImageDataUrl = null, specOverride = null) {
  const spec = specOverride || SLOT_SPECS[slot];
  let attempts = 0;
  let lastError = null;

  if (!gemini.isGeminiConfigured()) {
    throw new Error(`No Gemini API key configured — cannot generate "${slot}".`);
  }
  if (runState.skipGemini) {
    throw new Error(`Gemini is unavailable for this run — skipping "${slot}".`);
  }
  const budgetLeft = () => runState.imageCalls < (runState.maxImageCalls ?? Infinity);
  for (let attempt = 1; attempt <= maxAttemptsPerProvider; attempt++) {
    if (runState.cancelToken?.cancelled) throw cancelledError();
    if (!budgetLeft()) {
      onProgress(`[COST] Gemini call budget reached — "${slot}" will not be generated.`, null);
      break;
    }
    runState.imageCalls++;
    attempts++;
    onAttempt({ provider: 'gemini', attempt, total: maxAttemptsPerProvider });
    try {
      const result = await gemini.generateImage({
        prompt,
        aspectRatio: spec.gen.aspectRatio,
        referenceImageDataUrl,
        model: spec.gen.model,
        imageSize: spec.gen.imageSize,
        label: slot // cost-report attribution
      });
      return { ...result, attempts };
    } catch (err) {
      lastError = err;
      console.warn(`[AssetPipeline] Gemini failed for "${slot}" (attempt ${attempt}): ${err.message}`);
      // Bad key or safety block won't improve on retry
      if (err.kind === 'auth' || err.kind === 'safety' || err.kind === 'no-key') {
        if (err.kind !== 'safety') runState.skipGemini = true;
        break;
      }
      if (err.kind === 'quota') {
        // A long/absent retry window means daily or zero quota — dead for this run
        if (!err.retryDelayMs || err.retryDelayMs > 10000) {
          runState.skipGemini = true;
          break;
        }
        if (attempt < maxAttemptsPerProvider) await sleep(err.retryDelayMs);
        continue;
      }
      if (attempt < maxAttemptsPerProvider) await sleep(2000 * attempt);
    }
  }

  throw new Error(`Image generation failed for asset "${slot}". Last error: ${lastError?.message || 'call budget exhausted'}`);
}

// ---- Sheet frame scoring ---------------------------------------------------
// Module-level pure canvas math (no closure state) so the $0 replay harness in
// sheetDebug.js can re-run the exact shipping verdict on a captured raw sheet.

// A sheet of near-identical poses animates as a nervous shiver, not a run.
// Compare consecutive run frames on a coarse 12×12 alpha grid; if most pairs
// are effectively the same image, the model ignored the cycle choreography.
// The Math.max(2, …) floor matters for the 4-frame cycle: the old formula
// flagged a 4-frame set as static on ONE similar pair out of three.
export function framesLookStatic(runCells) {
  const signature = (cell) => {
    const small = document.createElement('canvas');
    small.width = 12; small.height = 12;
    const ctx = small.getContext('2d');
    ctx.drawImage(cell, 0, 0, 12, 12);
    return ctx.getImageData(0, 0, 12, 12).data;
  };
  const sigs = runCells.map(signature);
  let staticPairs = 0;
  for (let i = 1; i < sigs.length; i++) {
    let diff = 0;
    for (let p = 3; p < sigs[i].length; p += 4) diff += Math.abs(sigs[i][p] - sigs[i - 1][p]);
    if (diff / (144 * 255) < 0.015) staticPairs++;
  }
  return staticPairs >= Math.max(2, Math.floor((runCells.length - 1) / 2));
}

// Identity drift scoring. Same character in a new pose keeps its palette; a
// redesigned character shifts it — compare per-cell coarse color histograms
// (4×4×4 RGB buckets over opaque pixels) against the element-wise median of
// the RUN cells. L1 distance ranges 0..2; >0.9 = mostly different palette.
// Returns one distance per cell (jump scored against the run median too),
// or null when too few cells have content (geometry's job to reject).
function frameHistogramDistances(cells, runCount) {
  const histogram = (cell) => {
    const small = document.createElement('canvas');
    small.width = 32; small.height = 32;
    const ctx = small.getContext('2d');
    ctx.drawImage(cell, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const buckets = new Array(64).fill(0);
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      buckets[(data[i] >> 6) * 16 + (data[i + 1] >> 6) * 4 + (data[i + 2] >> 6)]++;
      opaque++;
    }
    return opaque ? buckets.map(b => b / opaque) : null;
  };
  const hists = cells.map(histogram);
  const runHists = hists.slice(0, runCount).filter(Boolean);
  if (runHists.length < 3) return null;
  const median = runHists[0].map((_, i) => {
    const col = runHists.map(h => h[i]).sort((a, b) => a - b);
    return col[Math.floor(col.length / 2)];
  });
  return hists.map((h) => {
    if (!h) return 0; // empty cell — geometry flags it
    let dist = 0;
    for (let i = 0; i < 64; i++) dist += Math.abs(h[i] - median[i]);
    return dist;
  });
}

// Per-frame quality verdict: instead of rejecting a whole sheet for one or two
// bad cells (the old all-or-nothing gates threw away the good frames), score
// every frame — geometry (empty/undersized) and identity (histogram outlier)
// — and CULL bad run frames, rebuilding a 1×N strip. The scene derives its
// layout entirely from the frames meta, so a strip needs no scene changes.
// gridMeta is the meta to keep when nothing is culled; pass null to always get
// a strip (the sheet path does this since the 4-frame layout — its 3×2 grid
// carries a prompted-empty cell that must never be registered as a frame).
// Small-cycle thresholds (runCount ≤ 4): at most 1 culled run frame, ≥3
// survivors, and a lower pose-jump IoU bar (contact↔pass deltas are larger by
// design in the 4-pose cycle).
export function evaluateAndCullCells(cells, gridMeta, runCountOverride = null) {
  const runCount = Math.min(runCountOverride ?? gridMeta?.runFrameCount ?? cells.length, cells.length);
  const hasJump = cells.length > runCount;
  const jumpCell = hasJump ? cells[cells.length - 1] : null;
  const maxBadRun = runCount <= 4 ? 1 : 2;
  const minKept = runCount <= 4 ? 3 : 4;
  const lowIoU = runCount <= 4 ? 0.25 : 0.30;

  const bad = new Array(cells.length).fill(false);
  let geomIssue = null;
  cells.forEach((cell, i) => {
    const bounds = contentBoundsOf(cell);
    const issue = !bounds ? 'has empty cells'
      : (bounds.maxY - bounds.minY + 1 < cell.height * 0.3 ? 'has undersized frames' : null);
    if (issue) { bad[i] = true; geomIssue = geomIssue || issue; }
  });
  const dists = frameHistogramDistances(cells, runCount);
  let identityIssue = false;
  if (dists) {
    cells.forEach((_, i) => {
      if (dists[i] > 0.9) { bad[i] = true; if (i < runCount) identityIssue = true; }
    });
  }

  // Continuity scoring on ALIGNED copies (scoring unaligned cells would flag
  // placement drift, which alignment fixes for free, instead of content faults).
  // Consecutive run frames of one stride overlap substantially — a frame whose
  // every healthy neighbor shares almost no silhouette is a pose/identity jump;
  // a near-perfect overlap is a duplicated cell (animates as a stutter).
  const aligned = alignFrames(cells, { runFrameCount: runCount });
  const ious = [];
  for (let i = 1; i < runCount && i < aligned.length; i++) {
    ious[i] = (bad[i - 1] || bad[i]) ? null : maskIoU(aligned[i - 1], aligned[i]);
  }
  for (let i = 0; i < runCount; i++) {
    if (bad[i]) continue;
    const neighborIous = [i > 0 ? ious[i] : null, i + 1 < runCount ? ious[i + 1] : null]
      .filter((v) => v != null);
    if (neighborIous.length && neighborIous.every((v) => v < lowIoU)) bad[i] = true;
  }
  for (let i = 1; i < runCount; i++) {
    if (!bad[i] && ious[i] != null && ious[i] > 0.965) bad[i] = true; // duplicate — keep the first
  }

  const badRunCount = bad.slice(0, runCount).filter(Boolean).length;
  const keptRun = cells.slice(0, runCount).filter((_, i) => !bad[i]);
  if (badRunCount > maxBadRun || keptRun.length < minKept) {
    return {
      issue: identityIssue ? 'draws a different character per frame' : (geomIssue || 'has inconsistent frames'),
      // Which frames failed — lets the repair rung redraw exactly these.
      badIndices: bad.map((b, i) => (b ? i : -1)).filter((i) => i >= 0)
    };
  }
  // Survivors must still read as one coherent cycle (same thresholds as the
  // old whole-sheet gates, applied to what actually ships).
  if (framesLookStatic(keptRun)) return { issue: 'has near-identical frames' };
  const heights = keptRun.map((c) => {
    const b = contentBoundsOf(c);
    return b.maxY - b.minY + 1;
  });
  if (Math.max(...heights) / Math.min(...heights) > 1.35) return { issue: 'has inconsistent frame sizes' };

  const jumpKept = hasJump && !bad[cells.length - 1];
  if (badRunCount === 0 && (!hasJump || jumpKept) && gridMeta) {
    return { keptCells: cells, framesMeta: gridMeta, dropped: 0 };
  }
  const keptCells = jumpKept ? [...keptRun, jumpCell] : keptRun;
  const framesMeta = {
    cols: keptCells.length,
    rows: 1,
    runFrameCount: keptRun.length,
    // jump dropped → omit jumpFrameIndex; playPlayerAnim falls back to frame 1
    ...(jumpKept ? { jumpFrameIndex: keptRun.length } : {})
  };
  return { keptCells, framesMeta, dropped: cells.length - keptCells.length };
}

// Drop vision-flagged frames from an already-culled kept set, rebuilding strip
// meta. Returns null when the survivors can't carry a cycle. A jumpFrameIndex
// BELOW runFrameCount means a run frame doubles as the jump pose — it must be
// remapped, never appended as an extra cell.
function cullFromKept(keptCells, framesMeta, badSet) {
  const runCount = framesMeta.runFrameCount ?? keptCells.length;
  const minRun = runCount <= 4 ? 3 : 4;
  const keptRun = [];
  for (let i = 0; i < runCount; i++) if (!badSet.has(i)) keptRun.push(keptCells[i]);
  if (keptRun.length < minRun) return null;
  const cellsOut = [...keptRun];
  let jumpMeta = {};
  const jumpIdx = framesMeta.jumpFrameIndex;
  if (jumpIdx != null && !badSet.has(jumpIdx)) {
    if (jumpIdx >= runCount) {
      cellsOut.push(keptCells[jumpIdx]); // dedicated jump cell rides along last
      jumpMeta = { jumpFrameIndex: keptRun.length };
    } else {
      let newIdx = 0;
      for (let i = 0; i < jumpIdx; i++) if (!badSet.has(i)) newIdx++;
      jumpMeta = { jumpFrameIndex: newIdx };
    }
  }
  return {
    keptCells: cellsOut,
    framesMeta: { cols: cellsOut.length, rows: 1, runFrameCount: keptRun.length, ...jumpMeta }
  };
}

/**
 * Generate and post-process all requested slots.
 * Returns { preloadedImages: { slot: HTMLImageElement }, meta: { slot: { provider, attempts, promptUsed } } }.
 */
export async function generateAssets({
  finalPrompts,
  slots = BASELINE_SLOTS,
  seed = Math.floor(Math.random() * 1000000),
  onProgress = () => {},
  concurrency = 3,
  maxAttemptsPerProvider = 2,
  cancelToken = null,
  // Combined-props plan from buildPropsGridPrompt (PM_GRID_PROPS): several small
  // keyed slots delivered by ONE image call, with per-cell fallback to the normal
  // individual path. Quality mode ignores it (the paid rescue rungs assume
  // individual calls).
  gridPlan = null
}) {
  const preloadedImages = {};
  const meta = {};
  // Cost controls (both read AT RUN START, like the provider toggle):
  // - qualityMode restores the expensive rescue rungs (pro sheet, per-frame
  //   escalation, QA regenerations, 2K sheet) that are OFF in the cost defaults.
  // - maxImageCalls is a hard backstop: once a run has spent this many Gemini
  //   image calls, remaining attempts go straight to the free fallback. Normal
  //   runs never reach it.
  const runState = {
    skipGemini: false,
    qualityMode: localStorage.getItem('PM_QUALITY_MODE') === '1',
    imageCalls: 0,
    maxImageCalls: parseInt(localStorage.getItem('PM_MAX_GEMINI_CALLS'), 10) || 12,
    // Probe/experiment knobs (A/B protocol): override the image model for the
    // static player / the sheet without touching slotSpecs. Normal runs leave
    // them unset; a passed probe flips the slotSpecs default instead.
    modelOverrides: {
      player: localStorage.getItem('PM_MODEL_PLAYER') || null,
      player_sheet: localStorage.getItem('PM_MODEL_SHEET') || null
    },
    cancelToken
  };
  let doneCount = 0;
  // A required slot that dies rejects the whole run — stop idle workers from
  // starting more slots after the UI has moved on.
  let fatal = false;

  // Partial credit for in-flight slots so the bar moves between completions.
  // Fractions are capped per slot, and the total is clamped to 94 — 95 is
  // reserved for the caller's pipeline-complete report.
  const slotFraction = {};
  const noteSlotProgress = (slot, f) => {
    slotFraction[slot] = Math.max(slotFraction[slot] || 0, Math.min(f, 0.85));
  };
  const progressFor = () => {
    const partial = Object.values(slotFraction).reduce((a, b) => a + b, 0);
    return Math.min(94, 75 + Math.round(((doneCount + partial) / slots.length) * 20));
  };
  const report = (text, pct) => onProgress(text, pct ?? progressFor());
  // Attempt-level ticker for one slot: attempt 1 is a silent progress-only tick
  // (text null — UI callbacks skip the log, keep the pct); retries emit a visible
  // "attempt N/M" line so a slow run demonstrably isn't a hung one.
  const attemptTicker = (slot) => {
    let ticks = 0;
    return ({ provider, attempt, total }) => {
      ticks++;
      noteSlotProgress(slot, 0.1 + ticks * 0.12);
      report(attempt > 1 ? `[ASSETS] ${slot}: ${provider} attempt ${attempt}/${total}...` : null);
    };
  };

  // Deterministic keying self-check — no vision model, works on the keyless free
  // path. Two failure smells after keying+cropping: almost nothing was removed
  // (gradient/vignette backdrop the flood couldn't latch onto), or the outer band of
  // the cropped sprite is full of opaque near-white pixels (leftover backdrop). Both
  // trigger one re-key with looser tolerances; the looser result is kept only when
  // it measurably improves without dissolving the sprite.
  const enforceKeyQuality = async (slot, spec, raw, img, chroma = null) => {
    if (!spec.post.keying) return img;
    const measure = (image) => {
      const canvas = drawToCanvas(image, { width: image.naturalWidth, height: image.naturalHeight, fit: 'stretch' });
      return {
        transparent: alphaFraction(canvas),
        residue: spec.post.crop ? borderResidueFraction(canvas, { chroma }) : 0,
        topBand: spec.post.crop ? 0 : topBandOpaqueFraction(canvas)
      };
    };
    const before = measure(img);

    // Non-cropped keyed slots are the parallax layers: their contract is "everything
    // above the shapes is empty", so surviving backdrop shows as an opaque top band.
    if (!spec.post.crop) {
      if (before.topBand <= 0.10) return img;
      report(`[ASSETS] Re-keying ${slot} (backdrop left in the top band)...`);
      const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 70, stepTol: 24 }, chroma });
      const after = measure(retried);
      return after.transparent < 0.97 && after.topBand < before.topBand ? retried : img;
    }

    // A cropped sprite that is >92% transparent inside its own bounding box got
    // shredded by the flood (it rode a gradient into the interior) — one TIGHTER
    // re-key, kept only when it restores real coverage without leaving residue.
    if (before.transparent > 0.92) {
      report(`[ASSETS] Re-keying ${slot} (keying removed too much)...`);
      const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 26, stepTol: 10 }, chroma });
      const after = measure(retried);
      const restored = after.transparent <= before.transparent - 0.1;
      return restored && after.residue <= 0.06 ? retried : img;
    }

    if (before.transparent >= 0.05 && before.residue <= 0.06) return img;
    report(`[ASSETS] Re-keying ${slot} (background leftovers detected)...`);
    const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 70, stepTol: 24 }, chroma });
    const after = measure(retried);
    const spriteSurvived = after.transparent < 0.97;
    const improved = after.residue < before.residue || (before.transparent < 0.05 && after.transparent >= 0.05);
    return spriteSurvived && improved ? retried : img;
  };

  // Vision QA pass for character sprites: verify facing + background on the FINAL
  // post-processed image, correct client-side (mirror / looser re-key / one regen).
  // QA never fails a slot — a null review just means "proceed unverified".
  const applyQualityAssurance = async (slot, spec, raw, img, prompt) => {
    const outcome = { qa: null, mirrored: false, facingVerified: false };
    // Deliberately NOT gated on runState.skipGemini: that flag tracks the IMAGE
    // model's quota, while QA uses the text/vision model whose quota is separate.
    // This is exactly the run where QA matters most — images fell back to the free
    // provider (weaker facing/pose adherence) but vision review still works.
    if (!spec.qa || !gemini.isGeminiConfigured()) return { img, outcome };

    const chroma = chromaFromPrompt(prompt);
    // Layers get their own review kind: their failure mode is rectangular vignette
    // "props" (mini paintings) rather than a wrong facing.
    const kind = spec.qa.clean ? 'layer' : 'sprite';
    const failed = (r) => r && (!r.backgroundClean || r.cutoutShapes === false);
    let review = await reviewSprite(img.src, { kind, label: `qa:${slot}` });
    if (failed(review)) {
      report(`[ASSETS] QA: re-keying ${slot} background...`);
      img = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 60, stepTol: 20 }, chroma });
      review = (await reviewSprite(img.src, { kind, label: `qa:${slot}` })) || review;
      // The regeneration below is a PAID full ladder walk — quality mode only.
      // The cost defaults keep the free corrections (re-key above, mirror below).
      if (failed(review) && runState.qualityMode) {
        report(`[ASSETS] QA: regenerating ${slot}...`);
        try {
          const retryRaw = await generateSlotImage(slot, prompt, seed + 1, report, maxAttemptsPerProvider, runState);
          const retryImg = await postProcessAsset(retryRaw.dataUrl, spec, { chroma });
          img = retryImg;
          review = (await reviewSprite(img.src, { kind, label: `qa:${slot}` })) || review;
        } catch (err) {
          console.warn(`[AssetPipeline] QA regeneration failed for "${slot}", keeping previous:`, err.message);
        }
      }
    }
    if (review && spec.qa.facing && !review.facingRight) {
      report(`[ASSETS] QA: mirroring ${slot} to face right...`);
      img = await mirrorImage(img);
      outcome.mirrored = true;
    }
    outcome.qa = review;
    outcome.facingVerified = !!review && !!spec.qa.facing;
    return { img, outcome };
  };

  // Sprite-sheet slots walk the normal Gemini ladder and fall back to their static
  // slot on ANY quality failure.
  const runSheetSlot = async (slot, spec, prompt) => {
    // Static base FIRST, sheet second. The finished static sprite (keyed, QA'd,
    // facing-corrected) is both (a) the identity reference for the sheet call —
    // on Gemini the sheet request is an image EDIT ("redraw this exact character
    // in nine poses") instead of a from-scratch imagination, which is what keeps
    // one consistent character across cells — and (b) the instant fallback when
    // the sheet fails any gate, with no third generation call.
    // If the static base itself dies, the whole slot rejects (player is required).
    await runSlot(spec.fallbackSlot);
    const baseSrc = preloadedImages[spec.fallbackSlot]?.src || null;

    let activeSpec = spec;
    // Quality mode pays for the 2K supersampled sheet; the default is the spec's 1K.
    if (runState.qualityMode && activeSpec.gen?.imageSize) {
      activeSpec = { ...activeSpec, gen: { ...activeSpec.gen, imageSize: '2K' } };
    }
    if (runState.modelOverrides?.player_sheet) {
      activeSpec = { ...activeSpec, gen: { ...activeSpec.gen, model: runState.modelOverrides.player_sheet } };
    }

    report(`[ASSETS] Generating animated ${spec.outputKey || slot}...`);
    const onAttempt = attemptTicker(slot);
    try {
      // Which backdrop the sheet prompt asked for — drives per-cell despill/residue.
      const chroma = chromaFromPrompt(prompt);
      // Decoded static base: the palette-lock reference and the identity anchor for
      // repair/escalation calls. Optional — a decode failure only skips the lock.
      let baseCanvas = null;
      if (baseSrc) {
        try {
          const baseImg = await loadImage(baseSrc);
          baseCanvas = drawToCanvas(baseImg, {
            width: baseImg.naturalWidth || baseImg.width,
            height: baseImg.naturalHeight || baseImg.height,
            fit: 'stretch'
          });
        } catch { /* palette lock is optional */ }
      }
      // A sheet whose cells kept a painted scene can't be keyed (non-uniform backdrop)
      // and would render the player as an opaque card — gate on transparency
      // deterministically, allow one regeneration, else fall back to static.
      const sheetTransparency = (img) => {
        const canvas = drawToCanvas(img, { width: img.naturalWidth, height: img.naturalHeight, fit: 'stretch' });
        return alphaFraction(canvas);
      };
      // ---- Shared single-frame machinery (repair rung + per-frame escalation) ----
      // Google's canonical edit phrasing: preservation language ("keep every
      // feature completely unchanged") + NAMED roles for each reference image.
      const framePrompt = (poseText, hasPrevFrame = false) =>
        (hasPrevFrame
          ? `You are given two images. Image 1 is the character reference; Image 2 is the ` +
            `previous animation frame — use it ONLY for pose continuity and scale. `
          : `You are given one image: the character reference. `) +
        `Redraw the exact character from Image 1, keeping every feature completely ` +
        `unchanged — same design, colors, outfit and held items, do not reinvent ` +
        `anything — in a new pose: ${poseText}. Full body in side profile facing right, ` +
        `same size and style as the reference, centered in the frame. ` +
        `${BG_CLAUSE(chroma)}. ${GAPS_CLAUSE}. No shadow, no ground, no motion lines, no text.`;

      // Sending a keyed (transparent) frame as a reference is ambiguous to the model —
      // compose it on white first.
      const onWhite = (canvas) => {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        return out.toDataURL('image/png');
      };

      // One reference-anchored image-edit for a single pose, keyed and edge-cleaned to
      // a cell canvas. Throws like any Gemini call — callers own abort bookkeeping.
      const generateSingleFrame = async (poseText, { width, height, extraRef = null, model = null }) => {
        runState.imageCalls++;
        const raw = await gemini.generateImage({
          prompt: framePrompt(poseText, !!extraRef),
          aspectRatio: '1:1',
          referenceImageDataUrls: extraRef ? [baseSrc, extraRef] : [baseSrc],
          model: model || activeSpec.gen.model,
          imageSize: '0.5K', // frames land on 128px cells — 512px is 4× supersampling
          label: 'player_sheet:frame'
        });
        const img = await loadImage(raw.dataUrl);
        const cell = drawToCanvas(img, { width, height, fit: 'stretch' });
        return cleanKeyedEdges(removeEnclosedPockets(keyCellWithQuality(cell, { chroma }), { chroma }), {
          erode: 1,
          outline: !!spec.post.outline,
          despill: chroma
        });
      };

      // Targeted repair: when the grid sheet is mostly good but a few frames failed
      // the scorer, redrawing JUST those frames (reference-anchored, the previous
      // healthy frame as a second reference for pose continuity) is far cheaper than
      // a full regeneration or the 10-call escalation. Only meaningful when cell
      // indices map 1:1 onto the canonical pose table (the Gemini 3×3 spec).
      const tryRepairFrames = async (cells, verdict) => {
        const badIndices = verdict.badIndices || [];
        const runCount = activeSpec.frames.runFrameCount;
        // ONCE per game — this used to fire on every sheet attempt (up to 3×) and
        // was a main driver of the observed ~$1.20/game bills.
        if (repairUsed) return null;
        if (!baseSrc || !gemini.isGeminiConfigured() || runState.skipGemini) return null;
        if (spec.poses?.run?.length !== runCount) return null;
        if (badIndices.length < 1 || badIndices.length > 3) return null;
        if (runState.imageCalls + badIndices.length > runState.maxImageCalls) return null;
        repairUsed = true;
        report(`[ASSETS] Repairing ${badIndices.length} bad frame(s) individually...`);
        const repaired = cells.slice();
        let calls = 0;
        for (const idx of badIndices) {
          const poseText = idx < runCount ? spec.poses.run[idx] : spec.poses.jump;
          if (!poseText) return null;
          const neighbor = idx > 0 && !badIndices.includes(idx - 1) ? repaired[idx - 1] : null;
          try {
            calls++;
            repaired[idx] = await generateSingleFrame(poseText, {
              width: cells[idx].width,
              height: cells[idx].height,
              extraRef: neighbor ? onWhite(neighbor) : null,
              // Flat-per-image billing makes repair frames on the sheet model cost
              // MORE than a whole new sheet (3 × $0.09 vs $0.09) — route repairs to
              // the cheaper fallback model; lockPalette + the re-verdict still gate
              // any style drift, and a failed repair just resumes the normal ladder.
              model: GEMINI_IMAGE_FALLBACK_MODEL
            });
            report(null);
          } catch (err) {
            console.warn(`[AssetPipeline] Frame repair failed (pose ${idx + 1}): ${err.message}`);
            if (err.kind === 'auth' || err.kind === 'no-key' ||
                (err.kind === 'quota' && (!err.retryDelayMs || err.retryDelayMs > 10000))) {
              runState.skipGemini = true;
            }
            return null;
          }
        }
        const reVerdict = evaluateAndCullCells(repaired, null, activeSpec.frames.runFrameCount);
        return reVerdict.issue ? null : { verdict: reVerdict, calls };
      };

      // Escalation rung: the cheap single-grid sheet failed its gates — draw every
      // pose as its OWN Gemini image-edit of the static reference. Per-frame identity
      // is far stronger than one grid image (each call re-anchors to the reference),
      // and the alignment pass in finalizeSheetFrames makes the independent frames
      // cohere. Hard-capped at 10 calls. Returns null on abort/insufficient
      // frames → static fallback.
      const generatePerFrameSheet = async () => {
        const runPoses = spec.poses?.run || [];
        const poses = spec.poses?.jump ? [...runPoses, spec.poses.jump] : [...runPoses];
        if (poses.length < 5) return null;
        report(`[ASSETS] Sheet failed its quality gates — drawing ${poses.length} poses individually via Gemini...`);

        const results = new Array(poses.length).fill(null);
        let calls = 0;
        let retryBudget = 1;
        let done = 0;
        let aborted = false;
        const runFrame = async (idx) => {
          for (let frameAttempt = 1; frameAttempt <= 2 && !results[idx] && !aborted; frameAttempt++) {
            if (calls >= 10 || runState.imageCalls >= runState.maxImageCalls) return;
            if (frameAttempt === 2) {
              if (retryBudget <= 0) return;
              retryBudget--;
            }
            calls++;
            try {
              results[idx] = await generateSingleFrame(poses[idx], { width: 128, height: 128 });
              done++;
              noteSlotProgress(slot, 0.5 + (done / poses.length) * 0.3);
              report(null);
            } catch (err) {
              console.warn(`[AssetPipeline] Per-frame pose ${idx + 1} failed: ${err.message}`);
              if (err.kind === 'auth' || err.kind === 'no-key') { runState.skipGemini = true; aborted = true; return; }
              if (err.kind === 'quota') {
                if (!err.retryDelayMs || err.retryDelayMs > 10000) { runState.skipGemini = true; aborted = true; return; }
                await sleep(err.retryDelayMs);
              }
            }
          }
        };
        const queue = poses.map((_, i) => i);
        await Promise.all(Array.from({ length: 3 }, async () => {
          while (queue.length && !aborted) await runFrame(queue.shift());
        }));
        if (aborted) return null;

        // Preserve run order; a missing jump frame just omits the trailing cell.
        const runCells = results.slice(0, runPoses.length).filter(Boolean);
        const jumpCell = spec.poses?.jump ? results[runPoses.length] : null;
        const candidate = jumpCell ? [...runCells, jumpCell] : runCells;
        const verdict = evaluateAndCullCells(candidate, null, runCells.length);
        if (verdict.issue) {
          console.warn(`[AssetPipeline] Per-frame sheet rejected: ${verdict.issue}.`);
          return null;
        }
        let keptCells = verdict.keptCells;
        if (baseCanvas) keptCells = lockPalette(keptCells, baseCanvas);
        // Numbered-strip vision check: facing (client-side mirror) + identity. The
        // frames are individually choreographed, so legsAlternate pressure doesn't
        // apply — but "different character per frame" is still terminal here.
        const strip = composeFilmstrip(keptCells);
        const pfReview = await reviewSprite(strip.toDataURL('image/png'), {
          kind: 'strip',
          label: 'qa:player_sheet',
          grid: { frameCount: keptCells.length, runFrameCount: verdict.framesMeta.runFrameCount }
        });
        if (pfReview && pfReview.sameCharacter === false) return null;
        const pfMirrored = !!(pfReview && pfReview.facingRight === false);
        const finalSheet = await finalizeSheetFrames(keptCells, activeSpec, { mirror: pfMirrored, framesMeta: verdict.framesMeta });
        return finalSheet && { sheet: finalSheet, review: pfReview, mirrored: pfMirrored, calls };
      };

      let sheet = null;
      // A finished sheet rejected only for a SOFT cosmetic verdict (frozen arms /
      // no leg swap) — ships if no later attempt produces something better.
      let softCandidate = null;
      let review = null;
      let mirrored = false;
      let provider = null;
      let servedModel = null;
      let attempts = 0;
      let perFrame = false;
      let repairUsed = false;
      let lastIssue = 'unknown';
      // Attempt 3 is the premium rescue: ONE gemini-3-pro-image sheet before the
      // 10-call per-frame escalation. QUALITY MODE ONLY — the cost defaults stop
      // at the static player instead of paying for rescues.
      const proRescue = !!(runState.qualityMode && gemini.isGeminiConfigured() &&
        activeSpec.gen.model && activeSpec.gen.model !== GEMINI_PRO_SHEET_MODEL);
      const maxSheetAttempts = proRescue ? 3 : 2;
      for (let attempt = 1; attempt <= maxSheetAttempts && !sheet; attempt++) {
        if (runState.cancelToken?.cancelled) throw cancelledError();
        if (attempt === 3 && runState.skipGemini) break;
        // Model ladder (2026-08-16): attempt 1 runs the spec default (the cheap
        // 2.5 model since the cost flip), attempt 2 ESCALATES to the 3.1 sheet
        // model whose choreography is markedly stronger — pay for the premium
        // tier only when the cheap tier failed a gate. Attempt 3 (quality mode)
        // stays the pro rescue.
        const escalate = attempt === 2 && activeSpec.gen.model !== GEMINI_SHEET_MODEL;
        if (attempt > 1) {
          report(attempt === 3
            ? `[ASSETS] Sheet ${lastIssue} — trying the premium image model...`
            : escalate
              ? `[ASSETS] Sheet ${lastIssue} — retrying on the stronger sheet model...`
              : `[ASSETS] Sheet ${lastIssue}, regenerating...`);
        }
        const attemptSpec = attempt === 3
          ? { ...activeSpec, gen: { ...activeSpec.gen, model: GEMINI_PRO_SHEET_MODEL } }
          : escalate
            ? { ...activeSpec, gen: { ...activeSpec.gen, model: GEMINI_SHEET_MODEL } }
            : activeSpec;
        // The sheet is an image-editing call anchored to the static base; the
        // prompt preamble tells the model the attachment IS the character.
        const useReference = baseSrc && gemini.isGeminiConfigured() && !runState.skipGemini;
        const sheetPrompt = useReference
          ? `Using the provided image of the character, redraw THIS EXACT character — keep ` +
            `every feature completely unchanged, do not reinvent anything about it — as the ` +
            `following sprite strip. ${prompt}`
          : prompt;
        const raw = await generateSlotImage(slot, sheetPrompt, seed + attempt * 13, report, maxAttemptsPerProvider, runState, onAttempt, useReference ? baseSrc : null, attemptSpec);
        noteSlotProgress(slot, 0.8);
        provider = raw.provider;
        servedModel = raw.model || servedModel;
        attempts += raw.attempts;
        // Debug capture (in-memory, $0): the raw sheet + every verdict accrue on
        // this record — __PM_SHEET_DEBUG.download() after a run hands over full
        // diagnostic material, replay() re-scores it offline.
        const dbg = recordSheetAttempt({
          attempt,
          model: raw.model || attemptSpec.gen.model,
          prompt: sheetPrompt,
          rawDataUrl: raw.dataUrl,
          chroma,
          baseSrc
        });
        // Cells are keyed INDIVIDUALLY — whole-sheet flood keying can never reach the
        // backdrop of interior cells
        const processed = await processSheet(raw.dataUrl, attemptSpec, { chroma });
        const previewImg = processed.previewImg;
        dbg.slicedLayout = processed.layout; // which candidate layout the slicer picked
        // Trim the prompted-empty trailing cell(s) before scoring — the layout
        // carries a blank 6th cell so the 5 real frames get a clean 3×2 grid.
        const cells = processed.cells.slice(0, attemptSpec.frames.usedCells ?? processed.cells.length);
        if (sheetTransparency(previewImg) < attemptSpec.post.minAlphaFraction) {
          lastIssue = 'kept a painted background';
          dbg.scorerIssue = lastIssue;
          continue;
        }
        // gridMeta null → ALWAYS rebuild a 1×N strip: the grid meta describes 6
        // cells including the blank, which must never register as a frame.
        let verdict = evaluateAndCullCells(cells, null, attemptSpec.frames.runFrameCount);
        if (verdict.issue) {
          // Repair rung: a handful of scorer-flagged frames get individually
          // redrawn — but ONLY on the LAST attempt (2026-08-16): while a cheaper
          // escalation rung remains, escalating (~one call) beats repairing 2-3
          // frames (2-3 calls at flat per-image prices). On the final attempt
          // repair is what stands between the sheet and the static fallback.
          const repaired = attempt === maxSheetAttempts ? await tryRepairFrames(cells, verdict) : null;
          if (repaired) {
            attempts += repaired.calls;
            verdict = repaired.verdict;
          } else {
            lastIssue = verdict.issue;
            dbg.scorerIssue = lastIssue;
            dbg.badIndices = verdict.badIndices;
            continue;
          }
        }
        // Vision double-check on a numbered filmstrip of exactly the frames that will
        // ship — per-frame verdicts (badFrames) feed one final cull, whole-strip
        // verdicts (different characters / legs never swap) fail the attempt.
        const stripMeta = verdict.framesMeta;
        review = await reviewSprite(composeFilmstrip(verdict.keptCells).toDataURL('image/png'), {
          kind: 'strip',
          label: 'qa:player_sheet',
          grid: { frameCount: verdict.keptCells.length, runFrameCount: stripMeta.runFrameCount ?? verdict.keptCells.length }
        });
        dbg.review = review;
        // Cost rule: vision verdicts are cull-only except the one terminal case
        // (wrong character) — a failed attempt here means another PAID generation,
        // so imperfect-but-coherent strips ship instead of being redone.
        if (review && review.sameCharacter === false) {
          lastIssue = 'looks like different characters (vision QA)';
          dbg.scorerIssue = lastIssue;
          continue;
        }
        // SOFT verdicts (legs never alternate / arms frozen) are cosmetic — they
        // are detected here but handled AFTER finalize: the working sheet is kept
        // as a standby candidate while one escalation tries for a better roll.
        // Discarding a soft-flawed sheet outright was a live failure 2026-08-16:
        // the arms gate threw away a good lite sheet, the premium re-roll broke
        // identity, and the game shipped the static bob at full price.
        // Per-frame leadingLeg answers (when present and sane) beat the lazy
        // whole-strip boolean: the judge is forced to commit per frame, and the
        // code derives alternation — a real cycle names BOTH 'left' and 'right'.
        const leading = Array.isArray(review?.leadingLeg) ? review.leadingLeg : null;
        const legsOk = leading && leading.length >= 2
          ? (leading.includes('left') && leading.includes('right'))
          : review?.legsAlternate;
        const softIssue = review
          ? (legsOk === false ? 'run cycle legs never alternate'
            : (review.armsSwing === false ? 'arms never swing' : null))
          : null;
        const visionBadSet = new Set((review?.badFrames || []).map((n) => n - 1)
          .filter((n) => n >= 0 && n < verdict.keptCells.length));
        if (visionBadSet.size) {
          const culled = cullFromKept(verdict.keptCells, stripMeta, visionBadSet);
          if (culled) {
            verdict = { ...verdict, ...culled, dropped: (verdict.dropped || 0) + visionBadSet.size };
          } else {
            console.warn('[AssetPipeline] Vision flagged more frames than can be culled — shipping the strip as-is.');
          }
        }
        // Deterministic cycle ASSEMBLY from the judge's per-frame leg labels
        // (2026-08-16, "legs switch very rarely"): models bias the cycle — pass
        // frames drawn as extra right-lead strides leave one left-lead frame in
        // four. Instead of trusting the model's cell order/balance, rebuild the
        // run as [right-stride, pass, left-stride, pass]: first right-lead and
        // first left-lead frame become the strides, neutral frames fill the
        // passes (reusing one neutral for both slots is a legitimate cycle
        // repeat), and biased stride DUPLICATES are dropped. No neutral at all →
        // the 2-frame [right, left] alternation (choppy but alternating beats
        // smooth-and-biased). Idempotent on a correct sheet; missing stride
        // labels already failed legsOk above. $0 — pure reordering.
        {
          const reviewRunCount = stripMeta.runFrameCount ?? verdict.keptCells.length;
          let labels = Array.isArray(review?.leadingLeg) && review.leadingLeg.length >= reviewRunCount
            ? review.leadingLeg.slice(0, reviewRunCount)
            : null;
          if (labels && visionBadSet.size) labels = labels.filter((_, i) => !visionBadSet.has(i));
          const metaNow = verdict.framesMeta;
          const runNow = metaNow.runFrameCount ?? verdict.keptCells.length;
          if (labels && labels.length === runNow && runNow >= 2) {
            const runCells = verdict.keptCells.slice(0, runNow);
            const hasDedicatedJump = metaNow.jumpFrameIndex != null && metaNow.jumpFrameIndex >= runNow;
            const jumpCellNow = hasDedicatedJump ? verdict.keptCells[verdict.keptCells.length - 1] : null;
            const jumpSrc = !hasDedicatedJump && metaNow.jumpFrameIndex != null ? runCells[metaNow.jumpFrameIndex] : null;
            const idxR = labels.indexOf('right');
            const idxL = labels.indexOf('left');
            if (idxR >= 0 && idxL >= 0) {
              const neutrals = labels
                .map((v, i) => (v !== 'right' && v !== 'left' ? i : -1))
                .filter((i) => i >= 0);
              const newRun = neutrals.length
                ? [runCells[idxR], runCells[neutrals[0]], runCells[idxL], runCells[neutrals[1] ?? neutrals[0]]]
                : [runCells[idxR], runCells[idxL]];
              const ji = jumpSrc ? newRun.indexOf(jumpSrc) : -1;
              const cellsOut = jumpCellNow ? [...newRun, jumpCellNow] : newRun;
              verdict = {
                ...verdict,
                keptCells: cellsOut,
                framesMeta: {
                  cols: cellsOut.length,
                  rows: 1,
                  runFrameCount: newRun.length,
                  ...(jumpCellNow ? { jumpFrameIndex: newRun.length } : (ji >= 0 ? { jumpFrameIndex: ji } : {}))
                }
              };
              dbg.resequenced = { labels, order: ['right', neutrals.length ? 'pass' : null, 'left', neutrals.length ? 'pass' : null].filter(Boolean) };
            }
          }
        }
        // Shared-palette lock against the static reference — kills per-frame color
        // flicker; its internal guard skips frames whose colors genuinely diverged.
        let keptCells = verdict.keptCells;
        if (baseCanvas) keptCells = lockPalette(keptCells, baseCanvas);
        mirrored = !!(review && review.facingRight === false);
        sheet = await finalizeSheetFrames(keptCells, activeSpec, { mirror: mirrored, framesMeta: verdict.framesMeta });
        if (!sheet) {
          lastIssue = 'had no visible content';
          dbg.scorerIssue = lastIssue;
        } else if (softIssue && attempt < maxSheetAttempts) {
          // Keep the WORKING sheet as the standby candidate and spend one
          // escalation on a better roll — never discard a usable animation.
          softCandidate = { sheet, review, mirrored, model: raw.model || attemptSpec.gen.model, dbg };
          lastIssue = `${softIssue} (vision QA)`;
          dbg.scorerIssue = lastIssue;
          dbg.outcome = 'soft-rejected (kept as standby)';
          dbg.framesMeta = sheet.frames;
          sheet = null; // loop continues to the stronger rung; candidate stands by
        } else {
          if (softIssue) {
            report(`[ASSETS] ${softIssue} on the final attempt — shipping best effort.`);
            dbg.outcome = 'shipped-best-effort';
          }
          dbg.outcome = dbg.outcome || 'shipped';
          dbg.framesMeta = sheet.frames;
          if (verdict.dropped) {
            report(`[ASSETS] Dropped ${verdict.dropped} inconsistent frame(s) from the run cycle`);
          }
        }
      }

      // Escalation didn't produce a better sheet — ship the standby candidate
      // rather than falling back to the static player (an animated sheet with
      // frozen arms beats a tilting statue, and it is already paid for).
      if (!sheet && softCandidate) {
        sheet = softCandidate.sheet;
        review = softCandidate.review;
        mirrored = softCandidate.mirrored;
        servedModel = softCandidate.model || servedModel;
        softCandidate.dbg.outcome = 'shipped (standby after escalation failed)';
        report('[ASSETS] Escalation did not improve the sheet — shipping the earlier animated version.');
      }

      // Per-frame escalation: quality mode only, and only within the call budget.
      if (!sheet && baseSrc && runState.qualityMode && gemini.isGeminiConfigured() &&
          !runState.skipGemini && runState.imageCalls < runState.maxImageCalls) {
        const escalated = await generatePerFrameSheet();
        if (escalated) {
          sheet = escalated.sheet;
          review = escalated.review;
          mirrored = escalated.mirrored;
          provider = 'gemini';
          servedModel = servedModel || activeSpec.gen.model;
          attempts += escalated.calls;
          perFrame = true;
        }
      }
      if (!sheet) throw new Error(`sheet ${lastIssue}`);

      const outKey = spec.outputKey || slot;
      preloadedImages[outKey] = sheet.img;
      meta[outKey] = {
        provider, attempts, promptUsed: prompt,
        ...(servedModel ? { model: servedModel } : {}),
        qa: review, mirrored, facingVerified: !!review,
        sheet: true, perFrame, frames: sheet.frames
      };
      delete slotFraction[slot];
      // No doneCount++ here: the static base already counted this slot when it
      // landed; the sheet is an upgrade of the same output key, not a new slot.
      report(`[ASSETS] Upgraded: animated ${outKey} via ${provider}${perFrame ? ' (per-frame)' : ''}`);
    } catch (err) {
      if (err.cancelled) throw err; // cancellation rejects the run, never "keep static"
      // The static base is already generated, keyed and registered — keep it.
      console.warn(`[AssetPipeline] Sprite sheet failed (${err.message}) — keeping the static "${spec.fallbackSlot}" sprite.`);
      report(`[ASSETS] Animated player unavailable, keeping static sprite.`);
      recordSheetAttempt({ outcome: 'static-fallback', reason: err.message });
      delete slotFraction[slot];
    }
  };

  const runSlot = async (slot) => {
    if (cancelToken?.cancelled) throw cancelledError();
    const prompt = finalPrompts[slot];
    if (!prompt) throw new Error(`No prompt provided for asset slot "${slot}".`);
    const spec = SLOT_SPECS[slot];
    if (spec.frames) return runSheetSlot(slot, spec, prompt);
    // Probe override (PM_MODEL_PLAYER): swap the generation model for this slot
    // only — post-processing/QA read the unchanged contract fields.
    const override = runState.modelOverrides?.[slot];
    const genSpec = override ? { ...spec, gen: { ...spec.gen, model: override } } : null;
    report(`[ASSETS] Generating ${slot}...`);
    const onAttempt = attemptTicker(slot);
    try {
      // Overlay layers that failed to key out (still mostly opaque) would cover the
      // layers behind them — reject so the optional-slot path drops them. The model
      // sometimes ignores the white-region instruction, so allow one fresh attempt.
      const checkTransparency = (img) => {
        if (!spec.post.minAlphaFraction) return null;
        const canvas = drawToCanvas(img, { width: img.naturalWidth, height: img.naturalHeight, fit: 'stretch' });
        const fraction = alphaFraction(canvas);
        if (fraction < spec.post.minAlphaFraction) {
          return `layer kept too little transparency (${Math.round(fraction * 100)}% transparent)`;
        }
        // A layer can pass the global transparency bar and still carry a painted sky —
        // the strip contract is a mostly-empty top band, so gate on that too.
        const topBand = topBandOpaqueFraction(canvas);
        return topBand > 0.35
          ? `layer kept a painted sky (${Math.round(topBand * 100)}% of the top band opaque)`
          : null;
      };
      const attemptOnce = async (attemptSeed, attemptPrompt) => {
        const raw = await generateSlotImage(slot, attemptPrompt, attemptSeed, report, maxAttemptsPerProvider, runState, onAttempt, null, genSpec);
        noteSlotProgress(slot, 0.8);
        // The prompt is the single source of truth for which backdrop was asked for —
        // keying itself is color-agnostic, but residue checks and despill need it.
        const chroma = chromaFromPrompt(attemptPrompt);
        let img = await postProcessAsset(raw.dataUrl, spec, { chroma });
        img = await enforceKeyQuality(slot, spec, raw, img, chroma);
        const { img: finalImg, outcome } = await applyQualityAssurance(slot, spec, raw, img, attemptPrompt);
        return { raw, finalImg, outcome };
      };

      // Vision verdict "not cutout shapes" (vignette panels) is as disqualifying for a
      // layer as failed keying — both feed the same retry-then-drop ladder.
      const layerIssue = (res) => checkTransparency(res.finalImg) ||
        (spec.optional && res.outcome.qa?.cutoutShapes === false
          ? 'layer is picture panels, not cutout shapes (vision QA)'
          : null);

      let result = await attemptOnce(seed, prompt);
      let qualityIssue = layerIssue(result);
      if (qualityIssue && spec.optional) {
        report(`[ASSETS] Retrying ${slot} (${qualityIssue})...`);
        // Harsher variant: the model painted a full scene — demand cutouts explicitly
        const strictPrompt = prompt +
          ', IMPORTANT: only flat solid silhouette cutout shapes on an empty pure white background, ' +
          'like paper cutouts, at least the upper half of the image must be completely blank white, ' +
          'absolutely no rectangular panels, no framed pictures, no scenery patches';
        result = await attemptOnce(seed + 7, strictPrompt);
        qualityIssue = layerIssue(result);
      }
      if (qualityIssue) throw new Error(qualityIssue);

      preloadedImages[slot] = result.finalImg;
      meta[slot] = {
        provider: result.raw.provider,
        attempts: result.raw.attempts,
        promptUsed: prompt,
        ...(result.raw.model ? { model: result.raw.model } : {}),
        ...result.outcome
      };
      delete slotFraction[slot];
      doneCount++;
      report(`[ASSETS] Ready: ${slot} via ${result.raw.provider} (${doneCount}/${slots.length})`);
    } catch (err) {
      // A cancelled run rejects outright — never "drop optional and continue".
      if (err.cancelled) {
        fatal = true;
        throw err;
      }
      if (spec.optional) {
        // Optional layers degrade gracefully — the game filters missing textures
        console.warn(`[AssetPipeline] Dropping optional slot "${slot}": ${err.message}`);
        meta[slot] = { dropped: true, reason: err.message };
        delete slotFraction[slot];
        doneCount++;
        report(`[ASSETS] Skipped optional layer ${slot} (${doneCount}/${slots.length})`);
        return;
      }
      const message = `[Asset Pipeline Error] Failed to generate "${slot}".\n• Prompt: "${prompt}"\n• Reason: ${err.message}`;
      console.error(message);
      fatal = true;
      throw new Error(message);
    }
  };

  // Combined-props call (PM_GRID_PROPS): ONE image call delivers all grid member
  // slots; each cell is sliced raw and pushed through that slot's normal
  // single-slot chain (postProcessAsset → enforceKeyQuality → QA) so every
  // existing quality gate runs unchanged. Any cell that fails — or the whole
  // call — falls back to the slot's normal individual path: worst case is
  // today's behavior plus one wasted lite call.
  const runPropsGrid = async (plan) => {
    const members = plan.cellSlots;
    const fallbackSlots = (list) => {
      for (const s of list) {
        if (SLOT_SPECS[s].optional) queue.push(s); // keeps the retry-then-drop tail position
        else queue.unshift(s);                     // required slots go first
      }
    };
    if (cancelToken?.cancelled) throw cancelledError();
    report(`[ASSETS] Generating ${members.length} props in one combined call...`);
    const onAttempt = attemptTicker('props_grid');
    members.forEach((s) => noteSlotProgress(s, 0.25));
    let raw;
    try {
      raw = await generateSlotImage('props_grid', plan.prompt, seed, report,
        maxAttemptsPerProvider, runState, onAttempt, null,
        { gen: { aspectRatio: plan.layout.aspectRatio, model: PROPS_GRID_SPEC.gen.model } });
    } catch (err) {
      if (err.cancelled) { fatal = true; throw err; }
      console.warn(`[AssetPipeline] Combined props call failed (${err.message}) — falling back to individual slots.`);
      delete slotFraction['props_grid'];
      fallbackSlots(members);
      return;
    }
    members.forEach((s) => noteSlotProgress(s, 0.6));
    let cellUrls = null;
    try {
      cellUrls = await sliceRawGrid(raw.dataUrl, plan.layout);
    } catch (err) {
      console.warn(`[AssetPipeline] Grid slicing failed (${err.message}) — falling back to individual slots.`);
    }
    if (!cellUrls) {
      delete slotFraction['props_grid'];
      fallbackSlots(members);
      return;
    }
    const chroma = chromaFromPrompt(plan.prompt);
    for (let i = 0; i < members.length; i++) {
      const slot = members[i];
      const spec = SLOT_SPECS[slot];
      const cellUrl = cellUrls[i];
      try {
        if (!cellUrl) throw new Error('grid cut produced a degenerate cell');
        let img = await postProcessAsset(cellUrl, spec, { chroma });
        img = await enforceKeyQuality(slot, spec, { dataUrl: cellUrl }, img, chroma);
        // Deterministic acceptance: the processed cell must contain real art. Keying
        // quality is enforceKeyQuality's job (same as the individual path); this
        // gate only catches empty/sliver cells the model or the cuts produced.
        const canvas = drawToCanvas(img, { width: img.naturalWidth, height: img.naturalHeight, fit: 'stretch' });
        const bounds = contentBoundsOf(canvas, { alphaMin: 16 });
        if (!bounds ||
            (bounds.maxX - bounds.minX + 1) < canvas.width * 0.1 ||
            (bounds.maxY - bounds.minY + 1) < canvas.height * 0.1) {
          throw new Error('grid cell had no usable content');
        }
        let outcome = { qa: null, mirrored: false, facingVerified: false };
        if (spec.qa) {
          const reviewed = await applyQualityAssurance(slot, spec, { dataUrl: cellUrl }, img, plan.prompt);
          img = reviewed.img;
          outcome = reviewed.outcome;
        }
        preloadedImages[slot] = img;
        meta[slot] = {
          provider: raw.provider,
          attempts: raw.attempts,
          promptUsed: plan.prompt,
          ...(raw.model ? { model: raw.model } : {}),
          via: 'props_grid',
          ...outcome
        };
        delete slotFraction[slot];
        doneCount++;
        report(`[ASSETS] Ready: ${slot} via combined props call (${doneCount}/${slots.length})`);
      } catch (err) {
        if (err.cancelled) { fatal = true; throw err; }
        console.warn(`[AssetPipeline] Grid cell for "${slot}" rejected (${err.message}) — individual fallback.`);
        fallbackSlots([slot]);
      }
    }
    delete slotFraction['props_grid'];
  };

  // Simple promise pool: at most `concurrency` slots in flight (a full 6-wide
  // burst just converts into image-model 429s)
  const queue = [...slots];
  // Grid task first (its members are the required gameplay props — same "playable
  // core before optional layers" FIFO rule as the plain slot order). It only runs
  // when EVERY member is in this run's slot list — a partial overlap would desync
  // the prompt's cell order from the slice order.
  let activeGrid = null;
  if (gridPlan && !runState.qualityMode && gridPlan.cellSlots.every((s) => queue.includes(s))) {
    activeGrid = gridPlan;
    for (const s of gridPlan.cellSlots) queue.splice(queue.indexOf(s), 1);
    queue.unshift('__props_grid__');
  }
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0 && !fatal && !cancelToken?.cancelled) {
      const item = queue.shift();
      if (item === '__props_grid__') await runPropsGrid(activeGrid);
      else await runSlot(item);
    }
  });
  await Promise.all(workers);
  if (cancelToken?.cancelled) throw cancelledError();

  return { preloadedImages, meta };
}

const DESIGN_SOURCE_LABELS = {
  gemini: 'Gemini art director',
  local: 'local templates'
};

// Combined-props eligibility (DEFAULT ON since 2026-08-16; PM_GRID_PROPS='0' is
// the kill switch — read at run start like the other cost knobs): ≥3 grid-able
// slots in this run — a restyle or partial redraw of 1-2 props stays on the
// individual path by construction. Returns the grid plan or null (kill switch,
// quality mode, too few slots, or the chroma pick collided to white).
function planPropsGrid(slots, design, namedBySlot, onProgress) {
  if (localStorage.getItem('PM_GRID_PROPS') === '0') return null;
  // Quality mode pays for individual calls + rescue rungs — never gridded.
  if (localStorage.getItem('PM_QUALITY_MODE') === '1') return null;
  const gridSlots = PROPS_GRID_SPEC.cellOrder.filter((s) => slots.includes(s));
  if (gridSlots.length < 3) return null;
  const plan = buildPropsGridPrompt(gridSlots, design.subjects, design.styleGuide, namedBySlot);
  // Every skip is VISIBLE — a silent bail made "why didn't the price drop"
  // undiagnosable from the terminal.
  onProgress(plan
    ? `[ASSETS] Combined props call: ${gridSlots.join(', ')} in one image.`
    : `[ASSETS] Combined props call skipped (green+magenta subject collision) — individual calls.`,
  null);
  return plan;
}

// Stamp each generated slot's meta with its canonical entity noun (design.taxonomy:
// LLM-tagged when the designer ran, user-named/local otherwise). Cache and search
// metadata only — never read by gameplay code. The sheet's output lands under the
// 'player' key, so taxonomy slot names line up with meta keys as-is.
function attachEntityTags(meta, design) {
  const ents = design.taxonomy?.entities || {};
  for (const [slot, noun] of Object.entries(ents)) {
    if (meta[slot] && !meta[slot].dropped) meta[slot].entity = noun;
  }
}

/**
 * Full generation for a game config: design prompts (LLM or local), then generate
 * all baseline assets. The ONE call every UI path uses.
 * Gemini is the only image provider — without a configured key this rejects
 * immediately, and every caller downgrades to built-in static theme art.
 */
export async function generateGameAssets({ config, userPrompt = '', onProgress = () => {}, cancelToken = null, skipSlots = [] }) {
  if (!gemini.isGeminiConfigured()) {
    throw new Error('No Gemini API key configured — AI asset generation requires a key.');
  }
  gemini.resetUsageTally();
  const design = await designAssetPrompts({
    userPrompt,
    gameType: config.gameType,
    themeKey: config.themeKey,
    assetDesignDirections: config.assetDesignDirections
  });
  onProgress(`[DESIGN] Asset prompts composed via ${DESIGN_SOURCE_LABELS[design.source] || design.source}...`, 73);

  // Slots whose entity the user explicitly named get identity-first styling
  // (natural colors + accent rim-light) instead of accent-as-dominant.
  const namedBySlot = {
    enemy: design.entities?.enemy,
    obstacle: design.entities?.hazard,
    collectible: design.entities?.collectible
  };
  const finalPrompts = {};
  for (const slot of [...GENERATED_SLOTS, 'player_sheet', 'projectile', 'collectible']) {
    finalPrompts[slot] = buildFinalPrompt(slot, design.subjects, design.styleGuide,
      { userNamed: !!namedBySlot[slot] });
  }

  // The player is always attempted as an animated sprite sheet (stored under the
  // 'player' key), falling back to the static player sprite when the gates reject.
  // GENERATED_SLOTS order matters: required gameplay slots precede the optional
  // parallax layers, so the FIFO worker pool finishes the playable core first —
  // keep it that way.
  // skipSlots (bulk population): 'player' in the list means NO player art at all
  // (neither sheet nor static — the scene falls back to the theme player); other
  // slot names are simply filtered out of the run.
  let slots = GENERATED_SLOTS.map(s => (s === 'player' && !skipSlots.includes('player') ? 'player_sheet' : s));
  // Platformer games shoot — generate their projectile too (optional slot: on failure
  // the game keeps its static SVG bolt). Runners never fire, skip the cost.
  if (config.gameType === 'platformer') slots.push('projectile');
  // Both modes spawn score pickups (optional slot: on failure the game keeps the
  // static coin.svg). Last in the FIFO so required slots always come first.
  slots.push('collectible');
  slots = slots.filter(s => !skipSlots.includes(s));

  const gridPlan = planPropsGrid(slots, design, namedBySlot, onProgress);
  const { preloadedImages, meta } = await generateAssets({ finalPrompts, slots, onProgress, cancelToken, gridPlan });

  const generated = Object.values(meta).filter(m => !m.dropped).length;
  onProgress(
    `[ASSETS] Complete — ${generated} image(s) generated via Gemini. ` +
    `Prompt design: ${design.source}.`,
    95
  );
  const cost = reportRunCost(onProgress);

  // assetMeta rides on the game config so provider usage stays inspectable after
  // generation (DevTools: window.__GAME_LIVE_CONFIG.assetMeta)
  attachEntityTags(meta, design);
  if (design.taxonomy?.tags?.length) {
    onProgress(`[DESIGN] Tags: ${design.taxonomy.tags.join(', ')}`, null);
  }
  const assetMeta = {
    designSource: design.source,
    // Perspective the art was drawn for. Everything today is side-view; future
    // top-down modes (shooter/RPG) stamp 'topdown' and the cache matcher refuses
    // to reuse across views (a profile sprite is unusable from above).
    view: 'side',
    slots: meta,
    ...(design.taxonomy?.tags?.length ? { tags: design.taxonomy.tags } : {}),
    ...(cost ? { cost } : {})
  };
  return { preloadedImages, meta, promptSet: finalPrompts, design, assetMeta };
}

// Estimated spend line for the terminal (skipped on all-free runs). The number
// comes from usageMetadata + a static price table — an estimate, not a bill.
function reportRunCost(onProgress) {
  const cost = gemini.getUsageTally();
  if (!cost || (!cost.imageCalls && !cost.visionCalls)) return null;
  const failures = (cost.imageFailures || 0) + (cost.visionFailures || 0);
  onProgress(
    `[COST] ≈ $${cost.estUsd.toFixed(2)} estimated — ${cost.imageCalls} image call(s), ` +
    `${cost.visionCalls} vision call(s)` +
    (cost.thoughtsTokens ? `, ${cost.thoughtsTokens} thinking tokens` : '') +
    (failures ? `, ${failures} FAILED call(s)` : ''),
    95
  );
  return cost;
}

/**
 * Cherry-pick regeneration: redo ONLY the requested slots for an already-running
 * game (Creator Panel "restyle" intent). The edit instruction steers the prompt
 * designer so the new art follows the request; the caller merges the returned
 * images/meta over the retained ones and remounts the game.
 */
export async function regenerateAssetSlots({ config, instruction = '', slots, onProgress = () => {}, cancelToken = null }) {
  if (!gemini.isGeminiConfigured()) {
    throw new Error('No Gemini API key configured — asset regeneration requires a key.');
  }
  gemini.resetUsageTally();
  // The instruction IS the art direction for a restyle. Reusing the original
  // assetDesignDirections would make the keyless path regenerate the same subjects
  // and silently ignore the request; a theme word in the instruction ("lava world")
  // selects the matching local theme table instead.
  const parsedTheme = instruction.trim() ? parsePromptKeywords(instruction).themeKey : null;
  const design = await designAssetPrompts({
    userPrompt: instruction,
    gameType: config.gameType,
    themeKey: parsedTheme || config.themeKey,
    assetDesignDirections: instruction.trim() ? null : config.assetDesignDirections
  });
  onProgress(`[DESIGN] Asset prompts composed via ${DESIGN_SOURCE_LABELS[design.source] || design.source}...`, 73);

  const namedBySlot = {
    enemy: design.entities?.enemy,
    obstacle: design.entities?.hazard,
    collectible: design.entities?.collectible
  };
  const finalPrompts = {};
  for (const slot of slots) {
    finalPrompts[slot] = buildFinalPrompt(slot, design.subjects, design.styleGuide,
      { userNamed: !!namedBySlot[slot] });
    // Sheet slots fall back to their static slot on gate failure — that fallback
    // run needs its own prompt present.
    const fallbackSlot = SLOT_SPECS[slot].fallbackSlot;
    if (fallbackSlot && !finalPrompts[fallbackSlot]) {
      finalPrompts[fallbackSlot] = buildFinalPrompt(fallbackSlot, design.subjects, design.styleGuide);
    }
  }

  const gridPlan = planPropsGrid(slots, design, namedBySlot, onProgress);
  const { preloadedImages, meta } = await generateAssets({ finalPrompts, slots, onProgress, cancelToken, gridPlan });

  const updated = Object.values(meta).filter(m => !m.dropped).length;
  onProgress(
    `[ASSETS] Updated ${updated}/${slots.length} slot(s) via Gemini.`,
    95
  );
  const cost = reportRunCost(onProgress);
  attachEntityTags(meta, design);
  if (design.taxonomy?.tags?.length) {
    onProgress(`[DESIGN] Tags: ${design.taxonomy.tags.join(', ')}`, null);
  }
  return { preloadedImages, meta, design, cost };
}
