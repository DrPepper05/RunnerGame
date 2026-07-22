/**
 * Asset generation pipeline — the single entry point for every generation path
 * (ScreenZero prompt flow, App.jsx prompt flow, CreatorPanel regeneration).
 *
 * Per slot: Gemini (when configured) with retry → Pollinations fallback with retry
 * → post-process to the exact contract the game expects. Terminal failure of any
 * slot dispatches the existing 'playmint-error' window event and rejects.
 */
import { SLOT_SPECS, BASELINE_SLOTS, GENERATED_SLOTS } from './slotSpecs';
import { postProcessAsset, mirrorImage, drawToCanvas, alphaFraction, borderResidueFraction, contentBoundsOf, processSheet, finalizeSheetFrames } from './postprocess';
import { reviewSprite } from './qa';
import * as gemini from './providers/geminiImage';
import * as pollinations from './providers/pollinations';
import { designAssetPrompts, localDesign, buildFinalPrompt } from './promptDesigner';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function dispatchPipelineError(message) {
  window.dispatchEvent(new CustomEvent('playmint-error', { detail: { message } }));
}

/**
 * Generate one slot's raw image, walking the provider ladder.
 * `runState.skipGemini` is shared across a run: once one slot hits a hard Gemini
 * failure (dead quota, bad key), the remaining slots skip straight to the fallback
 * instead of each burning retries and long quota waits.
 * Returns { dataUrl, provider, attempts }.
 */
async function generateSlotImage(slot, prompt, seed, onProgress, maxAttemptsPerProvider, runState) {
  const spec = SLOT_SPECS[slot];
  let attempts = 0;
  let lastError = null;

  if (gemini.isGeminiConfigured() && !runState.skipGemini) {
    for (let attempt = 1; attempt <= maxAttemptsPerProvider; attempt++) {
      attempts++;
      try {
        const result = await gemini.generateImage({ prompt, aspectRatio: spec.gen.aspectRatio });
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
  const fallbackAttempts = maxAttemptsPerProvider + 2;
  for (let attempt = 1; attempt <= fallbackAttempts; attempt++) {
    attempts++;
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

  const progressFor = () => 75 + Math.round((doneCount / slots.length) * 20);
  const report = (text, pct) => onProgress(text, pct ?? progressFor());

  // Deterministic keying self-check — no vision model, works on the keyless free
  // path. Two failure smells after keying+cropping: almost nothing was removed
  // (gradient/vignette backdrop the flood couldn't latch onto), or the outer band of
  // the cropped sprite is full of opaque near-white pixels (leftover backdrop). Both
  // trigger one re-key with looser tolerances; the looser result is kept only when
  // it measurably improves without dissolving the sprite.
  const enforceKeyQuality = async (slot, spec, raw, img) => {
    if (!spec.post.keying || !spec.post.crop) return img;
    const measure = (image) => {
      const canvas = drawToCanvas(image, { width: image.naturalWidth, height: image.naturalHeight, fit: 'stretch' });
      return { transparent: alphaFraction(canvas), residue: borderResidueFraction(canvas) };
    };
    const before = measure(img);
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

    let review = await reviewSprite(img.src);
    if (review && !review.backgroundClean) {
      report(`[ASSETS] QA: re-keying ${slot} background...`);
      img = await postProcessAsset(raw.dataUrl, spec, { keyOverrides: { seedTol: 60, stepTol: 20 } });
      review = (await reviewSprite(img.src)) || review;
      if (!review.backgroundClean) {
        report(`[ASSETS] QA: regenerating ${slot}...`);
        try {
          const retryRaw = await generateSlotImage(slot, prompt, seed + 1, report, maxAttemptsPerProvider, runState);
          const retryImg = await postProcessAsset(retryRaw.dataUrl, spec);
          img = retryImg;
          review = (await reviewSprite(img.src)) || review;
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
    outcome.facingVerified = !!review;
    return { img, outcome };
  };

  // Sprite-sheet slots walk the normal provider ladder (Gemini → Pollinations) and
  // fall back to their static slot on ANY quality failure. The free provider gets a
  // single attempt with no regeneration — its sheets pass the gates often enough to
  // be worth one serial-queue slot, but not two.
  const runSheetSlot = async (slot, spec, prompt) => {
    report(`[ASSETS] Generating animated ${spec.outputKey || slot}...`);
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

      let sheet = null;
      let review = null;
      let mirrored = false;
      let provider = null;
      let attempts = 0;
      let lastIssue = 'unknown';
      for (let attempt = 1; attempt <= 2 && !sheet; attempt++) {
        if (attempt > 1) report(`[ASSETS] Sheet ${lastIssue}, regenerating...`);
        const raw = await generateSlotImage(slot, prompt, seed + attempt * 13, report, maxAttemptsPerProvider, runState);
        provider = raw.provider;
        attempts += raw.attempts;
        // Cells are keyed INDIVIDUALLY — whole-sheet flood keying can never reach the
        // backdrop of interior cells (e.g. the center of a 3×3)
        const { previewImg, cells } = await processSheet(raw.dataUrl, spec);
        const localIssue = sheetTransparency(previewImg) < spec.post.minAlphaFraction
          ? 'kept a painted background'
          : (gridGeometryIssue(cells) || (framesLookStatic(cells) ? 'has near-identical frames' : null));
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
      doneCount++;
      report(`[ASSETS] Ready: animated ${outKey} via ${provider} (${doneCount}/${slots.length})`);
    } catch (err) {
      console.warn(`[AssetPipeline] Sprite sheet failed (${err.message}) — falling back to static "${spec.fallbackSlot}".`);
      report(`[ASSETS] Animated player unavailable, generating static sprite...`);
      await runSlot(spec.fallbackSlot);
    }
  };

  const runSlot = async (slot) => {
    const prompt = finalPrompts[slot];
    if (!prompt) throw new Error(`No prompt provided for asset slot "${slot}".`);
    const spec = SLOT_SPECS[slot];
    if (spec.frames) return runSheetSlot(slot, spec, prompt);
    report(`[ASSETS] Generating ${slot}...`);
    try {
      // Overlay layers that failed to key out (still mostly opaque) would cover the
      // layers behind them — reject so the optional-slot path drops them. The model
      // sometimes ignores the white-region instruction, so allow one fresh attempt.
      const checkTransparency = (img) => {
        if (!spec.post.minAlphaFraction) return null;
        const canvas = drawToCanvas(img, { width: img.naturalWidth, height: img.naturalHeight, fit: 'stretch' });
        const fraction = alphaFraction(canvas);
        return fraction < spec.post.minAlphaFraction
          ? `layer kept too little transparency (${Math.round(fraction * 100)}% transparent)`
          : null;
      };
      const attemptOnce = async (attemptSeed, attemptPrompt) => {
        const raw = await generateSlotImage(slot, attemptPrompt, attemptSeed, report, maxAttemptsPerProvider, runState);
        let img = await postProcessAsset(raw.dataUrl, spec);
        img = await enforceKeyQuality(slot, spec, raw, img);
        const { img: finalImg, outcome } = await applyQualityAssurance(slot, spec, raw, img, attemptPrompt);
        return { raw, finalImg, outcome };
      };

      let result = await attemptOnce(seed, prompt);
      let transparencyIssue = checkTransparency(result.finalImg);
      if (transparencyIssue && spec.optional) {
        report(`[ASSETS] Retrying ${slot} (${transparencyIssue})...`);
        // Harsher variant: the model painted a full scene — demand cutouts explicitly
        const strictPrompt = prompt +
          ', IMPORTANT: only flat solid silhouette cutout shapes on an empty pure white background, ' +
          'like paper cutouts, at least the upper half of the image must be completely blank white';
        result = await attemptOnce(seed + 7, strictPrompt);
        transparencyIssue = checkTransparency(result.finalImg);
      }
      if (transparencyIssue) throw new Error(transparencyIssue);

      preloadedImages[slot] = result.finalImg;
      meta[slot] = { provider: result.raw.provider, attempts: result.raw.attempts, promptUsed: prompt, ...result.outcome };
      doneCount++;
      report(`[ASSETS] Ready: ${slot} via ${result.raw.provider} (${doneCount}/${slots.length})`);
    } catch (err) {
      if (spec.optional) {
        // Optional layers degrade gracefully — the game filters missing textures
        console.warn(`[AssetPipeline] Dropping optional slot "${slot}": ${err.message}`);
        meta[slot] = { dropped: true, reason: err.message };
        doneCount++;
        report(`[ASSETS] Skipped optional layer ${slot} (${doneCount}/${slots.length})`);
        return;
      }
      const message = `[Asset Pipeline Error] Failed to generate "${slot}".\n• Prompt: "${prompt}"\n• Reason: ${err.message}`;
      console.error(message);
      dispatchPipelineError(message);
      throw new Error(message);
    }
  };

  // Simple promise pool: at most `concurrency` slots in flight (image-model RPM is
  // low on free tier; a full 6-wide burst just converts into 429s)
  const queue = [...slots];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
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
  for (const slot of [...GENERATED_SLOTS, 'player_sheet']) {
    finalPrompts[slot] = buildFinalPrompt(slot, design.subjects, design.styleGuide);
  }

  // The player is always attempted as an animated sprite sheet (stored under the
  // 'player' key). Gemini produces reliable sheets; the free path gets one gated
  // attempt and falls back to a static player sprite when the gates reject it.
  const slots = GENERATED_SLOTS.map(s => (s === 'player' ? 'player_sheet' : s));

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
