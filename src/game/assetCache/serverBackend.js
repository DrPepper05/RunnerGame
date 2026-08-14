// Server half of the asset cache: Vercel Blob behind the same backend interface
// as idbBackend.js (added 2026-08-13). Reads are plain fetches against the public
// store (deterministic paths: games/<id>/meta.json + games/<id>/<slot>.png);
// writes go through the /api/games/upload token endpoint via @vercel/blob/client.
//
// Feature-flagged by VITE_BLOB_BASE_URL — unset means every method resolves
// null/false and the app behaves exactly as local-only. Same error posture as the
// local backend: NEVER throw; a server-cache failure must read as a miss.
//
// v1 scope: id-keyed lookups only (share links / F5 across devices).
// findByPromptKey/touch/deleteGame are local-only concerns for now.

import { upload } from '@vercel/blob/client';

const UPLOAD_ENDPOINT = '/api/games/upload';

let warned = false;
const warnOnce = (err) => {
  if (warned) return;
  warned = true;
  console.warn('[AssetCache/server] degraded to local-only:', err?.message || err);
};

// The store's public base URL is self-configuring: the upload endpoint derives
// it from the server-side token (GET), so no client env var is required on the
// deployed site. Memoized per session only — the GET is HTTP-cached (1h) and a
// persistent cache would go stale the moment the store is swapped.
// VITE_BLOB_BASE_URL survives as a local-dev override (plain vite has no /api).
const ENV_BASE = (import.meta.env.VITE_BLOB_BASE_URL || '').replace(/\/+$/, '');
let basePromise = null;
const resolveBase = () => {
  if (ENV_BASE) return Promise.resolve(ENV_BASE);
  if (!basePromise) {
    basePromise = fetch(UPLOAD_ENDPOINT)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.baseUrl || '')
      .catch(() => ''); // no endpoint (plain vite dev) or offline — local-only
  }
  return basePromise;
};

export const isAvailable = async () => !!(await resolveBase());

const metaUrl = (base, id) => `${base}/games/${id}/meta.json`;
const slotUrl = (base, id, slot) => `${base}/games/${id}/${slot}.png`;

// Remote entry → the same shape idbBackend stores, so rehydrateEntry and the
// local write-back consume it unchanged.
export const getGame = async (id) => {
  const base = id ? await resolveBase() : '';
  if (!base) return null;
  try {
    const metaRes = await fetch(metaUrl(base, id), { cache: 'no-cache' });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const slots = Array.isArray(meta.slots) ? meta.slots : [];
    if (!slots.length) return null;
    const images = {};
    await Promise.all(slots.map(async (slot) => {
      const res = await fetch(slotUrl(base, id, slot));
      if (!res.ok) throw new Error(`missing slot ${slot}`);
      images[slot] = await res.blob();
    }));
    return {
      id,
      schemaVersion: meta.schemaVersion,
      promptKey: meta.promptKey || null,
      sourcePrompt: meta.sourcePrompt || '',
      createdAt: meta.createdAt || Date.now(),
      lastAccess: Date.now(),
      config: meta.config || null,
      assetMeta: meta.assetMeta || null,
      images
    };
  } catch (err) {
    warnOnce(err);
    return null;
  }
};

// Cheap existence probe for ensureUploaded (no image downloads).
export const hasGame = async (id) => {
  const base = id ? await resolveBase() : '';
  if (!base) return false;
  try {
    const res = await fetch(metaUrl(base, id), { method: 'HEAD', cache: 'no-cache' });
    return res.ok;
  } catch {
    return false;
  }
};

export const putGame = async (entry) => {
  if (!entry?.id || !entry.config) return null;
  if (!(await resolveBase())) return null; // no store reachable — stay local-only
  try {
    const slots = Object.keys(entry.images || {});
    if (!slots.length) return null;
    const opts = { access: 'public', handleUploadUrl: UPLOAD_ENDPOINT };
    await Promise.all(slots.map((slot) =>
      upload(`games/${entry.id}/${slot}.png`, entry.images[slot], { ...opts, contentType: 'image/png' })
    ));
    // meta.json goes LAST: its presence is the "entry complete" marker the read
    // path and hasGame() key on, so a half-finished upload never looks whole.
    const meta = {
      schemaVersion: entry.schemaVersion,
      promptKey: entry.promptKey || null,
      sourcePrompt: entry.sourcePrompt || '',
      createdAt: entry.createdAt || Date.now(),
      config: entry.config,
      assetMeta: entry.assetMeta || null,
      slots
    };
    await upload(`games/${entry.id}/meta.json`,
      new Blob([JSON.stringify(meta)], { type: 'application/json' }),
      { ...opts, contentType: 'application/json' });
    return entry.id;
  } catch (err) {
    warnOnce(err);
    return null;
  }
};

// Matcher candidate cards for the WHOLE shared population (entry-shaped, no
// images) via /api/games/list. [] on any failure — reads as "no candidates".
export const listGames = async () => {
  try {
    const res = await fetch('/api/games/list');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.games) ? data.games : [];
  } catch {
    return [];
  }
};

export const findByPromptKey = async () => null; // local-only in v1
export const touch = async () => false; // no server-side LRU in v1
export const deleteGame = async () => false; // cleanup is a dashboard concern in v1
