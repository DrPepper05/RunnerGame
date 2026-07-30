/**
 * Gemini image + text provider (@google/genai, browser build).
 *
 * The API key is client-side by design (same pattern as the rest of the app's VITE_ keys).
 * Every failure is mapped to a ProviderError kind so the pipeline can decide between
 * retrying here and falling back to Pollinations.
 */
import { GoogleGenAI } from '@google/genai';
import { GEMINI_IMAGE_MODEL, GEMINI_TEXT_MODEL } from '../slotSpecs';

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

/**
 * Generate a single image. Returns { dataUrl, provider: 'gemini' }.
 * Pass `referenceImageDataUrl` for image-editing calls: the reference rides along as
 * an inlineData part so the model redraws THAT character instead of imagining a new
 * one (the identity anchor for sprite-sheet generation).
 */
export async function generateImage({ prompt, aspectRatio = '1:1', timeoutMs = 45000, referenceImageDataUrl = null }) {
  const ai = getClient();

  let contents = prompt;
  if (referenceImageDataUrl) {
    const match = referenceImageDataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (match) {
      contents = [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: match[1], data: match[2] } }
        ]
      }];
      timeoutMs = Math.max(timeoutMs, 60000);
    }
  }

  let response;
  try {
    response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents,
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio }
        }
      }),
      timeoutMs,
      'Gemini image generation'
    );
  } catch (err) {
    throw toProviderError(err);
  }

  const candidate = response?.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(p => p.inlineData?.data);
  if (!imagePart) {
    const finishReason = candidate?.finishReason || 'unknown';
    const kind = /safety/i.test(finishReason) ? 'safety' : 'no-image';
    throw new ProviderError(`Gemini returned no image (finishReason: ${finishReason}).`, kind);
  }

  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  return { dataUrl: `data:${mimeType};base64,${imagePart.inlineData.data}`, provider: 'gemini' };
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
