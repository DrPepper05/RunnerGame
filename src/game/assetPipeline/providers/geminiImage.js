/**
 * Gemini image + text provider (@google/genai, browser build).
 *
 * The API key is client-side by design (same pattern as the rest of the app's VITE_ keys).
 * Every failure is mapped to a ProviderError kind so the pipeline can decide between
 * retrying and downgrading the run to built-in static theme art.
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
  // Gemini is the only image provider — configured simply means a key is present
  // (env or entered via the UI). Without one, generation downgrades to the
  // built-in static theme asset set.
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

// Config fields a given model rejected with a 400 this session (e.g. thinkingConfig
// on a model that can't disable thinking, imageSize values it doesn't accept).
// Each rejection costs one failed round-trip per model per session, then the field
// is silently dropped — new API surface can never hard-break generation.
const rejectedConfigFields = new Map(); // model -> Set<fieldName>
const fieldRejected = (model, field) => rejectedConfigFields.get(model)?.has(field);
const rememberRejectedField = (model, field) => {
  if (!rejectedConfigFields.has(model)) rejectedConfigFields.set(model, new Set());
  rejectedConfigFields.get(model).add(field);
  console.warn(`[GeminiImage] ${model} rejected ${field} — dropping it for this session.`);
};
const isFieldRejectionError = (err, field) => {
  const status = err?.status ?? err?.code;
  if (status !== 400) return false;
  const message = (err?.message || '').toLowerCase();
  if (field === 'thinkingConfig') return /think/.test(message);
  if (field === 'imageSize') return /image_?size|resolution/.test(message);
  return false;
};

// ---- Cost telemetry --------------------------------------------------------
// ESTIMATES from usageMetadata + a static price table ($/1M output tokens; input
// side is a rough $0.50/1M for images, real rates for text). The authoritative
// number is always Google's billing console — this exists so a run can report
// where its money went and so thinking-token inflation is visible.
const MODEL_PRICES = {
  'gemini-3.1-flash-lite-image': 30,
  'gemini-3.1-flash-image': 60,
  'gemini-3-pro-image': 120,
  'gemini-2.5-flash-image': 30
};
const DEFAULT_IMAGE_PRICE = 60;
const TEXT_IN_PRICE = 0.30, TEXT_OUT_PRICE = 2.50;

let usageTally = null;
export function resetUsageTally() {
  usageTally = {
    imageCalls: 0, visionCalls: 0, imageFailures: 0, visionFailures: 0,
    promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, estUsd: 0, calls: []
  };
}
export function getUsageTally() {
  return usageTally
    ? { ...usageTally, calls: [...usageTally.calls], estUsd: Math.round(usageTally.estUsd * 1000) / 1000 }
    : null;
}

// Cumulative spend across every game generated in this browser (localStorage) —
// lets the cost report answer "what has testing cost so far", not just this game.
export function getSessionSpend() {
  try {
    return JSON.parse(localStorage.getItem('PM_SPEND_TOTAL') || 'null');
  } catch {
    return null;
  }
}
function addToSessionSpend(kind, estUsd) {
  try {
    const total = getSessionSpend() || { estUsd: 0, imageCalls: 0, visionCalls: 0, since: new Date().toISOString() };
    total.estUsd = Math.round((total.estUsd + estUsd) * 10000) / 10000;
    if (kind === 'image') total.imageCalls++; else total.visionCalls++;
    localStorage.setItem('PM_SPEND_TOTAL', JSON.stringify(total));
  } catch { /* localStorage unavailable — session totals are best-effort */ }
}

// A call that terminally failed still matters for observability: a broken QA path
// must show up as "N failed", not as a quiet zero that looks like "QA off".
//
// It also has to show up in the TIME columns. A failed call burns real wall clock
// (a 45s image timeout is the single slowest thing that can happen in a run), and
// until 2026-08-20 it pushed no calls[] entry at all — so every timeout silently
// contributed 0ms and made slow runs look inexplicably slow. Failures now log a
// zero-cost, elapsed-bearing entry flagged `failed`: include it in duration math,
// never in cost math.
function recordFailure(kind, extra = {}) {
  if (!usageTally) return;
  if (kind === 'image') usageTally.imageFailures++; else usageTally.visionFailures++;
  usageTally.calls.push({
    at: new Date().toISOString(),
    kind,
    failed: true,
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    promptTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    ...(extra.elapsedMs != null ? { elapsedMs: extra.elapsedMs } : {}),
    estUsd: 0
  });
}

function recordUsage(kind, model, usage, extra = {}) {
  const prompt = usage?.promptTokenCount || 0;
  // A missing usage payload on an image call still cost ~one image of tokens.
  const out = usage?.candidatesTokenCount || (kind === 'image' ? 1200 : 0);
  const thoughts = usage?.thoughtsTokenCount || 0;
  const estUsd = kind === 'image'
    ? (((out + thoughts) * (MODEL_PRICES[model] ?? DEFAULT_IMAGE_PRICE)) + prompt * 0.5) / 1e6
    : ((prompt * TEXT_IN_PRICE) + (out + thoughts) * TEXT_OUT_PRICE) / 1e6;
  console.debug(`[GeminiCost] ${kind} ${model}${extra.label ? ` (${extra.label})` : ''}: in=${prompt} out=${out} thoughts=${thoughts} ≈$${estUsd.toFixed(4)}`);
  addToSessionSpend(kind, estUsd);
  if (!usageTally) return;
  if (kind === 'image') usageTally.imageCalls++; else usageTally.visionCalls++;
  usageTally.promptTokens += prompt;
  usageTally.outputTokens += out;
  usageTally.thoughtsTokens += thoughts;
  usageTally.estUsd += estUsd;
  // Full per-call log — rides on assetMeta.cost so the UI can offer it as a
  // downloadable report instead of sending testers to the DevTools console.
  usageTally.calls.push({
    at: new Date().toISOString(),
    kind,
    ...(extra.label ? { label: extra.label } : {}),
    model,
    ...(extra.requestedSize ? { requestedSize: extra.requestedSize } : {}),
    ...(extra.served ? { servedW: extra.served.w, servedH: extra.served.h } : {}),
    promptTokens: prompt,
    outputTokens: out,
    thoughtsTokens: thoughts,
    ...(extra.elapsedMs != null ? { elapsedMs: extra.elapsedMs } : {}),
    estUsd: Math.round(estUsd * 10000) / 10000
  });
}

// Decode probe: the served resolution is the ground truth of whether the API
// honored imageSize — billed tokens alone can't distinguish "0.5K ignored" from
// "0.5K honored but billed with overhead".
function imageDims(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

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
  imageSize = null,
  label = null
}) {
  const ai = getClient();
  const t0 = performance.now(); // wall time per call (incl. retries + decode probe)

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
  // Generic last-resort for a 400 the specific detectors don't recognize: drop the
  // optional fields once and retry bare; only a SUCCESSFUL bare retry caches the
  // rejection (a network 400 must never permanently disable suppression/sizing).
  let strippedOptional = false;
  for (;;) {
    const sizeActive = !strippedOptional && imageSize && activeModel.startsWith('gemini-3') && !fieldRejected(activeModel, 'imageSize');
    // Thinking is billed by default on 3.x models — ask for none. Models that
    // can't disable it (e.g. pro) reject once, then the field is dropped.
    const thinkActive = !strippedOptional && activeModel.startsWith('gemini-3') && !fieldRejected(activeModel, 'thinkingConfig');
    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: activeModel,
          contents,
          config: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio, ...(sizeActive ? { imageSize } : {}) },
            ...(thinkActive ? { thinkingConfig: { thinkingBudget: 0 } } : {})
          }
        }),
        timeoutMs,
        'Gemini image generation'
      );
      if (strippedOptional) {
        // The bare retry worked, so the optional fields were the problem. Caching
        // both over-caches at worst (loses suppression/sizing, never a generation).
        rememberRejectedField(activeModel, 'thinkingConfig');
        rememberRejectedField(activeModel, 'imageSize');
      }
      break;
    } catch (err) {
      if (thinkActive && isFieldRejectionError(err, 'thinkingConfig')) {
        rememberRejectedField(activeModel, 'thinkingConfig');
        continue;
      }
      if (sizeActive && isFieldRejectionError(err, 'imageSize')) {
        rememberRejectedField(activeModel, 'imageSize');
        continue;
      }
      if ((err?.status ?? err?.code) === 400 && (thinkActive || sizeActive)) {
        strippedOptional = true;
        continue;
      }
      if (activeModel !== GEMINI_IMAGE_FALLBACK_MODEL && isModelUnavailableError(err)) {
        console.warn(`[GeminiImage] Model "${activeModel}" unavailable for this key — falling back to ${GEMINI_IMAGE_FALLBACK_MODEL}.`);
        unavailableImageModels.add(activeModel);
        activeModel = GEMINI_IMAGE_FALLBACK_MODEL;
        strippedOptional = false;
        continue;
      }
      recordFailure('image', { label, model: activeModel, reason: err?.message?.slice(0, 120), elapsedMs: Math.round(performance.now() - t0) });
      throw toProviderError(err);
    }
  }

  const candidate = response?.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(p => p.inlineData?.data);
  if (!imagePart) {
    const finishReason = candidate?.finishReason || 'unknown';
    recordFailure('image', { label, model: activeModel, reason: `no-image:${finishReason}`, elapsedMs: Math.round(performance.now() - t0) });
    const kind = /safety/i.test(finishReason) ? 'safety' : 'no-image';
    throw new ProviderError(`Gemini returned no image (finishReason: ${finishReason}).`, kind);
  }

  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  const dataUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
  let served = null;
  try { served = await imageDims(dataUrl); } catch { /* dimension probe is optional */ }
  recordUsage('image', activeModel, response?.usageMetadata, {
    label,
    requestedSize: imageSize || null,
    served,
    elapsedMs: Math.round(performance.now() - t0)
  });
  return { dataUrl, provider: 'gemini', model: activeModel, width: served?.w, height: served?.h };
}

/**
 * Generate structured JSON with the text model. Returns the parsed object.
 * Pass `imageDataUrl` for vision calls (the QA reviewer) — the image rides along as an
 * inlineData part. Any failure surfaces as a ProviderError so callers can fall back.
 */
export async function generateJson({ prompt, responseSchema, imageDataUrl = null, timeoutMs = 12000, label = null }) {
  const ai = getClient();
  const t0 = performance.now();

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
  // Hard-learned 2026-08-05: the rolling text alias rejected thinkingBudget:0 in a
  // shape the specific detector missed, and BOTH art direction and vision QA died
  // silently for a whole run (design: 'local', 0 vision calls, qa: null — while
  // image generation billed normally). Rule: the thinking field must NEVER take
  // this path down — retry ANY first failure without it, and cache the rejection
  // only when removing the field is what fixed the call.
  let failedWithThinking = false;
  for (;;) {
    const thinkActive = !failedWithThinking && !fieldRejected(GEMINI_TEXT_MODEL, 'thinkingConfig');
    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: GEMINI_TEXT_MODEL,
          contents,
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            // QA verdicts don't need reasoning depth — thinking tokens are billed.
            // Both knobs on purpose: budget 0 is the 2.5-era switch, and the live
            // report of 2026-08-05 proved the current alias ACCEPTS it while still
            // billing ~850 thinking tokens/call — thinkingLevel MINIMAL is the
            // 3.x-era switch. Models that reject the combo hit the defensive
            // retry below and run without the field.
            ...(thinkActive ? { thinkingConfig: { thinkingBudget: 0, thinkingLevel: 'MINIMAL' } } : {})
          }
        }),
        timeoutMs,
        'Gemini structured call'
      );
      if (failedWithThinking) rememberRejectedField(GEMINI_TEXT_MODEL, 'thinkingConfig');
      break;
    } catch (err) {
      if (thinkActive) {
        failedWithThinking = true;
        continue;
      }
      recordFailure('vision', { label, model: GEMINI_TEXT_MODEL, reason: err?.message?.slice(0, 120), elapsedMs: Math.round(performance.now() - t0) });
      throw toProviderError(err);
    }
  }
  recordUsage('vision', GEMINI_TEXT_MODEL, response?.usageMetadata, { label, elapsedMs: Math.round(performance.now() - t0) });

  try {
    return JSON.parse(response.text);
  } catch {
    recordFailure('vision', { label, model: GEMINI_TEXT_MODEL, reason: 'unparseable-json', elapsedMs: Math.round(performance.now() - t0) });
    throw new ProviderError('Gemini structured call returned unparseable JSON.', 'no-image');
  }
}
