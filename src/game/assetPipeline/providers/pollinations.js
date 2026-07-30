/**
 * Pollinations.ai provider — keyless URL-based generation, used as the free
 * fallback when Gemini is unavailable, and as the source of directly-loadable
 * URLs for paths that skip preloading (share links, initial presets).
 */

/**
 * Replace words that trip browser adblockers when they appear in the URL path.
 */
export function sanitizePollinationsPrompt(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\bobstacle\b/g, 'barrier')
    .replace(/\bhazard\b/g, 'danger')
    .replace(/\badvert\b/g, 'promo');
}

function getPollinationsKey() {
  return (import.meta.env.VITE_POLLINATIONS_API_KEY || localStorage.getItem('POLLINATIONS_API_KEY') || '').trim();
}

// Pollinations rejects browser cross-origin requests with Cloudflare Turnstile
// ("Missing Turnstile token"), so all requests go same-origin through the Vite
// proxy (vite.config.js). Production hosts need an equivalent /api/pollinations
// rewrite to https://image.pollinations.ai.
const POLLINATIONS_BASE = import.meta.env.VITE_POLLINATIONS_BASE || '/api/pollinations';

export function buildPollinationsUrl({ prompt, width, height, seed }) {
  const key = getPollinationsKey();
  // 'token' is the auth param the current Pollinations API honors (the legacy 'key'
  // param is ignored, leaving requests on the heavily rate-limited anonymous tier)
  const authSuffix = key ? `&token=${key}` : '';
  const encoded = encodeURIComponent(sanitizePollinationsPrompt(prompt));
  return `${POLLINATIONS_BASE}/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}${authSuffix}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read Pollinations image blob.'));
    reader.readAsDataURL(blob);
  });
}

// Pollinations allows roughly ONE in-flight generation at a time (extra concurrent
// requests 429), so every call runs through a strict serial queue: one request fully
// completes, then a short gap, then the next starts. A 429 extends the gap.
const AUTH_GAP_MS = 3000;
const ANON_GAP_MS = 15000;
const PENALTY_GAP_MS = 20000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let requestQueue = Promise.resolve();

function enqueueRequest(task) {
  const run = requestQueue.then(task);
  requestQueue = run.then(
    () => sleep(getPollinationsKey() ? AUTH_GAP_MS : ANON_GAP_MS),
    (err) => sleep(err?.status === 429 ? PENALTY_GAP_MS : ANON_GAP_MS)
  );
  return run;
}

/**
 * Generate a single image. Returns { dataUrl, provider: 'pollinations' }.
 * Fetch + FileReader (rather than an <img> element) so the result is a data URL,
 * keeping downstream canvases untainted for pixel reads.
 */
export function generateImage({ prompt, width, height, seed, timeoutMs = 45000 }) {
  return enqueueRequest(async () => {
    const url = buildPollinationsUrl({ prompt, width, height, seed });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`Pollinations responded with HTTP ${res.status}.`);
        err.status = res.status;
        throw err;
      }
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error(`Pollinations returned non-image content (${blob.type}).`);
      return { dataUrl: await blobToDataUrl(blob), provider: 'pollinations' };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Pollinations timed out after ${timeoutMs}ms.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}

// Pollinations' free TEXT tier (text.pollinations.ai, model 'openai-fast') — used
// for the prompt-design step when Gemini is off, so free-path assets are designed
// from the user's actual prompt instead of canned theme tables. Same-origin base
// for the same Turnstile/CORS reason as images (see vite.config.js / vercel.json).
const POLLINATIONS_TEXT_BASE = import.meta.env.VITE_POLLINATIONS_TEXT_BASE || '/api/pollinations-text';

/**
 * One JSON-mode completion on the free text tier. Returns the parsed object.
 * NOT routed through the image serial queue: it's a different upstream service,
 * and the single design call always completes before image generation starts.
 * Throws on HTTP errors, timeout, or unparseable output — callers fall back to
 * local templates.
 */
export async function generateDesignJson({ prompt, timeoutMs = 20000 }) {
  const key = getPollinationsKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${POLLINATIONS_TEXT_BASE}/${key ? `?token=${key}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'openai-fast',
        jsonMode: true
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`Pollinations text responded with HTTP ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    const raw = (await res.text()).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '');
    let parsed = JSON.parse(raw);
    // Some deployments answer in OpenAI chat-completion shape — unwrap it.
    if (parsed && Array.isArray(parsed.choices)) {
      const content = parsed.choices[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Pollinations text returned an empty completion.');
      parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Pollinations text returned non-object JSON.');
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Pollinations text timed out after ${timeoutMs}ms.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
