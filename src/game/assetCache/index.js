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
    const entry = {
      id,
      schemaVersion: SCHEMA_VERSION,
      promptKey: promptKey || null,
      sourcePrompt: sourcePrompt || '',
      createdAt: createdAt || Date.now(),
      lastAccess: Date.now(),
      config: cleanConfig,
      assetMeta: assetMeta || null,
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

const restoredMeta = (entry) => ({ ...(entry.assetMeta || {}), restoredFromCache: true });

// Tier 2 of the ladder: no exact hit — ask the matcher whether any cached set
// fits the new prompt (LLM with a key, deterministic theme match without), then
// reuse it whole or redraw only the clashing slots. Returns a full result object
// or null (fall through the ladder). Never generates a full set.
async function tryMatchedReuse({ config, userPrompt, promptKey, onProgress, cancelToken, cacheOnly }) {
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
  if (isGeminiConfigured()) {
    try {
      verdict = await matchCachedGame({ userPrompt, candidates });
    } catch {
      verdict = null; // matcher failure → deterministic fallback below
    }
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
  // the missing player on first real keyed use — one static-player image ≈ $0.03.
  // Cache-only/keyless skip this; the scene's theme-player fallback covers them.
  // (Deliberately AFTER the ≤3 threshold — completing a player never disqualifies
  // an otherwise-good match.)
  if (!cacheOnly && !baseImages.player && !slots.includes('player') && isGeminiConfigured()) {
    slots = [...slots, 'player'];
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
    return {
      config: { ...config, gameId: entry.id, sourcePrompt: userPrompt, dynamicAssetUrls: true },
      preloadedImages: baseImages,
      assetMeta: restoredMeta(entry),
      fromCache: true
    };
  }

  // Partial reuse: redraw only the clashing slots (~$0.04/slot vs ~$0.40/game).
  // 'player' stays the STATIC slot (not player_sheet) for now — the "players
  // later" direction: animation sheets get their own round; the static sprite +
  // procedural run-bob covers gameplay.
  onProgress?.(`[CACHE] Matched cached game "${label}"${reason} — reusing base art, redrawing: ${slots.join(', ')}`, 78);
  const regenSlots = [...new Set(slots)];
  let regen = null;
  try {
    regen = await regenerateAssetSlots({ config, instruction: userPrompt, slots: regenSlots, onProgress, cancelToken });
  } catch (err) {
    if (err?.cancelled) throw err;
    onProgress?.('[CACHE] Redraw failed — reusing the cached art as-is.', null);
  }
  const mergedImages = { ...baseImages };
  const mergedSlots = { ...(entry.assetMeta?.slots || {}) };
  for (const [slot, m] of Object.entries(regen?.meta || {})) {
    if (m.dropped) {
      if (mergedImages[slot]) continue; // failed redraw — keep the base art
      mergedSlots[slot] = m;
      continue;
    }
    mergedImages[slot] = regen.preloadedImages[slot];
    mergedSlots[slot] = m;
  }
  if (cancelToken?.cancelled) throw cancelledError();
  // New pixels exist → persist a NEW entry under this prompt's key so the next
  // identical prompt exact-hits. Base cost tally is stale for the merged set —
  // strip it (the partial run's [COST] line already reported the real spend).
  const { cost: _cost, ...metaBase } = entry.assetMeta || {};
  const assetMeta = { ...metaBase, slots: mergedSlots, restoredFromCache: true };
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
  const cacheOnly = readCacheOnly();

  // Tier 1 — exact prompt match: instant whole-set restore.
  if (promptKey) {
    const entry = await backend.findByPromptKey(promptKey);
    if (entry && entry.schemaVersion === SCHEMA_VERSION) {
      try {
        const preloadedImages = await rehydrateEntry(entry, cancelToken);
        backend.touch(entry.id);
        onProgress?.('[CACHE] Exact match found — restored artwork from local cache ($0 this run)', 90);
        onProgress?.('[CACHE] Want a fresh look? Open the Creator Panel in-game and ask it to redraw everything.', null);
        return {
          config: { ...entry.config, gameId: entry.id, sourcePrompt: entry.sourcePrompt || '', dynamicAssetUrls: true },
          preloadedImages,
          assetMeta: restoredMeta(entry),
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
  if (String(userPrompt || '').trim()) {
    const reused = await tryMatchedReuse({ config, userPrompt, promptKey, onProgress, cancelToken, cacheOnly });
    if (reused) return reused;
  }

  // Tier 3 — cache-only miss: explain and hand the caller its static fallback.
  if (cacheOnly) {
    onProgress?.('[CACHE] Cache only is ON — no cached game matches this prompt. Launching built-in theme art (no image spend). Turn the toggle off (top right) to generate fresh AI art.', null);
    throw Object.assign(new Error('cache-only: no cached match'), { cacheOnlyMiss: true });
  }

  return generateAndCache({ config, userPrompt, promptKey, onProgress, cancelToken });
}

/**
 * Fresh generation + cache persist (the ladder's tier 3, also the bulk runner's
 * engine). skipSlots skips whole slots ('player' = playerless population sets);
 * awaitPersist makes the local put AND Blob upload complete before returning.
 */
export async function generateAndCache({ config, userPrompt = '', promptKey = null, onProgress, cancelToken, skipSlots = [], awaitPersist = false }) {
  const { preloadedImages, assetMeta } = await generateGameAssets({ config, userPrompt, onProgress, cancelToken, skipSlots });
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
      assetMeta: restoredMeta(entry)
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
