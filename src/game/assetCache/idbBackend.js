// Local IndexedDB backend for the asset cache. This is the swappable half of the
// cache: a future server backend (Vercel Blob/KV) implements the same five async
// methods and assetCache/index.js composes them — nothing in the app layer changes.
//
// Error posture: every method resolves to null/false on ANY failure and never
// throws. A cache failure must read as a cache miss, never break generation.

const DB_NAME = 'playmint-cache';
const DB_VERSION = 1;
const STORE = 'games';

// LRU budget: keep at most this many games AND this many bytes of image blobs.
const MAX_GAMES = 12;
const MAX_BYTES = 64 * 1024 * 1024;

let dbPromise = null;
let disabled = false;
let warned = false;

const warnOnce = (err) => {
  if (warned) return;
  warned = true;
  console.warn('[AssetCache] disabled (storage unavailable):', err?.message || err);
};

const req = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const openDb = () => {
  if (disabled) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        disabled = true;
        warnOnce(err);
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('promptKey', 'promptKey');
          store.createIndex('lastAccess', 'lastAccess');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        disabled = true;
        warnOnce(request.error);
        resolve(null);
      };
      request.onblocked = () => {
        disabled = true;
        warnOnce(new Error('open blocked'));
        resolve(null);
      };
    });
  }
  return dbPromise;
};

// Runs fn(store) inside a transaction; resolves null on any failure.
const withStore = async (mode, fn) => {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, mode);
    return await fn(tx.objectStore(STORE));
  } catch (err) {
    warnOnce(err);
    return null;
  }
};

export const isAvailable = async () => !!(await openDb());

export const getGame = (id) => {
  if (!id) return Promise.resolve(null);
  return withStore('readonly', (store) => req(store.get(id))).then(r => r || null);
};

// Most-recently-accessed entry matching the key (the index allows duplicates —
// e.g. a force-fresh rerun of the same prompt writes a second entry).
export const findByPromptKey = (promptKey) => {
  if (!promptKey) return Promise.resolve(null);
  return withStore('readonly', (store) =>
    req(store.index('promptKey').getAll(promptKey))
  ).then((matches) => {
    if (!matches || matches.length === 0) return null;
    matches.sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
    return matches[0];
  });
};

const deleteOldest = (store) =>
  req(store.index('lastAccess').getAllKeys()).then((keys) => {
    if (!keys || keys.length === 0) return false;
    // getAllKeys on the lastAccess index returns primary keys ordered by the
    // index value ascending — keys[0] is the least-recently-used entry.
    return req(store.delete(keys[0])).then(() => true);
  });

const evictLRU = (store) =>
  req(store.getAll()).then(async (all) => {
    if (!all) return;
    all.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
    let count = all.length;
    let bytes = all.reduce((sum, e) => sum + (e.bytes || 0), 0);
    for (const entry of all) {
      if (count <= MAX_GAMES && bytes <= MAX_BYTES) break;
      await req(store.delete(entry.id));
      count -= 1;
      bytes -= entry.bytes || 0;
    }
  });

export const putGame = async (entry) => {
  if (!entry?.id) return null;
  const stamped = { ...entry, bytes: Object.values(entry.images || {}).reduce((s, b) => s + (b?.size || 0), 0) };
  const attempt = () => withStore('readwrite', async (store) => {
    await req(store.put(stamped));
    await evictLRU(store);
    return stamped.id;
  });
  let id = await attempt();
  if (id == null) {
    // Likely QuotaExceededError — free one LRU slot and retry once.
    await withStore('readwrite', deleteOldest);
    id = await attempt();
  }
  return id;
};

// All entries WITHOUT their image blobs (candidate list for the reuse matcher),
// most-recently-used first. `imageSlots` keeps the slot names so the ladder knows
// what a base set contains. Failure resolves to [] — reads as "no candidates".
export const listGames = () =>
  withStore('readonly', (store) => req(store.getAll()))
    .then((all) => (all || [])
      .map(({ images, ...rest }) => ({ ...rest, imageSlots: Object.keys(images || {}) }))
      .sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0)));

export const touch = (id) => {
  if (!id) return Promise.resolve(false);
  return withStore('readwrite', async (store) => {
    const entry = await req(store.get(id));
    if (!entry) return false;
    entry.lastAccess = Date.now();
    await req(store.put(entry));
    return true;
  }).then(r => !!r);
};

export const deleteGame = (id) => {
  if (!id) return Promise.resolve(false);
  return withStore('readwrite', (store) => req(store.delete(id)).then(() => true)).then(r => !!r);
};
