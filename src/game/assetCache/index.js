// Asset cache orchestration (added 2026-08-11, the "cached assets" client direction).
//
// Local-first: entries live in IndexedDB (idbBackend.js) keyed by a game id
// (crypto.randomUUID) with a secondary promptKey index for exact-match reuse.
// A later server backend (Vercel Blob/KV) implements the same backend interface
// and composes here — call sites never change.
//
// The one entry point generation call sites use is generateOrRestoreAssets():
// cache lookup happens BEFORE the only paid step (generateGameAssets), so an
// exact prompt/preset match boots with $0 Gemini spend — and works keyless,
// because the pipeline (which throws without a key) is never reached on a hit.
// Every cache failure degrades to a miss; nothing here may break generation.

import { generateGameAssets, regenerateAssetSlots, isGeminiConfigured } from '../assetPipeline';
import { resetUsageTally, getUsageTally } from '../assetPipeline/providers/geminiImage.js';
import { loadImage } from '../assetPipeline/postprocess.js';
import * as backend from './idbBackend.js';
import * as server from './serverBackend.js';
import { matchCachedGame, localMatch } from './matcher.js';

const SCHEMA_VERSION = 1;

const readQualityMode = () => {
  try {
    return localStorage.getItem('PM_QUALITY_MODE') === '1';
  } catch {
    return false;
  }
};

// "Cache only" toggle (ScreenZero top-right, persisted): hard no-image-spend
// mode — matched cache art or built-in theme art, never a fresh image run.
const readCacheOnly = () => {
  try {
    return localStorage.getItem('PM_FORCE_CACHE') === '1';
  } catch {
    return false;
  }
};

// Exact-match identity of a generatable game. Quality mode is part of the key
// on purpose: a quality-mode run must never silently reuse cheap-mode art.
export const makePromptKey = (prompt, gameType) =>
  `v1|${gameType || 'standard'}|${readQualityMode() ? 'q1' : 'q0'}|` +
  String(prompt || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Presets key on the mode only — difficulty is re-randomized on every hit
// (only the art is reused), so it must not fragment the key.
export const makePresetKey = (mode) =>
  `v1|preset:${mode}|${readQualityMode() ? 'q1' : 'q0'}|`;

const cancelledError = () =>
  Object.assign(new Error('generation cancelled'), { cancelled: true });

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('blob read failed'));
  reader.readAsDataURL(blob);
});

// Blob → data URL → decoded HTMLImageElement, per slot. Data URLs (not object
// URLs) on purpose: restored images are then behaviorally identical to fresh
// pipeline output (img.src is a data URL), so restyle/reboot paths need no
// special-casing. Throws on any failure — the caller deletes the entry.
const rehydrateEntry = async (entry, cancelToken) => {
  const slots = Object.entries(entry.images || {});
  if (slots.length === 0) throw new Error('empty cache entry');
  const preloadedImages = {};
  for (const [slot, blob] of slots) {
    if (cancelToken?.cancelled) throw cancelledError();
    preloadedImages[slot] = await loadImage(await blobToDataUrl(blob), { crossOrigin: null });
  }
  return preloadedImages;
};

const newGameId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

// Entry write (fire-and-forget from the normal generation path). preloadedImages
// (HTMLImageElements) and assetMeta are stripped from the persisted config — they
// are not structured-clonable. The bulk runner passes awaitServer so the Blob
// upload completes BEFORE the local LRU (12 entries) can evict the entry.
const persistRun = async ({ id, promptKey, sourcePrompt, createdAt, config, preloadedImages, assetMeta }, { awaitServer = false } = {}) => {
  try {
    const images = {};
    for (const [slot, img] of Object.entries(preloadedImages || {})) {
      if (!img?.src) continue;
      images[slot] = await (await fetch(img.src)).blob();
    }
    const { preloadedImages: _pi, assetMeta: _am, ...cleanConfig } = config || {};
    // `run` is run-scoped truth (tier/timing of ONE boot) — never persisted, or a
    // later restore would replay a stale outcome. `cost` IS persisted: it becomes
    // the entry's originalCost on restores.
    const { run: _runScoped, ...persistedMeta } = assetMeta || {};
    const entry = {
      id,
      schemaVersion: SCHEMA_VERSION,
      promptKey: promptKey || null,
      sourcePrompt: sourcePrompt || '',
      createdAt: createdAt || Date.now(),
      lastAccess: Date.now(),
      config: cleanConfig,
      assetMeta: assetMeta ? persistedMeta : null,
      images
    };
    await backend.putGame(entry);
    // Write-through to the server cache (Vercel Blob) so the game's URL works
    // cross-device. Fire-and-forget normally; awaited for bulk population.
    const upload = server.putGame(entry);
    if (awaitServer) await upload;
  } catch (err) {
    console.warn('[AssetCache] persist skipped:', err?.message || err);
  }
};

// ── Run-truth telemetry (2026-08-14, for the client's cost/hit-rate reporting) ──
// assetMeta.cost is ALWAYS the CURRENT run's spend (an exact hit really is $0);
// the persisted generation cost survives as assetMeta.originalCost. Every slot
// carries source: 'cache'|'generated', and assetMeta.run summarizes the outcome
// (tier, matched game, redrawn slots, wall time). `run` is run-scoped and is
// stripped before persisting.

const zeroCost = () => ({
  estUsd: 0, imageCalls: 0, visionCalls: 0, imageFailures: 0, visionFailures: 0,
  promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, calls: []
});

const round4 = (n) => Math.round((n || 0) * 10000) / 10000;

const mergeCosts = (...parts) => {
  const sum = zeroCost();
  for (const c of parts) {
    if (!c) continue;
    sum.estUsd += c.estUsd || 0;
    sum.imageCalls += c.imageCalls || 0;
    sum.visionCalls += c.visionCalls || 0;
    sum.imageFailures += c.imageFailures || 0;
    sum.visionFailures += c.visionFailures || 0;
    sum.promptTokens += c.promptTokens || 0;
    sum.outputTokens += c.outputTokens || 0;
    sum.thoughtsTokens += c.thoughtsTokens || 0;
    sum.calls.push(...(c.calls || []));
  }
  sum.estUsd = round4(sum.estUsd);
  return sum;
};

const runInfo = (tier, t0, extra = {}) => ({
  tier,
  elapsedMs: Math.round(performance.now() - t0),
  ...extra
});

// Per-browser outcome counters (PM_SPEND_TOTAL conventions) — the measured cache
// hit rate + per-tier averages that feed the cost report's pricing projection.
const STATS_KEY = 'PM_CACHE_STATS';
const readStats = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
};
const bumpStats = (field, usd = 0, matcherUsd = 0) => {
  try {
    const s = readStats() || {
      exact: 0, reuse: 0, reusePartial: 0, fresh: 0, staticMiss: 0,
      freshUsd: 0, partialUsd: 0, matcherUsd: 0, since: new Date().toISOString()
    };
    s[field] = (s[field] || 0) + 1;
    if (field === 'fresh') s.freshUsd = round4((s.freshUsd || 0) + usd);
    if (field === 'reusePartial') s.partialUsd = round4((s.partialUsd || 0) + usd);
    s.matcherUsd = round4((s.matcherUsd || 0) + matcherUsd);
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch { /* stats are best-effort */ }
};
export const getCacheStats = () => readStats();
export const resetCacheStats = () => {
  try { localStorage.removeItem(STATS_KEY); } catch { /* ignore */ }
};

const restoredMeta = (entry) => {
  const { cost: originalCost, run: _run, ...rest } = entry.assetMeta || {};
  const slots = {};
  for (const [slot, m] of Object.entries(rest.slots || {})) slots[slot] = { ...m, source: 'cache' };
  for (const slot of Object.keys(entry.images || {})) {
    if (!slots[slot]) slots[slot] = { source: 'cache' };
  }
  return { ...rest, slots, ...(originalCost ? { originalCost } : {}), restoredFromCache: true };
};

// Tier 2 of the ladder: no exact hit — ask the matcher whether any cached set
// fits the new prompt (LLM with a key, deterministic theme match without), then
// reuse it whole or redraw only the clashing slots. Returns a full result object
// or null (fall through the ladder). Never generates a full set.
async function tryMatchedReuse({ config, userPrompt, promptKey, onProgress, cancelToken, cacheOnly, t0, box }) {
  // Candidates = this browser's cache ∪ the shared server population (cards are
  // entry-shaped, so the matcher consumes both interchangeably; local wins dedup).
  let candidates = [];
  try {
    const local = ((await backend.listGames()) || []).filter((e) => e.schemaVersion === SCHEMA_VERSION);
    const localIds = new Set(local.map((e) => e.id));
    const remote = (await server.listGames())
      .filter((c) => c.schemaVersion === SCHEMA_VERSION && !localIds.has(c.id));
    candidates = [...local, ...remote];
  } catch {
    return null;
  }
  if (!candidates.length) return null;

  let verdict = null;
  let matcherCost = null;
  if (isGeminiConfigured()) {
    // Snapshot the matcher call's cost NOW — the pipeline's own resetUsageTally
    // (full gen or partial redraw) would otherwise wipe it from run attribution.
    resetUsageTally();
    try {
      verdict = await matchCachedGame({ userPrompt, candidates });
    } catch {
      verdict = null; // matcher failure → deterministic fallback below
    }
    matcherCost = getUsageTally();
    if (box) box.matcherCost = matcherCost; // no-match → the fresh run still owns this spend
  }
  if (!verdict) verdict = localMatch({ userPrompt, candidates });
  if (cancelToken?.cancelled) throw cancelledError();
  if (!verdict?.matchId) return null;

  // Cache-only never spends: reuse the whole set as-is even when the matcher
  // suggested redraws. >3 clashing slots = mostly a different world — a full
  // fresh generation gives better coherence than stitching.
  let slots = cacheOnly ? [] : (verdict.replaceSlots || []);
  if (slots.length > 3) return null;

  // Load the matched entry: local first, else the server population (write the
  // server copy back locally so the next use of this game is instant).
  let entry = await backend.getGame(verdict.matchId);
  let fromServer = false;
  if (!entry) {
    entry = await server.getGame(verdict.matchId);
    fromServer = !!entry;
  }
  if (!entry || entry.schemaVersion !== SCHEMA_VERSION) return null; // gone since listing
  let baseImages;
  try {
    baseImages = await rehydrateEntry(entry, cancelToken);
  } catch (err) {
    if (err?.cancelled) throw err;
    if (!fromServer) backend.deleteGame(entry.id);
    return null;
  }
  if (fromServer) backend.putGame(entry);
  else backend.touch(entry.id);
  const label = entry.config?.gameName || entry.sourcePrompt || entry.id.slice(0, 8);
  const reason = verdict.reason ? ` (${verdict.reason})` : '';

  // Playerless population sets (bulk generates themes WITHOUT players): complete
  // the missing player on first real keyed use — the ANIMATED sheet path
  // (static base + sheet ≈ $0.09-0.18; the old "players later" static-only
  // top-up shipped every cache-matched game with the tilting bob, the top user
  // complaint 2026-08-16). The completed set persists, so later hits get the
  // animated player at $0.
  // Cache-only/keyless skip this; the scene's theme-player fallback covers them.
  // (Deliberately AFTER the ≤3 threshold — completing a player never disqualifies
  // an otherwise-good match.)
  if (!cacheOnly && !baseImages.player && !slots.includes('player') && !slots.includes('player_sheet') && isGeminiConfigured()) {
    slots = [...slots, 'player_sheet'];
  }

  if (!slots.length) {
    // Whole-set reuse: the NEW prompt's config drives mode/physics; only art +
    // frames/facing meta come from the entry. gameId stays the entry's — the App
    // restore effect spreads the URL's config over cached art, so share/F5 work
    // without persisting a duplicate entry.
    onProgress?.(`[CACHE] Matched cached game "${label}"${reason} — reusing ${Object.keys(baseImages).length} image(s), $0 art spend`, 90);
    if (cacheOnly && verdict.replaceSlots?.length) {
      onProgress?.(`[CACHE] Cache only is ON — reused as-is (skipped redrawing: ${verdict.replaceSlots.join(', ')})`, null);
    }
    const cost = mergeCosts(matcherCost);
    const assetMeta = {
      ...restoredMeta(entry),
      cost,
      run: runInfo('reuse', t0, {
        matchedGameId: entry.id,
        matchedLabel: label,
        reason: verdict.reason || '',
        reusedSlots: Object.keys(baseImages),
        generatedSlots: [],
        estUsd: cost.estUsd
      })
    };
    bumpStats('reuse', 0, matcherCost?.estUsd || 0);
    return {
      config: { ...config, gameId: entry.id, sourcePrompt: userPrompt, dynamicAssetUrls: true },
      preloadedImages: baseImages,
      assetMeta,
      fromCache: true
    };
  }

  // Partial reuse: redraw only the clashing slots (~$0.04/slot vs ~$0.40/game).
  // A player redraw always takes the ANIMATED sheet path (player→player_sheet;
  // the sheet's output lands under the 'player' key with frames meta, so the
  // merge below needs no special-casing).
  onProgress?.(`[CACHE] Matched cached game "${label}"${reason} — reusing base art, redrawing: ${slots.join(', ')}`, 78);
  const regenSlots = [...new Set(slots.map((s) => (s === 'player' ? 'player_sheet' : s)))];
  let regen = null;
  try {
    regen = await regenerateAssetSlots({ config, instruction: userPrompt, slots: regenSlots, onProgress, cancelToken });
  } catch (err) {
    if (err?.cancelled) throw err;
    onProgress?.('[CACHE] Redraw failed — reusing the cached art as-is.', null);
  }
  const mergedImages = { ...baseImages };
  const baseMeta = restoredMeta(entry); // slots marked 'cache', cost → originalCost
  const mergedSlots = { ...baseMeta.slots };
  const generatedSlots = [];
  for (const [slot, m] of Object.entries(regen?.meta || {})) {
    if (m.dropped) {
      if (mergedImages[slot]) continue; // failed redraw — keep the base art
      mergedSlots[slot] = { ...m, source: 'generated' };
      continue;
    }
    mergedImages[slot] = regen.preloadedImages[slot];
    mergedSlots[slot] = { ...m, source: 'generated' };
    generatedSlots.push(slot);
  }
  if (cancelToken?.cancelled) throw cancelledError();
  // This run's true spend = the matcher call + the redraw run.
  const cost = mergeCosts(matcherCost, regen?.cost);
  const assetMeta = {
    ...baseMeta,
    slots: mergedSlots,
    cost,
    run: runInfo('reuse-partial', t0, {
      matchedGameId: entry.id,
      matchedLabel: label,
      reason: verdict.reason || '',
      reusedSlots: Object.keys(mergedImages).filter((s) => !generatedSlots.includes(s)),
      generatedSlots,
      estUsd: cost.estUsd
    })
  };
  bumpStats('reusePartial', cost.estUsd, matcherCost?.estUsd || 0);
  // New pixels exist → persist a NEW entry under this prompt's key so the next
  // identical prompt exact-hits (persistRun strips the run-scoped block).
  const gameId = newGameId();
  const stamped = { ...config, gameId, sourcePrompt: userPrompt, dynamicAssetUrls: true };
  persistRun({ id: gameId, promptKey, sourcePrompt: userPrompt, config: stamped, preloadedImages: mergedImages, assetMeta });
  return { config: stamped, preloadedImages: mergedImages, assetMeta, fromCache: true };
}

/**
 * The single wrapper every generation call site uses.
 * Ladder: exact prompt match → matched reuse (LLM/local, whole or partial) →
 * cache-only static fallback OR full generation.
 * Returns { config, preloadedImages, assetMeta, fromCache } — call sites must
 * spread the RETURNED config (it carries gameId/sourcePrompt, and on cache hits
 * dynamicAssetUrls is forced true so keyless restores route to dyn_* textures).
 */
export async function generateOrRestoreAssets({ config, userPrompt = '', promptKey = null, onProgress, cancelToken }) {
  const t0 = performance.now();
  const cacheOnly = readCacheOnly();

  // Tier 1 — exact prompt match: instant whole-set restore, exactly $0.
  if (promptKey) {
    const entry = await backend.findByPromptKey(promptKey);
    if (entry && entry.schemaVersion === SCHEMA_VERSION) {
      try {
        const preloadedImages = await rehydrateEntry(entry, cancelToken);
        backend.touch(entry.id);
        onProgress?.('[CACHE] Exact match found — restored artwork from local cache ($0 this run)', 90);
        onProgress?.('[CACHE] Want a fresh look? Open the Creator Panel in-game and ask it to redraw everything.', null);
        const assetMeta = {
          ...restoredMeta(entry),
          cost: zeroCost(),
          run: runInfo('exact', t0, {
            matchedGameId: entry.id,
            reusedSlots: Object.keys(preloadedImages),
            generatedSlots: [],
            estUsd: 0
          })
        };
        bumpStats('exact');
        return {
          config: { ...entry.config, gameId: entry.id, sourcePrompt: entry.sourcePrompt || '', dynamicAssetUrls: true },
          preloadedImages,
          assetMeta,
          fromCache: true
        };
      } catch (err) {
        if (err?.cancelled) throw err;
        backend.deleteGame(entry.id); // corrupt entry — regenerate below
      }
    } else if (entry) {
      backend.deleteGame(entry.id); // schema mismatch — drop
    }
  }

  // Tier 2 — matched reuse (prompt runs only; presets keep their exact key).
  // `box` carries the matcher call's cost out of a no-match so the fresh run
  // below still owns that spend in its report.
  const box = {};
  if (String(userPrompt || '').trim()) {
    const reused = await tryMatchedReuse({ config, userPrompt, promptKey, onProgress, cancelToken, cacheOnly, t0, box });
    if (reused) return reused;
  }

  // Tier 3 — cache-only miss: explain and hand the caller its static fallback.
  if (cacheOnly) {
    bumpStats('staticMiss');
    onProgress?.('[CACHE] Cache only is ON — no cached game matches this prompt. Launching built-in theme art (no image spend). Turn the toggle off (top right) to generate fresh AI art.', null);
    throw Object.assign(new Error('cache-only: no cached match'), { cacheOnlyMiss: true });
  }

  return generateAndCache({ config, userPrompt, promptKey, onProgress, cancelToken, t0, extraCost: box.matcherCost });
}

/**
 * Fresh generation + cache persist (the ladder's tier 3, also the bulk runner's
 * engine). skipSlots skips whole slots ('player' = playerless population sets);
 * awaitPersist makes the local put AND Blob upload complete before returning.
 */
export async function generateAndCache({ config, userPrompt = '', promptKey = null, onProgress, cancelToken, skipSlots = [], awaitPersist = false, t0 = null, extraCost = null, trackStats = true }) {
  const started = t0 ?? performance.now();
  const { preloadedImages, assetMeta } = await generateGameAssets({ config, userPrompt, onProgress, cancelToken, skipSlots });
  // Run-truth telemetry: every generated slot is provenance-marked, the run cost
  // includes any pre-generation matcher spend, and the run block records timing.
  for (const m of Object.values(assetMeta.slots || {})) {
    if (m && !m.dropped) m.source = 'generated';
  }
  const cost = mergeCosts(extraCost, assetMeta.cost);
  assetMeta.cost = cost;
  assetMeta.run = runInfo('fresh', started, {
    reusedSlots: [],
    generatedSlots: Object.keys(preloadedImages),
    estUsd: cost.estUsd
  });
  if (trackStats) bumpStats('fresh', cost.estUsd, extraCost?.estUsd || 0);
  const gameId = newGameId();
  const stampedConfig = { ...config, gameId, sourcePrompt: config?.sourcePrompt ?? userPrompt ?? '' };
  const persist = persistRun(
    { id: gameId, promptKey, sourcePrompt: stampedConfig.sourcePrompt, config: stampedConfig, preloadedImages, assetMeta },
    { awaitServer: awaitPersist }
  );
  if (awaitPersist) await persist;
  return { config: stampedConfig, preloadedImages, assetMeta, fromCache: false };
}

// Re-persist a game's art under its existing id (restyle / partial regeneration).
// Fire-and-forget from the caller's perspective; keeps promptKey/createdAt.
export async function updateGameArt(gameId, { config, preloadedImages, assetMeta }) {
  if (!gameId) return;
  try {
    const existing = await backend.getGame(gameId);
    await persistRun({
      id: gameId,
      promptKey: existing?.promptKey || null,
      sourcePrompt: existing?.sourcePrompt ?? config?.sourcePrompt ?? '',
      createdAt: existing?.createdAt,
      config,
      preloadedImages,
      assetMeta
    });
  } catch (err) {
    console.warn('[AssetCache] art update skipped:', err?.message || err);
  }
}

// Share-link / F5 restore path: id → rehydrated game, or null (miss/corrupt).
// Local first; on a local miss the server cache (Vercel Blob) is tried, and a
// server hit is written back into IndexedDB so the next open on this device is
// instant and free.
export async function getGameById(id) {
  const t0 = performance.now();
  let entry = await backend.getGame(id);
  let fromServer = false;
  if (!entry) {
    entry = await server.getGame(id);
    fromServer = !!entry;
  }
  if (!entry || entry.schemaVersion !== SCHEMA_VERSION) return null;
  try {
    const preloadedImages = await rehydrateEntry(entry);
    if (fromServer) backend.putGame(entry);
    else backend.touch(entry.id);
    return {
      config: { ...entry.config, gameId: entry.id, dynamicAssetUrls: true },
      preloadedImages,
      assetMeta: {
        ...restoredMeta(entry),
        cost: zeroCost(),
        run: runInfo('restored', t0, {
          matchedGameId: entry.id,
          reusedSlots: Object.keys(preloadedImages),
          generatedSlots: [],
          estUsd: 0
        })
      }
    };
  } catch {
    if (!fromServer) backend.deleteGame(id); // corrupt LOCAL entry only
    return null;
  }
}

// Share-button backfill: make sure this game's art exists on the server cache —
// covers games generated before the server backend existed and background
// uploads that failed. Cheap when already uploaded (one HEAD request).
export async function ensureUploaded(gameId) {
  if (!gameId) return false;
  try {
    if (!(await server.isAvailable())) return false;
    if (await server.hasGame(gameId)) return true;
    const entry = await backend.getGame(gameId);
    if (!entry) return false;
    return !!(await server.putGame(entry));
  } catch {
    return false;
  }
}
