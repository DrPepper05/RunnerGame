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

import { generateGameAssets } from '../assetPipeline';
import { loadImage } from '../assetPipeline/postprocess.js';
import * as backend from './idbBackend.js';
import * as server from './serverBackend.js';

const SCHEMA_VERSION = 1;

const readQualityMode = () => {
  try {
    return localStorage.getItem('PM_QUALITY_MODE') === '1';
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

// Fire-and-forget entry write. preloadedImages (HTMLImageElements) and assetMeta
// are stripped from the persisted config — they are not structured-clonable.
const persistRun = async ({ id, promptKey, sourcePrompt, createdAt, config, preloadedImages, assetMeta }) => {
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
    // cross-device. Fire-and-forget; disabled/failed server = local-only, silently.
    server.putGame(entry);
  } catch (err) {
    console.warn('[AssetCache] persist skipped:', err?.message || err);
  }
};

const restoredMeta = (entry) => ({ ...(entry.assetMeta || {}), restoredFromCache: true });

/**
 * The single wrapper every generation call site uses.
 * Returns { config, preloadedImages, assetMeta, fromCache } — call sites must
 * spread the RETURNED config (it carries gameId/sourcePrompt, and on cache hits
 * dynamicAssetUrls is forced true so keyless restores route to dyn_* textures).
 */
export async function generateOrRestoreAssets({ config, userPrompt = '', promptKey = null, onProgress, cancelToken, forceFresh = false }) {
  if (!forceFresh && promptKey) {
    const entry = await backend.findByPromptKey(promptKey);
    if (entry && entry.schemaVersion === SCHEMA_VERSION) {
      try {
        const preloadedImages = await rehydrateEntry(entry, cancelToken);
        backend.touch(entry.id);
        onProgress?.('[CACHE] Exact match found — restored artwork from local cache ($0 this run)', 90);
        onProgress?.('[CACHE] Want a fresh look? Enable "Force new AI art" and generate again.', null);
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

  const { preloadedImages, assetMeta } = await generateGameAssets({ config, userPrompt, onProgress, cancelToken });
  const gameId = newGameId();
  const stampedConfig = { ...config, gameId, sourcePrompt: config?.sourcePrompt ?? userPrompt ?? '' };
  persistRun({ id: gameId, promptKey, sourcePrompt: stampedConfig.sourcePrompt, config: stampedConfig, preloadedImages, assetMeta });
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
