import { isGeminiConfigured, generateJson } from './assetPipeline/providers/geminiImage';
import { GENERATED_SLOTS } from './assetPipeline/slotSpecs';
import { parsePromptKeywords } from './promptUtils';

/**
 * AI game editor — interprets a Creator Panel prompt against the CURRENT game config.
 *
 * Returns { intent: 'tweak' | 'restyle' | 'regenerate', changes, assetTargets?, summary, source }.
 * - 'tweak'      → `changes` is a whitelisted, clamped patch for setLiveParams; the
 *                  running game applies it live via the update-game-config event.
 *                  No asset generation, no reboot.
 * - 'restyle'    → regenerate ONLY the artwork named in `assetTargets` (friendly
 *                  element names; resolveAssetTargets maps them to pipeline slots).
 *                  Config, mode, layout and variable tweaks all survive. 'all' is a
 *                  whole-look re-theme.
 * - 'regenerate' → brand-new game concept: full pipeline (new config + new assets).
 *
 * Game-mode switching is intentionally NOT supported here — mode requests come back
 * as an empty tweak whose summary explains that, instead of nuking the running game.
 *
 * The LLM proposes, code enforces: only whitelisted fields survive, every value is
 * clamped to the same safe ranges geminiService uses. Without a Gemini key (or on any
 * API failure) a local keyword fallback applies modifier deltas to the current values.
 */

// field → { min, max, int } | { bool } | { str, maxLen }
const EDITABLE_FIELDS = {
  runSpeed: { min: 150, max: 800, label: 'runner scroll speed (px/s)' },
  jumpForce: { min: 400, max: 1000, label: 'runner jump impulse' },
  gravity: { min: 600, max: 2600, label: 'runner gravity' },
  obstacleDelay: { min: 400, max: 3000, int: true, label: 'ms between runner obstacles (lower = harder)' },
  difficulty: { min: 1, max: 10, int: true, label: 'overall difficulty 1-10' },
  actionEnemyCount: { min: 0, max: 20, int: true, label: 'platformer enemy count' },
  actionJumpHeight: { min: 300, max: 900, label: 'platformer jump impulse' },
  actionGravity: { min: 500, max: 2200, label: 'platformer gravity' },
  actionProjectileEnabled: { bool: true, label: 'platformer ranged attack on/off' },
  worldWidth: { min: 2000, max: 12000, int: true, label: 'platformer level length (px)' },
  coinValue: { min: 0, max: 500, int: true, label: 'points per collected coin' },
  gameName: { str: true, maxLen: 60, label: 'display title' }
};

// Friendly element name → pipeline slot list. 'player' maps to the sheet slot —
// the pipeline stores its output under the 'player' key and falls back to the
// static sprite when the sheet gates reject, same as a full generation.
const ASSET_TARGET_SLOTS = {
  background: ['background_far', 'background_mid', 'background_near'],
  foreground: ['background_mid', 'background_near'],
  floor: ['floor'],
  platforms: ['platform'],
  player: ['player_sheet'],
  enemy: ['enemy'],
  obstacle: ['obstacle'],
  projectile: ['projectile'],
  collectibles: ['collectible']
};

/** Map restyle target names to a deduped pipeline slot list for this config. */
export function resolveAssetTargets(targets, config) {
  const isPlatformer = config?.gameType === 'platformer';
  const allSlots = GENERATED_SLOTS.map(s => (s === 'player' ? 'player_sheet' : s));
  if (isPlatformer) allSlots.push('projectile');
  allSlots.push('collectible');
  const slots = new Set();
  for (const target of targets || []) {
    if (target === 'all') {
      allSlots.forEach(s => slots.add(s));
      continue;
    }
    for (const slot of ASSET_TARGET_SLOTS[target] || []) {
      if (slot === 'projectile' && !isPlatformer) continue; // runners never shoot
      slots.add(slot);
    }
  }
  return [...slots];
}

const EDITOR_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: {
      type: 'STRING',
      enum: ['tweak', 'restyle', 'regenerate'],
      description: 'tweak = only numeric/boolean gameplay variables or the title change; restyle = new artwork for some or all elements of the CURRENT game; regenerate = a completely different game concept'
    },
    assetTargets: {
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['background', 'foreground', 'floor', 'platforms', 'player', 'enemy', 'obstacle', 'projectile', 'collectibles', 'all'] },
      description: 'Only for intent=restyle: which elements get new artwork. Use "all" for a whole-look re-theme.'
    },
    summary: { type: 'STRING', description: 'One short line describing what changed, e.g. "runSpeed 400 → 560, enemies 5 → 10". For restyle/regenerate, say what is being redrawn and why.' },
    changes: {
      type: 'OBJECT',
      description: 'Only for intent=tweak: the fields to change with their NEW values. Omit fields that stay the same.',
      properties: {
        runSpeed: { type: 'NUMBER' },
        jumpForce: { type: 'NUMBER' },
        gravity: { type: 'NUMBER' },
        obstacleDelay: { type: 'NUMBER' },
        difficulty: { type: 'NUMBER' },
        actionEnemyCount: { type: 'NUMBER' },
        actionJumpHeight: { type: 'NUMBER' },
        actionGravity: { type: 'NUMBER' },
        actionProjectileEnabled: { type: 'BOOLEAN' },
        worldWidth: { type: 'NUMBER' },
        coinValue: { type: 'NUMBER' },
        gameName: { type: 'STRING' }
      }
    }
  },
  required: ['intent', 'summary']
};

function clampChanges(rawChanges) {
  const changes = {};
  if (!rawChanges || typeof rawChanges !== 'object') return changes;
  for (const [key, rule] of Object.entries(EDITABLE_FIELDS)) {
    if (!(key in rawChanges)) continue;
    const value = rawChanges[key];
    if (rule.bool) {
      changes[key] = !!value;
    } else if (rule.str) {
      const s = String(value ?? '').trim();
      if (s) changes[key] = s.slice(0, rule.maxLen);
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      const clamped = Math.min(rule.max, Math.max(rule.min, n));
      changes[key] = rule.int ? Math.round(clamped) : clamped;
    }
  }
  return changes;
}

function currentValues(config) {
  const out = {};
  for (const key of Object.keys(EDITABLE_FIELDS)) {
    if (config?.[key] !== undefined) out[key] = config[key];
  }
  out.gameType = config?.gameType || 'runner';
  return out;
}

function summarize(changes, config) {
  const parts = Object.entries(changes).map(([k, v]) => {
    const oldV = config?.[k];
    return oldV !== undefined && oldV !== v ? `${k} ${oldV} → ${v}` : `${k} = ${v}`;
  });
  return parts.join(', ');
}

async function geminiInterpret(config, instruction) {
  const fieldDocs = Object.entries(EDITABLE_FIELDS)
    .map(([k, r]) => `- ${k}: ${r.label}${r.bool ? ' (boolean)' : r.str ? '' : ` (range ${r.min}-${r.max})`}`)
    .join('\n');

  const prompt = [
    'You are the live game-settings editor for a 2d browser game. The player typed an instruction.',
    'Decide the intent: "tweak" (only the variables below change), "restyle" (some or all',
    'artwork of the CURRENT game is redrawn), or "regenerate" (a completely different game).',
    '',
    `Current game type: ${config?.gameType || 'runner'} (runner fields only matter for runner, action* fields only for platformer).`,
    `Current values: ${JSON.stringify(currentValues(config))}`,
    '',
    'Editable variables:',
    fieldDocs,
    '',
    'Rules:',
    '- Relative requests ("faster", "double the enemies") are computed FROM the current values.',
    '- Renaming the game is a tweak (gameName).',
    '- Art requests naming specific elements ("change the foreground", "make the enemy a robot") are "restyle" with assetTargets listing ONLY the affected elements.',
    '- Re-theming the whole look ("turn this into a lava world", "make it spooky") is "restyle" with assetTargets ["all"]; if the theme suggests a new title, also set gameName in changes.',
    '- Only a completely different game concept or new gameplay rules is "regenerate".',
    '- The game mode CANNOT be changed here. For mode-switch requests ("make this a runner", "turn it into a platformer") return "tweak" with NO changes and a summary explaining the mode can only be chosen when starting a new game.',
    '- For tweak, put ONLY the changed fields in `changes` with their new absolute values.',
    '',
    `Player instruction: "${instruction}"`
  ].join('\n');

  const result = await generateJson({ prompt, responseSchema: EDITOR_RESPONSE_SCHEMA });
  if (result.intent === 'regenerate') {
    return { intent: 'regenerate', changes: {}, summary: result.summary || '', source: 'gemini' };
  }
  if (result.intent === 'restyle') {
    const targets = (result.assetTargets || []).filter(t => t === 'all' || ASSET_TARGET_SLOTS[t]);
    return {
      intent: 'restyle',
      assetTargets: targets.length ? targets : ['all'],
      changes: clampChanges(result.changes),
      summary: result.summary || 'Updating artwork',
      source: 'gemini'
    };
  }
  const changes = clampChanges(result.changes);
  return {
    intent: 'tweak',
    changes,
    summary: summarize(changes, config) || result.summary || 'No changes recognized',
    source: 'gemini'
  };
}

/** Keyless/failed-API fallback: apply keyword-modifier deltas to the CURRENT values. */
function localInterpret(config, instruction) {
  const text = instruction.toLowerCase();

  // Mode switching is intentionally unsupported from the edit prompt — refuse
  // politely instead of falling through to a full regeneration. Tight match:
  // "make the player run faster" must NOT trip this ("runner"/"platformer" only),
  // and asking for the mode the game already is in is a no-op, not a switch.
  const modeMatch = text.match(/\b(?:switch|change|turn|convert|make|swap)\b[^.!?]*\b(runner|platformer|action\s*quest)\b/);
  if (modeMatch) {
    const requested = modeMatch[1] === 'runner' ? 'runner' : 'platformer';
    if (requested !== (config?.gameType || 'runner')) {
      return {
        intent: 'tweak',
        changes: {},
        summary: "The game mode can't be changed from the edit prompt — start a new game to switch modes.",
        source: 'local'
      };
    }
  }

  const parsed = parsePromptKeywords(instruction);
  const changes = {};
  const m = parsed.modifiers;
  const cur = (k, dflt) => (Number.isFinite(config?.[k]) ? config[k] : dflt);

  if (m.isFast || m.moreSpeed) changes.runSpeed = cur('runSpeed', 400) * 1.3;
  if (m.isSlow || m.lessSpeed) changes.runSpeed = cur('runSpeed', 400) * 0.7;
  if (m.highJump) {
    changes.jumpForce = cur('jumpForce', 700) * 1.3;
    changes.actionJumpHeight = cur('actionJumpHeight', 600) * 1.3;
  }
  if (m.isLowGravity) {
    changes.gravity = cur('gravity', 1600) * 0.6;
    changes.actionGravity = cur('actionGravity', 1400) * 0.6;
  }
  if (m.hardcore) {
    changes.difficulty = 10;
    changes.runSpeed = cur('runSpeed', 400) * 1.5;
    changes.obstacleDelay = cur('obstacleDelay', 1200) * 0.6;
    changes.actionEnemyCount = cur('actionEnemyCount', 5) * 2;
  }
  Object.assign(changes, parsed.tuningParams);

  const clamped = clampChanges(changes);
  if (Object.keys(clamped).length) {
    return { intent: 'tweak', changes: clamped, summary: summarize(clamped, config), source: 'local' };
  }

  // No variable change recognized — look for named art elements ("change the
  // foreground", "new enemy") so only those slots get redrawn.
  const targets = [];
  if (/\b(foreground|props?|decorations?|decor)\b/.test(text)) targets.push('foreground');
  if (/\b(background|backdrop|sky|scenery)\b/.test(text)) targets.push('background');
  if (/\b(floor|ground|terrain)\b/.test(text)) targets.push('floor');
  if (/\bplatforms?\b/.test(text)) targets.push('platforms');
  if (/\b(player|hero|character|protagonist)\b/.test(text)) targets.push('player');
  if (/\b(enemy|enemies|monsters?|boss|villains?)\b/.test(text)) targets.push('enemy');
  if (/\b(obstacles?|hazards?|traps?|spikes?)\b/.test(text)) targets.push('obstacle');
  if (/\b(projectiles?|bullets?|bolt)\b/.test(text)) targets.push('projectile');
  if (targets.length) {
    return { intent: 'restyle', assetTargets: targets, changes: {}, summary: `Redrawing ${targets.join(', ')}`, source: 'local' };
  }

  // A theme word means the user wants a different look — re-skin the current game
  // rather than rebuilding it from scratch.
  if (parsed.themeKey) {
    return { intent: 'restyle', assetTargets: ['all'], changes: {}, summary: 'Restyling all artwork', source: 'local' };
  }

  // Nothing recognizable — treat as a brand-new game prompt.
  return { intent: 'regenerate', changes: {}, summary: '', source: 'local' };
}

export async function interpretEditPrompt(config, instruction) {
  if (isGeminiConfigured()) {
    try {
      return await geminiInterpret(config, instruction);
    } catch (err) {
      console.warn('[gameEditor] Gemini interpretation failed, using local fallback:', err?.message || err);
    }
  }
  return localInterpret(config, instruction);
}
