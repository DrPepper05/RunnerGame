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

export default async function handler(req, res) {
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
