/**
 * Asset prompt designer.
 *
 * Rule: code owns the invariants, the designer owns the flavor. The designer (Gemini
 * text call, or the local theme tables as fallback) only produces short subject
 * descriptors plus a style guide; the slot scaffolds in slotSpecs.js append the
 * non-negotiable constraints (white background, facing right, tileability, framing).
 */
import { SLOT_SPECS, BASELINE_SLOTS } from './slotSpecs';
import { isGeminiConfigured, generateJson } from './providers/geminiImage';
import { generateDesignJson } from './providers/pollinations';

/**
 * Theme subject tables — the local fallback recipe.
 * (Moved here from geminiService.generateAssetDirections so there is exactly one copy;
 * geminiService re-imports generateAssetDirections from this module.)
 */
const THEMES = {
  ice: {
    backgrounds: 'frozen tundra with icy mountains, snow-covered peaks, glaciers, aurora borealis sky, crystalline ice formations',
    levelElements: 'frozen ground with snow texture, icy surface, frost patterns',
    platforms: 'ice platform block, frozen ledge, crystalline structure',
    playerPlatformer: 'arctic warrior with fur coat, ice sword, blue armor',
    playerRunner: 'winter athlete runner, cold weather gear, athletic build',
    enemy: 'ice golem monster, frozen yeti creature, frost elemental',
    hazards: 'ice spikes, frozen stalactites, sharp icicles',
    projectile: 'jagged glowing ice shard bolt',
    colorPalette: 'cool blues, whites, cyans, pale purples, ice blue (#E6F3FF, #B3D9FF, #4D94FF)',
    atmosphere: 'cold, crystalline, shimmering'
  },
  lava: {
    backgrounds: 'volcanic landscape with lava flows, molten rock, ash clouds, red sky, erupting volcanos',
    levelElements: 'volcanic rock ground, obsidian surface, cracked magma texture',
    platforms: 'volcanic rock platform, obsidian ledge, basalt block',
    playerPlatformer: 'fire knight with flaming sword, heat-resistant armor',
    playerRunner: 'heat runner with protective suit, athletic stance',
    enemy: 'lava golem, fire demon, magma elemental creature',
    hazards: 'lava pit, fire geyser, molten rock spike',
    projectile: 'blazing fireball with molten orange core',
    colorPalette: 'reds, oranges, dark grays, yellow highlights (#FF6B35, #FF4500, #DC143C, #8B0000)',
    atmosphere: 'hot, glowing, dangerous'
  },
  forest: {
    backgrounds: 'dense forest with tall trees, canopy layers, sunlight filtering through leaves, moss and vines',
    levelElements: 'grass and dirt ground, forest floor with leaves, natural earth texture',
    platforms: 'wooden log platform, tree branch, moss-covered stone',
    playerPlatformer: 'forest ranger with bow and arrow, green cloak',
    playerRunner: 'nature runner, athletic explorer, green outfit',
    enemy: 'forest wolf, giant spider, evil tree creature',
    hazards: 'thorn bush, poison plant, falling branch',
    projectile: 'sharp wooden arrow with glowing green fletching',
    colorPalette: 'greens, browns, earth tones (#228B22, #32CD32, #8FBC8F, #654321)',
    atmosphere: 'natural, organic, mysterious'
  },
  city: {
    backgrounds: 'urban cityscape with skyscrapers, neon signs, busy streets, night skyline, modern buildings',
    levelElements: 'concrete sidewalk, asphalt road, urban ground texture',
    platforms: 'metal scaffold, concrete ledge, building rooftop',
    playerPlatformer: 'urban ninja with tech gear, cyberpunk outfit',
    playerRunner: 'parkour runner, urban athlete, street clothes',
    enemy: 'security robot, street thug, drone enemy',
    hazards: 'electrical barrier, steam vent, construction hazard',
    projectile: 'neon plasma bolt with electric sparks',
    colorPalette: 'grays, neon colors, blues, purples (#696969, #FF00FF, #00FFFF, #1E90FF)',
    atmosphere: 'urban, modern, neon-lit'
  },
  space: {
    backgrounds: 'cosmic space with stars, nebulas, distant planets, asteroid fields, galaxy backdrop',
    levelElements: 'metallic space station floor, alien ground surface, lunar terrain',
    platforms: 'floating space platform, asteroid chunk, metal beam',
    playerPlatformer: 'space marine with laser rifle, powered armor',
    playerRunner: 'astronaut runner, space suit, jetpack',
    enemy: 'alien creature, space pirate, robot sentinel',
    hazards: 'laser barrier, meteor, energy field',
    projectile: 'bright cyan laser beam bolt',
    colorPalette: 'deep purples, blues, pinks, cosmic colors (#000033, #4B0082, #9400D3, #DDA0DD)',
    atmosphere: 'cosmic, futuristic, otherworldly'
  }
};

function extractCustomElements(promptText) {
  const lower = promptText.toLowerCase();
  const customElements = [];

  if (lower.includes('dark')) customElements.push('dark atmosphere');
  if (lower.includes('bright')) customElements.push('bright lighting');
  if (lower.includes('neon')) customElements.push('neon glow effects');
  if (lower.includes('retro')) customElements.push('retro arcade style');
  if (lower.includes('pixel')) customElements.push('enhanced pixel art');
  if (lower.includes('minimal')) customElements.push('minimalist design');
  if (lower.includes('detailed')) customElements.push('highly detailed textures');
  if (lower.includes('simple')) customElements.push('simple clean design');

  return customElements.length > 0 ? customElements.join(', ') : null;
}

/**
 * Build asset directions from the prompt text itself. Free-path quality varies
 * with the prompt, but at least it depicts what the player asked for.
 */
function customDirectionsFromPrompt(promptText, gameType) {
  // Strip instruction filler ("make me a ... game about") so the image model sees
  // the world description, not the request phrasing.
  const subject = promptText.trim()
    .replace(/^(?:please\s+)?(?:make|create|generate|build|give)\s+(?:me\s+)?(?:a|an)?\s*/i, '')
    .replace(/\b(?:video\s*)?game\s*(?:about|with|of|set in)?\s*/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 140) || promptText.trim().slice(0, 140);
  const player = gameType === 'platformer'
    ? `the armed hero character of "${subject}"`
    : `the athletic running hero of "${subject}"`;
  return {
    backgrounds: `distant scenery landscape of "${subject}"`,
    characters: player,
    levelElements: `ground terrain surface matching "${subject}"`,
    platforms: `floating platform block matching "${subject}"`,
    player,
    enemy: `menacing enemy creature from "${subject}"`,
    hazards: `dangerous stationary hazard object from "${subject}"`,
    projectile: `small glowing energy projectile matching "${subject}"`,
    styleGuide: 'retro game aesthetic, clear pixel definition, vibrant colors',
    colorPalette: `a cohesive palette that fits "${subject}"`
  };
}

/**
 * Deterministic theme-based asset directions (the shape carried on
 * config.assetDesignDirections). Blends a secondary theme and prompt keywords.
 * `theme` may be null: prompts that match no predefined theme design from the
 * prompt text instead of defaulting to a canned theme.
 */
export function generateAssetDirections(theme, secondaryTheme, promptText, gameType) {
  // A written prompt ALWAYS drives the subjects — a matched theme only contributes
  // its curated palette and mood. The old precedence (theme match → canned tables,
  // prompt discarded) is why free-path assets came out on-theme but off-prompt:
  // "underground dungeon with skeleton enemies" must depict dungeons and skeletons,
  // not whichever canned theme a keyword happened to match.
  if (promptText?.trim()) {
    const custom = customDirectionsFromPrompt(promptText, gameType);
    const themeData = THEMES[theme];
    if (themeData) {
      custom.colorPalette = themeData.colorPalette;
      custom.styleGuide = `retro game aesthetic, ${themeData.atmosphere} mood, clear pixel definition, vibrant colors`;
    }
    return custom;
  }
  const themeData = THEMES[theme] || THEMES.forest;
  const player = gameType === 'platformer' ? themeData.playerPlatformer : themeData.playerRunner;

  const finalData = { ...themeData, player };
  if (secondaryTheme && secondaryTheme !== theme && THEMES[secondaryTheme]) {
    const secondaryData = THEMES[secondaryTheme];
    finalData.backgrounds = `${themeData.backgrounds}, with elements of ${secondaryData.atmosphere} atmosphere`;
    finalData.colorPalette = `${themeData.colorPalette}, accented with ${secondaryData.colorPalette}`;
  }

  const customElements = extractCustomElements(promptText || '');
  if (customElements) {
    finalData.backgrounds = `${finalData.backgrounds}, ${customElements}`;
  }

  return {
    backgrounds: finalData.backgrounds,
    characters: finalData.player,
    levelElements: finalData.levelElements,
    platforms: finalData.platforms,
    player: finalData.player,
    enemy: finalData.enemy,
    hazards: finalData.hazards,
    projectile: finalData.projectile,
    styleGuide: 'retro game aesthetic, clear pixel definition, vibrant colors',
    colorPalette: finalData.colorPalette
  };
}

const DEFAULT_SUBJECTS = {
  background_far: 'scenery landscape background backdrop',
  floor: 'ground surface tiling block texture',
  platform: 'floating platform ledge block tile',
  player: 'running character sprite',
  enemy: 'patrolling enemy monster creature',
  obstacle: 'danger barrier block or spike',
  projectile: 'glowing energy bolt'
};

const DESIGNER_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    styleSummary: { type: 'STRING', description: 'Short overall art direction, max 12 words' },
    colorPalette: { type: 'STRING', description: 'Environment color palette description, max 10 words' },
    accentPalette: { type: 'STRING', description: 'Contrasting saturated accent colors for characters and hazards, complementary hue to the environment, max 8 words' },
    background_far: { type: 'STRING' },
    background_mid: { type: 'STRING', description: 'Midground silhouette elements (optional)' },
    background_near: { type: 'STRING', description: 'Foreground scenery elements (optional)' },
    floor: { type: 'STRING' },
    platform: { type: 'STRING' },
    player: { type: 'STRING' },
    enemy: { type: 'STRING' },
    obstacle: { type: 'STRING' },
    projectile: { type: 'STRING', description: 'The small ranged attack shot the hero fires' }
  },
  // mid/near are optional — buildFinalPrompt falls back to the far subject via subjectKey
  required: ['styleSummary', 'colorPalette', 'accentPalette', 'background_far', 'floor', 'platform', 'player', 'enemy', 'obstacle', 'projectile']
};

function buildDesignerPrompt(userPrompt, gameType) {
  const modeDesc = gameType === 'platformer'
    ? 'a 2D side-scrolling action platformer'
    : 'a 2D side-scrolling endless runner';
  return (
    `You are the art director for ${modeDesc} generated from this player request: "${userPrompt}".\n\n` +
    `Design one cohesive visual identity and describe six game assets. Return JSON with:\n` +
    `- styleSummary: the shared art direction (max 12 words)\n` +
    `- colorPalette: the ENVIRONMENT palette (max 10 words)\n` +
    `- accentPalette: saturated accent colors for the player, enemy and hazards — pick a ` +
    `hue that CONTRASTS strongly with the environment palette (complementary or ` +
    `near-complementary, brighter and more saturated), so gameplay elements pass the ` +
    `squint test against the scenery (max 8 words)\n` +
    `- background_far: the distant background scenery (max 20 words)\n` +
    `- background_mid: midground silhouette elements, e.g. structures or terrain shapes (max 15 words)\n` +
    `- background_near: closer foreground scenery elements (max 15 words)\n` +
    `- floor: the ground/terrain surface material (max 15 words)\n` +
    `- platform: a floating platform block (max 15 words)\n` +
    `- player: the hero character (max 20 words)\n` +
    `- enemy: a patrolling enemy creature (max 20 words)\n` +
    `- obstacle: a stationary hazard object (max 15 words)\n` +
    `- projectile: the small ranged shot the hero fires, matching the accentPalette (max 10 words)\n\n` +
    `Rules:\n` +
    `- Describe SUBJECTS ONLY. Do not mention backgrounds, isolation, transparency, framing, ` +
    `camera angle, facing direction, or tiling — those are added automatically.\n` +
    `- For player, enemy, obstacle and platform: avoid white or near-white as a dominant color; ` +
    `prefer saturated colors with dark outlines.\n` +
    `- Readability comes first: backgrounds stay muted and atmospheric, gameplay elements ` +
    `use the accentPalette and must stand out instantly.\n` +
    `- All six must clearly belong to the same world and palette.`
  );
}

/**
 * Local deterministic design: subject descriptors from assetDesignDirections when the
 * config carries them, otherwise generated from the theme tables.
 */
// Per-theme character accents for the local (no-LLM) path: roughly complementary to
// each theme's environment palette, so sprites pass the squint test out of the box.
const THEME_ACCENTS = {
  ice: 'warm amber, coral and crimson accents',
  lava: 'cool teal, cyan and steel-blue accents',
  forest: 'warm crimson, orange and gold accents',
  city: 'hot orange and golden yellow accents',
  space: 'bright orange, gold and lime accents'
};
const DEFAULT_ACCENT = 'bright warm saturated contrasting accent colors';

export function localDesign({ gameType, themeKey, userPrompt = '', assetDesignDirections = null }) {
  const directions = assetDesignDirections ||
    generateAssetDirections(themeKey, themeKey, userPrompt, gameType || 'runner');

  const subjects = {};
  for (const slot of [...BASELINE_SLOTS, 'projectile']) {
    subjects[slot] = SLOT_SPECS[slot].fallbackSubject(directions) || DEFAULT_SUBJECTS[slot];
  }
  return {
    source: 'local',
    styleGuide: {
      styleSummary: directions.styleGuide || 'retro game aesthetic',
      colorPalette: directions.colorPalette || 'standard arcade colors',
      accentPalette: THEME_ACCENTS[themeKey] || DEFAULT_ACCENT
    },
    subjects
  };
}

/**
 * Extract and validate the per-slot subjects from a designer LLM response.
 * Returns null when any required slot is missing — callers fall back locally.
 */
function subjectsFromDesignerResult(result) {
  if (!result || typeof result !== 'object') return null;
  const subjects = {};
  for (const slot of [...BASELINE_SLOTS, 'projectile']) {
    if (!result[slot] || typeof result[slot] !== 'string') return null;
    subjects[slot] = result[slot];
  }
  for (const slot of ['background_mid', 'background_near']) {
    if (typeof result[slot] === 'string' && result[slot].trim()) subjects[slot] = result[slot];
  }
  return subjects;
}

function styleGuideFromDesignerResult(result) {
  return {
    styleSummary: result.styleSummary || 'retro game aesthetic',
    colorPalette: result.colorPalette || 'standard arcade colors',
    accentPalette: result.accentPalette || DEFAULT_ACCENT
  };
}

// openai-fast has no schema-constrained output like Gemini, so the free-path
// designer prompt must spell the contract out explicitly.
const FREE_DESIGNER_JSON_SUFFIX =
  '\n\nRespond with ONLY a raw JSON object — no markdown fences, no commentary — ' +
  'with exactly these string keys: styleSummary, colorPalette, accentPalette, ' +
  'background_far, background_mid, background_near, floor, platform, player, ' +
  'enemy, obstacle, projectile.';

/**
 * Design the style guide + per-slot subjects for a generation run.
 * One Gemini text call when a key is available; otherwise one free Pollinations
 * text call (openai-fast) so free-path assets still follow the user's prompt
 * instead of canned theme tables; local tables on any failure or empty prompt.
 */
export async function designAssetPrompts({ userPrompt, gameType, themeKey, assetDesignDirections, timeoutMs = 12000 }) {
  const fallback = () => localDesign({ gameType, themeKey, userPrompt, assetDesignDirections });

  if (!userPrompt?.trim()) {
    return fallback();
  }

  if (isGeminiConfigured()) {
    try {
      const result = await generateJson({
        prompt: buildDesignerPrompt(userPrompt, gameType),
        responseSchema: DESIGNER_RESPONSE_SCHEMA,
        timeoutMs
      });
      const subjects = subjectsFromDesignerResult(result);
      if (!subjects) return fallback();
      return { source: 'gemini', styleGuide: styleGuideFromDesignerResult(result), subjects };
    } catch (err) {
      console.warn('[PromptDesigner] Gemini design failed, using local templates:', err.message);
      return fallback();
    }
  }

  // Free path: same art-director step on Pollinations' keyless text tier.
  try {
    const result = await generateDesignJson({
      prompt: buildDesignerPrompt(userPrompt, gameType) + FREE_DESIGNER_JSON_SUFFIX,
      timeoutMs: Math.max(timeoutMs, 20000)
    });
    const subjects = subjectsFromDesignerResult(result);
    if (!subjects) {
      console.warn('[PromptDesigner] Free designer returned incomplete JSON, using local templates.');
      return fallback();
    }
    return { source: 'free-llm', styleGuide: styleGuideFromDesignerResult(result), subjects };
  } catch (err) {
    console.warn('[PromptDesigner] Free designer failed, using local templates:', err.message);
    return fallback();
  }
}

/**
 * Assemble the final generation prompt for one slot. Slots without a designed subject
 * of their own borrow another slot's via spec.subjectKey (parallax layers reuse the
 * far-background subject unless the designer provided a specific one).
 *
 * The style string is PER CATEGORY, not shared — one identical palette string on every
 * slot converges all assets on the same hue and value, and gameplay elements vanish
 * into the scenery. Industry readability rules encoded here: muted hazy backgrounds,
 * dark silhouette tones for nearer decor planes (atmospheric perspective), and one
 * saturated contrasting accent reserved for the player / enemy / hazards.
 */
const GAMEPLAY_SLOTS = new Set(['player', 'player_sheet', 'enemy', 'obstacle', 'projectile']);

export function buildFinalPrompt(slotKey, subjects, styleGuide) {
  const spec = SLOT_SPECS[slotKey];
  const subject = subjects[slotKey] ?? (spec.subjectKey ? subjects[spec.subjectKey] : undefined);
  const base = `${styleGuide.styleSummary}, 16-bit pixel art style, flat 2D game asset, sharp pixels, clear outlines`;
  const accent = styleGuide.accentPalette || DEFAULT_ACCENT;

  let style;
  if (GAMEPLAY_SLOTS.has(slotKey)) {
    style = `${base}, dominant colors: ${accent}, vivid and highly saturated, bold dark ` +
      `outline, strong silhouette, must stand out instantly against a dark muted environment`;
  } else if (slotKey === 'background_far') {
    style = `${base}, color palette ${styleGuide.colorPalette}, muted desaturated tones, ` +
      `soft atmospheric haze, gentle contrast so foreground gameplay elements stand out`;
  } else if (slotKey === 'background_mid' || slotKey === 'background_near') {
    style = `${base}, color palette ${styleGuide.colorPalette}, very dark near-black ` +
      `silhouette tones, distinctly darker than a distant hazy background`;
  } else {
    // floor, platform — terrain: main palette, readable edges, medium-dark value
    style = `${base}, color palette ${styleGuide.colorPalette}, medium-dark tones with ` +
      `a clearly defined lighter top edge`;
  }
  return spec.scaffold(subject, style);
}
