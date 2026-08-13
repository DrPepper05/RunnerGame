// Client-upload token endpoint for the asset cache's server backend (Vercel Blob).
// The browser asks this route for a scoped one-time token, then uploads DIRECTLY
// to Blob storage (no function body-size limit, no double bandwidth). This is the
// only server-side code in the project; the read path needs none (public store,
// deterministic paths).
//
// Guardrails: uploads are restricted to games/<gameId>/<slot>.png|meta.json,
// PNG/JSON only, ≤4MB per file. The endpoint is public by design (same accepted
// posture as the client-side Gemini key) — these bounds cap the abuse.
//
// Reads BLOB_READ_WRITE_TOKEN from the environment automatically (injected by the
// connected Blob store; locally via `vercel env pull` / .env for `vercel dev`).

import { handleUpload } from '@vercel/blob/client';

// gameId is crypto.randomUUID() (or a hex-dash fallback); slots are snake_case.
const ALLOWED_PATH = /^games\/[a-z0-9][a-z0-9-]{6,63}\/(?:[a-z][a-z0-9_]{0,31}\.png|meta\.json)$/;

// The store's public hostname, derived server-side so the client needs NO env
// var of its own (GET below). The token embeds the store id
// (vercel_blob_rw_<STOREID>_...); BLOB_STORE_ID is honored when present.
const publicBaseUrl = () => {
  const explicit = (process.env.BLOB_STORE_ID || '').replace(/^store_/i, '');
  const fromToken = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([A-Za-z0-9]+)_/)?.[1];
  const id = explicit || fromToken;
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
};

export default async function handler(req, res) {
  // GET = discovery: tell the client where the public store lives. The value is
  // public by design (it appears in every asset URL).
  if (req.method === 'GET') {
    const baseUrl = publicBaseUrl();
    if (!baseUrl) {
      res.status(404).json({ error: 'Blob store not configured' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({ baseUrl });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!ALLOWED_PATH.test(pathname)) {
          throw new Error('Invalid upload path');
        }
        return {
          allowedContentTypes: ['image/png', 'application/json'],
          maximumSizeInBytes: 4 * 1024 * 1024,
          addRandomSuffix: false, // deterministic paths are the read-path contract
          allowOverwrite: true, // restyles re-upload the same slot paths
          // Short CDN/browser cache: repeat opens per device are served from the
          // local IndexedDB write-back, not HTTP cache — freshness after a
          // restyle matters more than long-lived edge caching.
          cacheControlMaxAge: 300
        };
      }
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
