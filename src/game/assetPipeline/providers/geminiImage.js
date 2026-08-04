/**
 * Gemini image + text provider (@google/genai, browser build).
 *
 * The API key is client-side by design (same pattern as the rest of the app's VITE_ keys).
 * Every failure is mapped to a ProviderError kind so the pipeline can decide between
 * retrying here and falling back to Pollinations.
 */
import { GoogleGenAI } from '@google/genai';
import { GEMINI_IMAGE_FALLBACK_MODEL, GEMINI_TEXT_MODEL } from '../slotSpecs';

export class ProviderError extends Error {
  /** @param {'no-key'|'auth'|'quota'|'safety'|'no-image'|'network'|'timeout'} kind */
  constructor(message, kind = 'network', retryDelayMs = null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryDelayMs = retryDelayMs;
  }
}

export function getGeminiKey() {
  return (import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem('GEMINI_API_KEY') || '').trim();
}

export function isGeminiConfigured() {
  // Provider selection, three states: the ScreenZero toggle writes '1' (force free
  // path) or '0' (force Gemini) to localStorage and that choice is authoritative;
  // only when the user has never touched the toggle (null) does the baked-in
  // VITE_FORCE_POLLINATIONS env flag decide. Without the '0' override the env flag
  // would silently veto the UI's "Gemini" option (Vite inlines env at build time).
  const override = localStorage.getItem('PM_FORCE_POLLINATIONS');
  if (override === '1') return false;
  if (override === null && import.meta.env.VITE_FORCE_POLLINATIONS === '1') return false;
  return !!getGeminiKey();
}

let cachedClient = null;
let cachedKey = null;

function getClient() {
  const key = getGeminiKey();
  if (!key) throw new ProviderError('No Gemini API key configured.', 'no-key');
  // Re-instantiate when the key changes so a key entered via the UI works without reload
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new GoogleGenAI({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  const status = err?.status ?? err?.code;
  const message = err?.message || String(err);
  if (status === 429) {
    const delayMatch = message.match(/retry.{0,10}?(\d+(?:\.\d+)?)\s*s/i);
    const retryDelayMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) : null;
    return new ProviderError(`Gemini quota exceeded: ${message}`, 'quota', retryDelayMs);
  }
  if (status === 400 || status === 401 || status === 403) {
    return new ProviderError(`Gemini rejected the request: ${message}`, 'auth');
  }
  return new ProviderError(`Gemini request failed: ${message}`, 'network');
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`${label} timed out after ${timeoutMs}ms.`, 'timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Models this key/region turned out not to serve (404 / not-supported on first use).
// Cached per session so a missing 3.x model costs exactly one failed round-trip,
// after which every request lands directly on the legacy fallback model.
const unavailableImageModels = new Set();

const isModelUnavailableError = (err) => {
  const status = err?.status ?? err?.code;
  const message = err?.message || '';
  return status === 404 ||
    /not\s+found|not\s+supported|does not exist|unknown (?:model|name)|is not available/i.test(message);
};

/**
 * Generate a single image. Returns { dataUrl, provider: 'gemini', model }.
 * - `model`: which image model to use (spec-driven; defaults to the legacy fallback).
 *   A model the key can't serve is remembered and transparently replaced by
 *   GEMINI_IMAGE_FALLBACK_MODEL — new model IDs never hard-break a key without access.
 * - `imageSize`: '1K'|'2K'|'4K' — forwarded only to 3.x models (2.5 rejects it).
 * - `referenceImageDataUrls` (or legacy singular `referenceImageDataUrl`): image-editing
 *   references that ride along as inlineData parts so the model redraws THAT character
 *   instead of imagining a new one (the identity anchor for sprite-sheet generation).
 */
export async function generateImage({
  prompt,
  aspectRatio = '1:1',
  timeoutMs = 45000,
  referenceImageDataUrl = null,
  referenceImageDataUrls = null,
  model = null,
  imageSize = null
}) {
  const ai = getClient();

  const refs = referenceImageDataUrls || (referenceImageDataUrl ? [referenceImageDataUrl] : []);
  let contents = prompt;
  const refParts = [];
  for (const ref of refs) {
    const match = ref?.match(/^data:([^;]+);base64,(.*)$/s);
    if (match) refParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  if (refParts.length) {
    contents = [{ parts: [{ text: prompt }, ...refParts] }];
    timeoutMs = Math.max(timeoutMs, 60000);
  }
  // 2K/4K renders are slower end to end — don't let the default budget clip them.
  if (imageSize && imageSize !== '1K') timeoutMs = Math.max(timeoutMs, 60000);

  const requested = model || GEMINI_IMAGE_FALLBACK_MODEL;
  let activeModel = unavailableImageModels.has(requested) ? GEMINI_IMAGE_FALLBACK_MODEL : requested;

  let response;
  for (;;) {
    const sizeAllowed = imageSize && activeModel.startsWith('gemini-3');
    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: activeModel,
          contents,
          config: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio, ...(sizeAllowed ? { imageSize } : {}) }
          }
        }),
        timeoutMs,
        'Gemini image generation'
      );
      break;
    } catch (err) {
      if (activeModel !== GEMINI_IMAGE_FALLBACK_MODEL && isModelUnavailableError(err)) {
        console.warn(`[GeminiImage] Model "${activeModel}" unavailable for this key — falling back to ${GEMINI_IMAGE_FALLBACK_MODEL}.`);
        unavailableImageModels.add(activeModel);
        activeModel = GEMINI_IMAGE_FALLBACK_MODEL;
        continue;
      }
      throw toProviderError(err);
    }
  }

  const candidate = response?.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(p => p.inlineData?.data);
  if (!imagePart) {
    const finishReason = candidate?.finishReason || 'unknown';
    const kind = /safety/i.test(finishReason) ? 'safety' : 'no-image';
    throw new ProviderError(`Gemini returned no image (finishReason: ${finishReason}).`, kind);
  }

  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  return { dataUrl: `data:${mimeType};base64,${imagePart.inlineData.data}`, provider: 'gemini', model: activeModel };
}

/**
 * Generate structured JSON with the text model. Returns the parsed object.
 * Pass `imageDataUrl` for vision calls (the QA reviewer) — the image rides along as an
 * inlineData part. Any failure surfaces as a ProviderError so callers can fall back.
 */
export async function generateJson({ prompt, responseSchema, imageDataUrl = null, timeoutMs = 12000 }) {
  const ai = getClient();

  let contents = prompt;
  if (imageDataUrl) {
    const match = imageDataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match) throw new ProviderError('QA image is not a base64 data URL.', 'no-image');
    contents = [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: match[1], data: match[2] } }
      ]
    }];
    timeoutMs = Math.max(timeoutMs, 15000);
  }

  let response;
  try {
    response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema
        }
      }),
      timeoutMs,
      'Gemini structured call'
    );
  } catch (err) {
    throw toProviderError(err);
  }

  try {
    return JSON.parse(response.text);
  } catch {
    throw new ProviderError('Gemini structured call returned unparseable JSON.', 'no-image');
  }
}
