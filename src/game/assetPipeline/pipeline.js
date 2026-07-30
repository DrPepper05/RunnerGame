/**
 * Asset generation pipeline — the single entry point for every generation path
 * (ScreenZero prompt flow, App.jsx prompt flow, CreatorPanel regeneration).
 *
 * Per slot: Gemini (when configured) with retry → Pollinations fallback with retry
 * → post-process to the exact contract the game expects. Terminal failure of any
 * required slot rejects; every caller handles it (ScreenZero downgrades to static
 * theme art, App surfaces it in the regen overlay) — no global error event here.
 */
import { SLOT_SPECS, BASELINE_SLOTS, GENERATED_SLOTS } from './slotSpecs';
import { postProcessAsset, mirrorImage, drawToCanvas, alphaFraction, borderResidueFraction, topBandOpaqueFraction, contentBoundsOf, processSheet, finalizeSheetFrames } from './postprocess';
import { reviewSprite } from './qa';
import * as gemini from './providers/geminiImage';
import * as pollinations from './providers/pollinations';
import { designAssetPrompts, localDesign, buildFinalPrompt } from './promptDesigner';
import { parsePromptKeywords } from '../promptUtils';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate one slot's raw image, walking the provider ladder.
 * `runState.skipGemini` is shared across a run: once one slot hits a hard Gemini
 * failure (dead quota, bad key), the remaining slots skip straight to the fallback
 * instead of each burning retries and long quota waits.
 * Returns { dataUrl, provider, attempts }.
 */
async function generateSlotImage(slot, prompt, seed, onProgress, maxAttemptsPerProvider, runState, onAttempt = () => {}, referenceImageDataUrl = null) {
  const spec = SLOT_SPECS[slot];
  let attempts = 0;
  let lastError = null;

  if (gemini.isGeminiConfigured() && !runState.skipGemini) {
    for (let attempt = 1; attempt <= maxAttemptsPerProvider; attempt++) {
      attempts++;
      onAttempt({ provider: 'gemini', attempt, total: maxAttemptsPerProvider });
      try {
        // referenceImageDataUrl is Gemini-only (image editing); Pollinations has no
        // image-conditioning API, so the fallback below runs from the prompt alone.
        const result = await gemini.generateImage({ prompt, aspectRatio: spec.gen.aspectRatio, referenceImageDataUrl });
        return { ...result, attempts };
      } catch (err) {
        lastError = err;
        console.warn(`[AssetPipeline] Gemini failed for "${slot}" (attempt ${attempt}): ${err.message}`);
        // Bad key or safety block won't improve on retry — go straight to fallback
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
    onProgress(`[ASSETS] Gemini unavailable for ${slot}, switching to free fallback...`, null);
  }

  // Retries re-enter the serialized Pollinations queue, which already spaces and
  // penalty-delays requests — no extra backoff sleep needed for 429s here.
  // When Gemini can't rescue this run (keyless, or quota/key already dead), every
  // retry costs a serialized free-path slot (~15s gap each) — keep the ladder short
  // so a full game stays minutes, not tens of minutes.
  const fallbackAttempts = (gemini.isGeminiConfigured() && !runState.skipGemini)
    ? maxAttemptsPerProvider + 2
    : 2;
  for (let attempt = 1; attempt <= fallbackAttempts; attempt++) {
    attempts++;
    onAttempt({ provider: 'pollinations', attempt, total: fallbackAttempts });
    try {
      const result = await pollinations.generateImage({ prompt, ...spec.gen.pollinations, seed });
      return { ...result, attempts };
    } catch (err) {
      lastError = err;
      console.warn(`[AssetPipeline] Pollinations failed for "${slot}" (attempt ${attempt}): ${err.message}`);
      if (attempt < fallbackAttempts && err.status !== 429) await sleep(2000);
    }
  }

  throw new Error(`All providers failed for asset "${slot}". Last error: ${lastError?.message || 'unknown'}`);
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
  maxAttemptsPerProvider = 2
}) {
  const preloadedImages = {};
  const meta = {};
  const runState = { skipGemini: false };
  let doneCount = 0;
  // A required slot that dies rejects the whole run — stop idle workers from
  // feeding the serial Pollinations queue for minutes after the UI has moved on.
  let fatal = false;

  // Partial credit for in-flight slots so the bar moves between completions. On the
  // serialized free path the FIRST completed slot can take minutes, and a bar frozen
  // at exactly 75 reads as a hang. Fractions are capped per slot, and the total is
  // clamped to 94 — 95 is reserved for the caller's pipeline-complete report.
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
  const enforceKeyQuality = async (slot, spec, raw, img) => {
    if (!spec.post.keying) return img;
    const measure = (image) => {
      const canvas = drawToCanvas(image, { width: image.naturalWidth, height: image.naturalHeight, fit: 'stretch' });
      return {
        transparent: alphaFraction(canvas),
        residue: spec.post.crop ? borderResidueFraction(canvas) : 0,
        topBand: spec.post.crop ? 0 : topBandOpaqueFraction(canvas)
      };
    };
    const before = measure(img);

    // Non-cropped keyed slots are the parallax layers: their contract is "everything
    // above the shapes is empty", so surviving backdrop shows as an opaque top band.
    if (!spec.post.crop) {
      if (before.topBand <= 0.10) return img;
      report(`[ASSETS] Re-keying ${slot} (backdrop left in the top band)...`);
      const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 70, stepTol: 24 } });
      const after = measure(retried);
      return after.transparent < 0.97 && after.topBand < before.topBand ? retried : img;
    }

    // A cropped sprite that is >92% transparent inside its own bounding box got
    // shredded by the flood (it rode a gradient into the interior) — one TIGHTER
    // re-key, kept only when it restores real coverage without leaving residue.
    if (before.transparent > 0.92) {
      report(`[ASSETS] Re-keying ${slot} (keying removed too much)...`);
      const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 26, stepTol: 10 } });
      const after = measure(retried);
      const restored = after.transparent <= before.transparent - 0.1;
      return restored && after.residue <= 0.06 ? retried : img;
    }

    if (before.transparent >= 0.05 && before.residue <= 0.06) return img;
    report(`[ASSETS] Re-keying ${slot} (background leftovers detected)...`);
    const retried = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 70, stepTol: 24 } });
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

    // Layers get their own review kind: their failure mode is rectangular vignette
    // "props" (mini paintings) rather than a wrong facing.
    const kind = spec.qa.clean ? 'layer' : 'sprite';
    const failed = (r) => r && (!r.backgroundClean || r.cutoutShapes === false);
    let review = await reviewSprite(img.src, { kind });
    if (failed(review)) {
      report(`[ASSETS] QA: re-keying ${slot} background...`);
      img = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 60, stepTol: 20 } });
      review = (await reviewSprite(img.src, { kind })) || review;
      if (failed(review)) {
        report(`[ASSETS] QA: regenerating ${slot}...`);
        try {
          const retryRaw = await generateSlotImage(slot, prompt, seed + 1, report, maxAttemptsPerProvider, runState);
          const retryImg = await postProcessAsset(retryRaw.dataUrl, spec);
          img = retryImg;
          review = (await reviewSprite(img.src, { kind })) || review;
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

  // Sprite-sheet slots walk the normal provider ladder (Gemini → Pollinations) and
  // fall back to their static slot on ANY quality failure. The free provider gets a
  // single attempt with no regeneration — its sheets pass the gates often enough to
  // be worth one serial-queue slot, but not two.
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

    report(`[ASSETS] Generating animated ${spec.outputKey || slot}...`);
    const onAttempt = attemptTicker(slot);
    try {
      // A sheet whose cells kept a painted scene can't be keyed (non-uniform backdrop)
      // and would render the player as an opaque card — gate on transparency
      // deterministically, allow one regeneration, else fall back to static.
      const sheetTransparency = (img) => {
        const canvas = drawToCanvas(img, { width: img.naturalWidth, height: img.naturalHeight, fit: 'stretch' });
        return alphaFraction(canvas);
      };
      // Local geometry gate — no vision model required (the free path has none).
      // Misaligned grids (characters straddling cell borders, wildly varying sizes)
      // slice into frames that pulse or show half-characters; per-cell content
      // bounds catch that deterministically.
      const gridGeometryIssue = (cells) => {
        const heights = [];
        for (const cell of cells) {
          const bounds = contentBoundsOf(cell);
          if (!bounds) return 'has empty cells';
          const height = bounds.maxY - bounds.minY + 1;
          if (height < cell.height * 0.3) return 'has undersized frames';
          heights.push(height);
        }
        if (Math.max(...heights) / Math.min(...heights) > 1.35) return 'has inconsistent frame sizes';
        return null;
      };
      // A sheet of near-identical poses animates as a nervous shiver, not a run.
      // Compare consecutive run frames on a coarse 12×12 alpha grid; if most pairs
      // are effectively the same image, the model ignored the cycle choreography.
      const framesLookStatic = (cells) => {
        const runCount = Math.min(spec.frames.runFrameCount || cells.length, cells.length);
        const signature = (cell) => {
          const small = document.createElement('canvas');
          small.width = 12; small.height = 12;
          const ctx = small.getContext('2d');
          ctx.drawImage(cell, 0, 0, 12, 12);
          return ctx.getImageData(0, 0, 12, 12).data;
        };
        const sigs = cells.slice(0, runCount).map(signature);
        let staticPairs = 0;
        for (let i = 1; i < sigs.length; i++) {
          let diff = 0;
          for (let p = 3; p < sigs[i].length; p += 4) diff += Math.abs(sigs[i][p] - sigs[i - 1][p]);
          if (diff / (144 * 255) < 0.015) staticPairs++;
        }
        return staticPairs >= Math.floor((runCount - 1) / 2);
      };
      // A sheet can pass every size gate while drawing a DIFFERENT character in
      // each cell — the local gates check geometry, and the vision check that
      // catches identity drift (gridConsistent) is Gemini-only, so on the free
      // path incoherent sheets used to ship. Same character in a new pose keeps
      // its palette; a redesigned character shifts it — compare per-cell coarse
      // color histograms (4×4×4 RGB buckets over opaque pixels) against the
      // element-wise median. L1 distance ranges 0..2; >0.9 = mostly different
      // palette. Two or more outlier cells = not one character.
      const cellsLookUnrelated = (cells) => {
        const runCount = Math.min(spec.frames.runFrameCount || cells.length, cells.length);
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
        const hists = cells.slice(0, runCount).map(histogram);
        if (hists.some(h => !h)) return false; // empty cells are the geometry gate's job
        const median = hists[0].map((_, i) => {
          const col = hists.map(h => h[i]).sort((a, b) => a - b);
          return col[Math.floor(col.length / 2)];
        });
        let outliers = 0;
        for (const h of hists) {
          let dist = 0;
          for (let i = 0; i < 64; i++) dist += Math.abs(h[i] - median[i]);
          if (dist > 0.9) outliers++;
        }
        return outliers >= 2;
      };

      let sheet = null;
      let review = null;
      let mirrored = false;
      let provider = null;
      let attempts = 0;
      let lastIssue = 'unknown';
      for (let attempt = 1; attempt <= 2 && !sheet; attempt++) {
        if (attempt > 1) report(`[ASSETS] Sheet ${lastIssue}, regenerating...`);
        // On the Gemini rung the sheet is an image-editing call anchored to the
        // static base; the prompt preamble tells the model the attachment IS the
        // character. Pollinations ignores the reference (prompt-only model).
        const useReference = baseSrc && gemini.isGeminiConfigured() && !runState.skipGemini;
        const sheetPrompt = useReference
          ? `Use the character in the attached reference image. Redraw THIS EXACT character — identical design, ` +
            `colors, outfit and held items, do not reinvent anything about it — as the following sprite sheet. ${prompt}`
          : prompt;
        const raw = await generateSlotImage(slot, sheetPrompt, seed + attempt * 13, report, maxAttemptsPerProvider, runState, onAttempt, useReference ? baseSrc : null);
        noteSlotProgress(slot, 0.8);
        provider = raw.provider;
        attempts += raw.attempts;
        // Cells are keyed INDIVIDUALLY — whole-sheet flood keying can never reach the
        // backdrop of interior cells (e.g. the center of a 3×3)
        const { previewImg, cells } = await processSheet(raw.dataUrl, spec);
        const localIssue = sheetTransparency(previewImg) < spec.post.minAlphaFraction
          ? 'kept a painted background'
          : (gridGeometryIssue(cells)
            || (framesLookStatic(cells) ? 'has near-identical frames' : null)
            || (cellsLookUnrelated(cells) ? 'draws a different character per frame' : null));
        if (localIssue) {
          lastIssue = localIssue;
          if (provider === 'pollinations') break; // one free-path attempt only
          continue;
        }
        review = await reviewSprite(previewImg.src, { kind: 'sheet', grid: spec.frames });
        if (review && (review.gridConsistent === false || review.legsAlternate === false)) {
          lastIssue = review.gridConsistent === false ? 'grid inconsistent' : 'legs not alternating';
          if (provider === 'pollinations') break;
          continue;
        }
        mirrored = !!(review && !review.facingRight);
        sheet = await finalizeSheetFrames(cells, spec, { mirror: mirrored });
        if (!sheet) {
          lastIssue = 'had no visible content';
          if (provider === 'pollinations') break;
        }
      }
      if (!sheet) throw new Error(`sheet ${lastIssue}`);

      const outKey = spec.outputKey || slot;
      preloadedImages[outKey] = sheet.img;
      meta[outKey] = {
        provider, attempts, promptUsed: prompt,
        qa: review, mirrored, facingVerified: !!review,
        sheet: true, frames: sheet.frames
      };
      delete slotFraction[slot];
      // No doneCount++ here: the static base already counted this slot when it
      // landed; the sheet is an upgrade of the same output key, not a new slot.
      report(`[ASSETS] Upgraded: animated ${outKey} via ${provider}`);
    } catch (err) {
      // The static base is already generated, keyed and registered — keep it.
      console.warn(`[AssetPipeline] Sprite sheet failed (${err.message}) — keeping the static "${spec.fallbackSlot}" sprite.`);
      report(`[ASSETS] Animated player unavailable, keeping static sprite.`);
      delete slotFraction[slot];
    }
  };

  const runSlot = async (slot) => {
    const prompt = finalPrompts[slot];
    if (!prompt) throw new Error(`No prompt provided for asset slot "${slot}".`);
    const spec = SLOT_SPECS[slot];
    if (spec.frames) return runSheetSlot(slot, spec, prompt);
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
        const raw = await generateSlotImage(slot, attemptPrompt, attemptSeed, report, maxAttemptsPerProvider, runState, onAttempt);
        noteSlotProgress(slot, 0.8);
        let img = await postProcessAsset(raw.dataUrl, spec);
        img = await enforceKeyQuality(slot, spec, raw, img);
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
      // The strict-prompt retry is another full ladder walk — cheap on Gemini, but a
      // second serialized slot on the free path. Mirror the sheet's one-free-path-
      // attempt rule: a Pollinations layer that fails the gates is dropped, not redone.
      if (qualityIssue && spec.optional && result.raw.provider !== 'pollinations') {
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
      meta[slot] = { provider: result.raw.provider, attempts: result.raw.attempts, promptUsed: prompt, ...result.outcome };
      delete slotFraction[slot];
      doneCount++;
      report(`[ASSETS] Ready: ${slot} via ${result.raw.provider} (${doneCount}/${slots.length})`);
    } catch (err) {
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

  // Simple promise pool: at most `concurrency` slots in flight (image-model RPM is
  // low on free tier; a full 6-wide burst just converts into 429s)
  const queue = [...slots];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0 && !fatal) {
      await runSlot(queue.shift());
    }
  });
  await Promise.all(workers);

  return { preloadedImages, meta };
}

/**
 * Full generation for a game config: design prompts (LLM or local), then generate
 * all baseline assets. The ONE call every UI path uses.
 */
export async function generateGameAssets({ config, userPrompt = '', onProgress = () => {} }) {
  const design = await designAssetPrompts({
    userPrompt,
    gameType: config.gameType,
    themeKey: config.themeKey,
    assetDesignDirections: config.assetDesignDirections
  });
  onProgress(`[DESIGN] Asset prompts composed via ${design.source === 'gemini' ? 'Gemini art director' : 'local templates'}...`, 73);

  const finalPrompts = {};
  for (const slot of [...GENERATED_SLOTS, 'player_sheet', 'projectile']) {
    finalPrompts[slot] = buildFinalPrompt(slot, design.subjects, design.styleGuide);
  }

  // The player is always attempted as an animated sprite sheet (stored under the
  // 'player' key). Gemini produces reliable sheets; the free path gets one gated
  // attempt and falls back to a static player sprite when the gates reject it.
  // GENERATED_SLOTS order matters: required gameplay slots precede the optional
  // parallax layers, so the FIFO worker pool finishes the playable core first
  // (crucial on the serialized free path) — keep it that way.
  const slots = GENERATED_SLOTS.map(s => (s === 'player' ? 'player_sheet' : s));
  // Platformer games shoot — generate their projectile too (optional slot: on failure
  // the game keeps its static SVG bolt). Runners never fire, skip the cost.
  if (config.gameType === 'platformer') slots.push('projectile');

  const { preloadedImages, meta } = await generateAssets({ finalPrompts, slots, onProgress });

  const providers = Object.values(meta).filter(m => !m.dropped).map(m => m.provider);
  const geminiCount = providers.filter(p => p === 'gemini').length;
  onProgress(
    `[ASSETS] Complete — ${geminiCount}/${providers.length} images via Gemini, ` +
    `${providers.length - geminiCount} via free engine. Prompt design: ${design.source}.`,
    95
  );

  // assetMeta rides on the game config so provider usage stays inspectable after
  // generation (DevTools: window.__GAME_LIVE_CONFIG.assetMeta)
  const assetMeta = { designSource: design.source, slots: meta };
  return { preloadedImages, meta, promptSet: finalPrompts, design, assetMeta };
}

/**
 * Cherry-pick regeneration: redo ONLY the requested slots for an already-running
 * game (Creator Panel "restyle" intent). The edit instruction steers the prompt
 * designer so the new art follows the request; the caller merges the returned
 * images/meta over the retained ones and remounts the game.
 */
export async function regenerateAssetSlots({ config, instruction = '', slots, onProgress = () => {} }) {
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
  onProgress(`[DESIGN] Asset prompts composed via ${design.source === 'gemini' ? 'Gemini art director' : 'local templates'}...`, 73);

  const finalPrompts = {};
  for (const slot of slots) {
    finalPrompts[slot] = buildFinalPrompt(slot, design.subjects, design.styleGuide);
    // Sheet slots fall back to their static slot on gate failure — that fallback
    // run needs its own prompt present.
    const fallbackSlot = SLOT_SPECS[slot].fallbackSlot;
    if (fallbackSlot && !finalPrompts[fallbackSlot]) {
      finalPrompts[fallbackSlot] = buildFinalPrompt(fallbackSlot, design.subjects, design.styleGuide);
    }
  }

  const { preloadedImages, meta } = await generateAssets({ finalPrompts, slots, onProgress });

  const providers = Object.values(meta).filter(m => !m.dropped).map(m => m.provider);
  const geminiCount = providers.filter(p => p === 'gemini').length;
  onProgress(
    `[ASSETS] Updated ${providers.length}/${slots.length} slot(s) — ` +
    `${geminiCount} via Gemini, ${providers.length - geminiCount} via free engine.`,
    95
  );
  return { preloadedImages, meta, design };
}

/**
 * Raw Pollinations URL map for paths that skip preloading entirely (share-link
 * imports, initial presets). Phaser's loader fetches these directly.
 */
export function compileFallbackUrls(config) {
  const design = localDesign({
    gameType: config.gameType,
    themeKey: config.themeKey,
    assetDesignDirections: config.assetDesignDirections
  });
  const seed = Math.floor(Math.random() * 1000000);
  const urls = {};
  for (const slot of BASELINE_SLOTS) {
    urls[slot] = pollinations.buildPollinationsUrl({
      prompt: buildFinalPrompt(slot, design.subjects, design.styleGuide),
      ...SLOT_SPECS[slot].gen.pollinations,
      seed
    });
  }
  return urls;
}
