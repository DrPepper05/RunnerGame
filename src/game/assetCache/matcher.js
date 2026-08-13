// Cache-reuse matcher (added 2026-08-13): decides whether a NEW prompt can reuse
// an already-generated art set instead of paying for a fresh image run.
//
// Two matchers, one contract — both take { userPrompt, candidates } (candidates =
// idbBackend.listGames() entries, blobs stripped) and return
// { matchId, replaceSlots, reason } or null:
// - matchCachedGame: ONE gemini-flash-latest JSON call (~$0.001 — three orders of
//   magnitude below one image call). The LLM judges world/subject fit from each
//   set's source prompt, tags and entity nouns, and names the slots that clash.
// - localMatch: keyless/LLM-failure fallback — deterministic theme + user-named
//   entity comparison, whole-set only.
// Art is MODE-AGNOSTIC by design decision: a runner's set may serve a platformer
// (physics/config always come from the new prompt; only images are shared).

import { generateJson } from '../assetPipeline/providers/geminiImage.js';
import { GENERATED_SLOTS } from '../assetPipeline/slotSpecs.js';
import { extractEntities } from '../assetPipeline/promptDesigner.js';
import { parsePromptKeywords } from '../promptUtils.js';

const SLOT_VOCAB = [...GENERATED_SLOTS, 'projectile', 'collectible'];

// Prompt-generated configs carry no themeKey — derive it from the entry's own
// source prompt so theme comparison works for every candidate.
const candidateTheme = (c) =>
  c.config?.themeKey || parsePromptKeywords(c.sourcePrompt || '').themeKey || null;

const entityMap = (c) => Object.fromEntries(
  Object.entries(c.assetMeta?.slots || {})
    .filter(([, m]) => m?.entity)
    .map(([slot, m]) => [slot, m.entity])
);

// Light noun normalization matching the taxonomy convention (lowercase,
// singularized) so "skeletons" compares equal to a stored "skeleton".
const norm = (s) => {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase();
  return v.length > 3 && v.endsWith('s') && !v.endsWith('ss') ? v.slice(0, -1) : v || null;
};

const MATCH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    matchId: { type: 'STRING', description: 'id of the ONE cached set that fits the new request, or empty string when none fits' },
    replaceSlots: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'slots whose depicted subject clashes with the new request and must be redrawn; empty when the set fits as-is'
    },
    reason: { type: 'STRING', description: 'short justification, max 12 words' }
  },
  required: ['matchId', 'replaceSlots', 'reason']
};

const buildMatchPrompt = (userPrompt, payload) => (
  `A player asked for a new 2D game: "${userPrompt}".\n\n` +
  `Previously generated art sets (id, sourcePrompt, name, theme, tags, entities per slot):\n` +
  `${JSON.stringify(payload)}\n\n` +
  `Decide whether ONE of these sets visually fits the new request well enough to reuse its images.\n` +
  `Rules:\n` +
  `- Art is game-mode agnostic: a runner set may serve a platformer and vice versa.\n` +
  `- Judge world/theme/setting and depicted subjects (sourcePrompt, tags, entities). ` +
  `Reuse must never put the player in the wrong world — a lava prompt must not get an ice set.\n` +
  `- replaceSlots: ONLY slots whose SUBJECT clashes with the new request (e.g. the player asked ` +
  `for skeleton enemies but the set's enemy is a wolf). Allowed names: ${SLOT_VOCAB.join(', ')}.\n` +
  `- Palette or style nuance alone is NOT a clash.\n` +
  `- Nothing fits → matchId is an empty string.`
);

export async function matchCachedGame({ userPrompt, candidates }) {
  const payload = candidates.map((c) => ({
    id: c.id,
    sourcePrompt: c.sourcePrompt || '',
    gameName: c.config?.gameName ?? null,
    themeKey: candidateTheme(c),
    gameType: c.config?.gameType ?? null,
    tags: c.assetMeta?.tags ?? [],
    entities: entityMap(c)
  }));
  const result = await generateJson({
    prompt: buildMatchPrompt(userPrompt, payload),
    responseSchema: MATCH_SCHEMA,
    timeoutMs: 12000,
    label: 'cache-match'
  });
  const matchId = typeof result?.matchId === 'string' ? result.matchId.trim() : '';
  if (!matchId || !candidates.some((c) => c.id === matchId)) return null;
  const replaceSlots = [...new Set(
    (Array.isArray(result.replaceSlots) ? result.replaceSlots : []).filter((s) => SLOT_VOCAB.includes(s))
  )];
  return { matchId, replaceSlots, reason: typeof result.reason === 'string' ? result.reason : '' };
}

// Deterministic fallback: theme must match, and every entity the user NAMED must
// already be what the candidate depicts. Whole-set only (never proposes redraws —
// redrawing costs money and this path exists to stay free). Candidates arrive
// most-recently-used first, so the first hit is the freshest.
export function localMatch({ userPrompt, candidates }) {
  const themeKey = parsePromptKeywords(userPrompt).themeKey;
  if (!themeKey) return null;
  const wanted = extractEntities(userPrompt);
  const wantedPairs = [
    ['enemy', wanted.enemy],
    ['obstacle', wanted.hazard],
    ['collectible', wanted.collectible]
  ].filter(([, noun]) => noun);
  for (const c of candidates) {
    if (candidateTheme(c) !== themeKey) continue;
    const entities = entityMap(c);
    if (wantedPairs.every(([slot, noun]) => norm(entities[slot]) === norm(noun))) {
      return { matchId: c.id, replaceSlots: [], reason: 'theme match (offline)' };
    }
  }
  return null;
}
