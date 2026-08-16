// Candidate index for the asset-cache matcher (added 2026-08-14): lists every
// cached game in the Blob store as an entry-shaped "card" (no images), so the
// matcher can reuse the shared population on ANY device — not just the browser
// that generated it. Aggregation is CDN-cached (s-maxage) so the per-folder
// meta.json fetches run at most every few minutes, not per visitor.

import { list } from '@vercel/blob';

const publicBaseUrl = () => {
  const explicit = (process.env.BLOB_STORE_ID || '').replace(/^store_/i, '');
  const fromToken = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([A-Za-z0-9]+)_/)?.[1];
  const id = explicit || fromToken;
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
};

const MAX_FOLDERS = 500; // runaway backstop far above any near-term catalog size

// Strip a full meta.json down to the matcher card: identity + matching metadata
// in the SAME shape as a local IndexedDB entry (minus images), so the client
// matcher consumes local entries and server cards interchangeably.
const toCard = (id, meta) => ({
  id,
  schemaVersion: meta.schemaVersion,
  promptKey: meta.promptKey || null,
  sourcePrompt: meta.sourcePrompt || '',
  createdAt: meta.createdAt || null,
  config: {
    gameName: meta.config?.gameName ?? null,
    gameType: meta.config?.gameType ?? null,
    themeKey: meta.config?.themeKey ?? null
  },
  assetMeta: {
    view: meta.assetMeta?.view || 'side',
    tags: meta.assetMeta?.tags || [],
    slots: Object.fromEntries(
      Object.entries(meta.assetMeta?.slots || {})
        .filter(([, m]) => m && m.entity)
        .map(([slot, m]) => [slot, { entity: m.entity }])
    )
  },
  imageSlots: Array.isArray(meta.slots) ? meta.slots : []
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const base = publicBaseUrl();
  if (!base) {
    res.status(200).json({ games: [] });
    return;
  }
  try {
    const folders = [];
    let cursor;
    do {
      const page = await list({ prefix: 'games/', mode: 'folded', cursor });
      folders.push(...(page.folders || []));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && folders.length < MAX_FOLDERS);

    const ids = folders
      .map((f) => f.replace(/^games\//, '').replace(/\/$/, ''))
      .filter(Boolean)
      .slice(0, MAX_FOLDERS);

    const games = [];
    const CONCURRENCY = 8;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const cards = await Promise.all(chunk.map(async (id) => {
        try {
          const metaRes = await fetch(`${base}/games/${id}/meta.json`);
          if (!metaRes.ok) return null; // half-uploaded entry — not yet complete
          return toCard(id, await metaRes.json());
        } catch {
          return null;
        }
      }));
      games.push(...cards.filter(Boolean));
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.status(200).json({ games });
  } catch (err) {
    console.error('[games/list]', err?.message || err);
    res.status(200).json({ games: [] }); // a broken index must read as "no candidates"
  }
}
