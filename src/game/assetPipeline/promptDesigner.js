/**
 * Asset prompt designer.
 *
 * Rule: code owns the invariants, the designer owns the flavor. The designer (Gemini
 * text call, or the local theme tables as fallback) only produces short subject
 * descriptors plus a style guide; the slot scaffolds in slotSpecs.js append the
 * non-negotiable constraints (white background, facing right, tileability, framing).
 */
import { SLOT_SPECS, BASELINE_SLOTS, BG_CLAUSE, PROPS_GRID_SPEC } from './slotSpecs';
import { isGeminiConfigured, generateJson } from './providers/geminiImage';

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
    collectibles: 'gold coin with a frosty blue rim',
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
    collectibles: 'gold coin with a molten ember glow',
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
    collectibles: 'gold coin wreathed in tiny green leaves',
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
    collectibles: 'holographic gold credit coin',
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
    collectibles: 'glowing golden energy coin',
    projectile: 'bright cyan laser beam bolt',
    colorPalette: 'deep purples, blues, pinks, cosmic colors (#000033, #4B0082, #9400D3, #DDA0DD)',
    atmosphere: 'cosmic, futuristic, otherworldly'
  }
};

/**
 * Entity extraction — the prompt-fidelity guarantee. When the player NAMES an
 * enemy, hazard or collectible ("skeleton enemies", "spikes", "coins"), that noun
 * is binding for the corresponding asset: it becomes the HEAD of the local subject
 * phrase, a MUST clause in the LLM designer prompt, and a post-validation check on
 * the designer's answer. Client-reported failures this fixes: "skeleton enemies"
 * shipped knights, "spikes" shipped generic blue blocks (2026-08-06).
 * Matching is cosmetic-only — a false positive steers art, never physics.
 */
const ENEMY_NOUNS = /\b(skeleton|zombie|ghost|ghoul|goblin|orc|troll|ogre|dragon|demon|imp|vampire|mummy|witch|wizard|knight|ninja|pirate|robot|drone|alien|slime|bat|spider|scorpion|snake|serpent|wolf|bear|shark|crab|rat|golem|yeti|dinosaur|clown|samurai|viking|crocodile|frog)s?\b/i;
const HAZARD_NOUNS = /\b(spike|saw|sawblade|buzzsaw|blade|spear|icicle|stalagmite|stalactite|thorn|cactus|mine|bomb|trap|geyser|boulder|barrel|anvil|laser)s?\b/i;
const COLLECTIBLE_NOUNS = /\b(coin|gem|gemstone|diamond|crystal|jewel|ring|orb|apple|banana|cherry|heart|key|token|treasure|star)s?\b/i;
// Stop-words stripped from a matched "<X> enemies" noun phrase. Generic filler
// (game, lots, more…) is included so "a game with enemies" yields NO entity
// rather than a literal "game enemy".
const PHRASE_STOPWORDS = /\b(the|a|an|some|many|more|lots|few|several|plenty|tons|other|game|games|with|and|of|as|has|have|are|evil|scary|dangerous|deadly|patrolling|attacking)\b/g;

export function extractEntities(promptText) {
  const text = (promptText || '').toLowerCase();
  const entities = { enemy: null, hazard: null, collectible: null };
  // Noun-phrase form first: "(flying) skeleton enemies" — up to two words before
  // the role word carry the player's actual creature.
  const phrase = text.match(/(?:^|[\s,])((?:[a-z-]+\s)?[a-z-]+)\s+(?:enemies|enemy|monsters?|creatures?|foes?|villains?|bosses)\b/);
  if (phrase) {
    const cleaned = phrase[1].replace(PHRASE_STOPWORDS, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) entities.enemy = cleaned;
  }
  if (!entities.enemy) {
    const m = text.match(ENEMY_NOUNS);
    if (m) entities.enemy = m[1];
  }
  const h = text.match(HAZARD_NOUNS);
  if (h) entities.hazard = h[1];
  const c = text.match(COLLECTIBLE_NOUNS);
  if (c) entities.collectible = c[1];
  return entities;
}

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
  // User-named entities become the HEAD of the subject phrase: image models
  // weight the head noun, so "a menacing skeleton enemy, styled to match …" wins
  // where the old phrasing (head noun "enemy creature", the player's word buried
  // in a quoted scene clause) kept shipping generic guards.
  const entities = extractEntities(promptText);
  return {
    backgrounds: `distant scenery landscape of "${subject}"`,
    characters: player,
    levelElements: `ground terrain surface matching "${subject}"`,
    platforms: `floating platform block matching "${subject}"`,
    player,
    enemy: entities.enemy
      ? `a menacing ${entities.enemy} enemy, styled to match "${subject}"`
      : `menacing enemy creature from "${subject}"`,
    hazards: entities.hazard
      ? `a cluster of sharp ${entities.hazard}s, a ${entities.hazard} hazard, styled to match "${subject}"`
      : `dangerous stationary hazard object from "${subject}"`,
    collectibles: entities.collectible
      ? `a single shiny ${entities.collectible} pickup, styled to match "${subject}"`
      : `a single shiny gold coin pickup matching "${subject}"`,
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
    collectibles: finalData.collectibles,
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
  collectible: 'shiny gold coin pickup',
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
    enemy: { type: 'STRING', description: 'The patrolling enemy. If the player request names a specific creature (e.g. skeletons), it must be exactly that creature' },
    obstacle: { type: 'STRING', description: 'The stationary hazard. If the player request names one (e.g. spikes), depict exactly that' },
    collectible: { type: 'STRING', description: 'The small score pickup the player collects (default: a coin). If the player request names one (e.g. gems), exactly that' },
    projectile: { type: 'STRING', description: 'The small ranged attack shot the hero fires' },
    entityNouns: {
      type: 'OBJECT',
      description: 'Canonical identity of each asset: ONE lowercase singular noun (max two words) naming what it depicts, e.g. "skeleton", "lava golem", "ruby"',
      properties: {
        player: { type: 'STRING' },
        enemy: { type: 'STRING' },
        obstacle: { type: 'STRING' },
        collectible: { type: 'STRING' },
        projectile: { type: 'STRING' }
      }
    },
    tags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '5-10 lowercase search tags for the whole set: art style, mood, era, environment (e.g. "pixel art", "gothic", "volcanic")'
    }
  },
  // mid/near are optional — buildFinalPrompt falls back to the far subject via subjectKey
  required: ['styleSummary', 'colorPalette', 'accentPalette', 'background_far', 'floor', 'platform', 'player', 'enemy', 'obstacle', 'collectible', 'projectile', 'entityNouns', 'tags']
};

function buildDesignerPrompt(userPrompt, gameType, entities = {}) {
  const modeDesc = gameType === 'platformer'
    ? 'a 2D side-scrolling action platformer'
    : 'a 2D side-scrolling endless runner';
  const must = (entity, article = 'a') =>
    entity ? ` — the player explicitly asked for: ${entity}. It MUST be ${article} ${entity}` : '';
  const anyNamed = !!(entities.enemy || entities.hazard || entities.collectible);
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
    `- enemy: a patrolling enemy creature${must(entities.enemy)} (max 20 words)\n` +
    `- obstacle: a stationary hazard object${must(entities.hazard)} (max 15 words)\n` +
    `- collectible: the small score pickup the player collects, a coin by default${must(entities.collectible)} (max 12 words)\n` +
    `- projectile: the small ranged shot the hero fires, matching the accentPalette (max 10 words)\n` +
    `- entityNouns: for player/enemy/obstacle/collectible/projectile, the ONE lowercase ` +
    `singular noun (max two words) naming what each depicts — used for cataloguing, ` +
    `not shown to players\n` +
    `- tags: 5-10 lowercase search tags for the whole set (art style, mood, era, environment)\n\n` +
    `Rules:\n` +
    (anyNamed
      ? `- BINDING: entities the player named in the request are requirements, not ` +
        `inspiration — never substitute a generic creature or object for them.\n`
      : '') +
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
  for (const slot of [...BASELINE_SLOTS, 'projectile', 'collectible']) {
    subjects[slot] = SLOT_SPECS[slot].fallbackSubject(directions) || DEFAULT_SUBJECTS[slot];
  }
  const entities = extractEntities(userPrompt);
  return {
    source: 'local',
    styleGuide: {
      styleSummary: directions.styleGuide || 'retro game aesthetic',
      colorPalette: directions.colorPalette || 'standard arcade colors',
      accentPalette: THEME_ACCENTS[themeKey] || DEFAULT_ACCENT
    },
    subjects,
    // Which slots the user explicitly named — buildFinalPrompt swaps their accent
    // treatment from "dominant colors" to rim-light so identity beats palette.
    entities,
    taxonomy: localTaxonomy({ gameType, themeKey, entities })
  };
}

/**
 * Extract and validate the per-slot subjects from a designer LLM response.
 * Returns null when any required slot is missing — callers fall back locally.
 * User-named entities are ENFORCED: if the designer's subject dropped the noun
 * the player asked for, it is prepended as the new head (keeps the LLM's
 * palette/flavor words, restores the binding identity).
 */
function subjectsFromDesignerResult(result, entities = {}) {
  if (!result || typeof result !== 'object') return null;
  const subjects = {};
  for (const slot of [...BASELINE_SLOTS, 'projectile']) {
    if (!result[slot] || typeof result[slot] !== 'string') return null;
    subjects[slot] = result[slot];
  }
  // Collectible is newer than the required set — tolerate designer omissions.
  for (const slot of ['background_mid', 'background_near', 'collectible']) {
    if (typeof result[slot] === 'string' && result[slot].trim()) subjects[slot] = result[slot];
  }
  if (!subjects.collectible) subjects.collectible = DEFAULT_SUBJECTS.collectible;
  const bind = (slot, entity) => {
    if (!entity || !subjects[slot]) return;
    const head = entity.split(/\s+/).pop().replace(/s$/, '');
    if (!subjects[slot].toLowerCase().includes(head)) {
      subjects[slot] = `a ${entity} — ${subjects[slot]}`;
    }
  };
  bind('enemy', entities.enemy);
  bind('obstacle', entities.hazard);
  bind('collectible', entities.collectible);
  return subjects;
}

/**
 * Canonical per-asset identity nouns + free search tags (cache/search metadata,
 * added 2026-08-11). The LLM tags comprehensively — words no keyword table knows —
 * but matching-grade fields stay normalized here and USER-NAMED entities always
 * win over the LLM's noun (binding beats description). Free tags are for
 * search/analytics only, never for automatic reuse decisions.
 */
const normNoun = (value) => {
  if (typeof value !== 'string') return null;
  const cleaned = value.toLowerCase().replace(/[^a-z\s-]/g, ' ').trim()
    .split(/\s+/).filter(Boolean).slice(-2).join(' ');
  if (!cleaned) return null;
  // Light singularization: "skeletons" → "skeleton"; leave "boss"/"glass" alone.
  return cleaned.length > 3 && cleaned.endsWith('s') && !cleaned.endsWith('ss')
    ? cleaned.slice(0, -1)
    : cleaned;
};

function taxonomyFromDesignerResult(result, entities = {}) {
  const llm = result?.entityNouns || {};
  const ents = {};
  const put = (slot, userNoun, llmNoun) => {
    const v = normNoun(userNoun) || normNoun(llmNoun);
    if (v) ents[slot] = v;
  };
  put('player', null, llm.player);
  put('enemy', entities.enemy, llm.enemy);
  put('obstacle', entities.hazard, llm.obstacle);
  put('collectible', entities.collectible, llm.collectible);
  put('projectile', null, llm.projectile);
  const tags = Array.isArray(result?.tags)
    ? [...new Set(result.tags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(Boolean))].slice(0, 12)
    : [];
  return { entities: ents, tags };
}

// Keyless / design-failure fallback: tag what is confidently known — the mode,
// the matched theme, and any user-named entities. Minimal but never empty-handed.
function localTaxonomy({ gameType, themeKey, entities = {} }) {
  const ents = {};
  if (entities.enemy) ents.enemy = normNoun(entities.enemy);
  if (entities.hazard) ents.obstacle = normNoun(entities.hazard);
  if (entities.collectible) ents.collectible = normNoun(entities.collectible);
  const tags = [gameType === 'platformer' ? 'platformer' : 'runner'];
  if (themeKey) tags.push(themeKey);
  return { entities: ents, tags };
}

function styleGuideFromDesignerResult(result) {
  return {
    styleSummary: result.styleSummary || 'retro game aesthetic',
    colorPalette: result.colorPalette || 'standard arcade colors',
    accentPalette: result.accentPalette || DEFAULT_ACCENT
  };
}

/**
 * Design the style guide + per-slot subjects for a generation run.
 * One Gemini text call when a key is available; local theme tables on any
 * failure or empty prompt.
 */
export async function designAssetPrompts({ userPrompt, gameType, themeKey, assetDesignDirections, timeoutMs = 12000 }) {
  const fallback = () => localDesign({ gameType, themeKey, userPrompt, assetDesignDirections });

  if (!userPrompt?.trim() || !isGeminiConfigured()) {
    return fallback();
  }

  const entities = extractEntities(userPrompt);
  try {
    const result = await generateJson({
      prompt: buildDesignerPrompt(userPrompt, gameType, entities),
      responseSchema: DESIGNER_RESPONSE_SCHEMA,
      timeoutMs,
      label: 'design' // cost-report attribution
    });
    const subjects = subjectsFromDesignerResult(result, entities);
    if (!subjects) return fallback();
    return {
      source: 'gemini',
      styleGuide: styleGuideFromDesignerResult(result),
      subjects,
      entities,
      taxonomy: taxonomyFromDesignerResult(result, entities)
    };
  } catch (err) {
    console.warn('[PromptDesigner] Gemini design failed, using local templates:', err.message);
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

// Keyed sprite slots ask for a chroma-key background (see CHROMA_KEYS in
// slotSpecs): platform and collectible are keyed too but aren't "gameplay accent" slots.
const KEYED_SPRITE_SLOTS = new Set([...GAMEPLAY_SLOTS, 'platform', 'collectible']);

// Palette-collision guard for the chroma color: a green goblin on a green screen
// gets flood-keyed into nothing, so green-leaning subjects get the magenta screen
// and vice versa. Both leaning → fall back to the legacy white backdrop.
const GREENISH = /\b(green|emerald|lime|jade|moss|mossy|leaf|leafy|foliage|jungle|forest|swamp|grass|grassy|slime|toxic|acid|zombie|goblin|orc|cactus|vine|fern|frog|turtle|dragon)\b/i;
const MAGENTAISH = /\b(magenta|pink|fuchsia|purple|violet|lavender|neon|candy|sakura|blossom|orchid|plum)\b/i;
function pickChromaColor(text) {
  const green = GREENISH.test(text);
  const magenta = MAGENTAISH.test(text);
  if (green && magenta) return null; // white
  if (green) return 'magenta';
  return 'green';
}

/**
 * Recover which chroma background a final prompt asked for — the pipeline derives
 * its keying/despill configuration from the prompt itself (single source of truth,
 * no extra plumbing between prompt design and post-processing).
 */
export function chromaFromPrompt(prompt) {
  if (!prompt) return null;
  if (/#00FF00/i.test(prompt)) return 'green';
  if (/#FF00FF/i.test(prompt)) return 'magenta';
  return null;
}

// Per-slot color/contrast clauses WITHOUT the shared base string — used by both
// buildFinalPrompt (which prepends the base) and the combined-props grid prompt
// (which states the base once for all cells). Keeping this in one place is what
// preserves the readability buckets (gameplay accent vs user-named natural colors
// vs collectible gold vs terrain palette) on every path.
function slotStyleClauses(slotKey, styleGuide, { userNamed = false } = {}) {
  const accent = styleGuide.accentPalette || DEFAULT_ACCENT;
  if (GAMEPLAY_SLOTS.has(slotKey)) {
    // Accent-as-dominant is the readability rule for designer-invented sprites —
    // but when the USER named the entity ("spikes"), identity beats palette: a
    // lava world's complementary teal accent must not repaint spikes blue. The
    // named branch keeps saturation/outline/silhouette (contrast survives) and
    // demotes the accent to rim-light/trim.
    const colorClause = userNamed
      ? `its natural iconic colors, accented with ${accent} rim-light and trim details`
      : `dominant colors: ${accent}`;
    return `${colorClause}, vivid and highly saturated, bold dark ` +
      `outline, strong silhouette, must stand out instantly against a dark muted environment`;
  }
  if (slotKey === 'collectible') {
    // Pickups read as rewards: bright metallic gold, never the accent hue (a coin
    // must look like a coin) — unless the designer's subject says otherwise.
    return `bright iconic colors with a metallic gold default, glowing ` +
      `highlight, bold dark outline, instantly readable at very small size`;
  }
  if (slotKey === 'background_far') {
    return `color palette ${styleGuide.colorPalette}, muted desaturated tones, ` +
      `soft atmospheric haze, gentle contrast so foreground gameplay elements stand out`;
  }
  if (slotKey === 'background_mid' || slotKey === 'background_near') {
    return `color palette ${styleGuide.colorPalette}, very dark near-black ` +
      `silhouette tones, distinctly darker than a distant hazy background`;
  }
  // floor, platform — terrain: main palette, readable edges, medium-dark value
  return `color palette ${styleGuide.colorPalette}, medium-dark tones with ` +
    `a clearly defined lighter top edge`;
}

const styleBase = (styleGuide) =>
  `${styleGuide.styleSummary}, 16-bit pixel art style, flat 2D game asset, sharp pixels, clear outlines`;

export function buildFinalPrompt(slotKey, subjects, styleGuide, { userNamed = false } = {}) {
  const spec = SLOT_SPECS[slotKey];
  const subject = subjects[slotKey] ?? (spec.subjectKey ? subjects[spec.subjectKey] : undefined);
  const style = `${styleBase(styleGuide)}, ${slotStyleClauses(slotKey, styleGuide, { userNamed })}`;
  const chroma = KEYED_SPRITE_SLOTS.has(slotKey)
    ? pickChromaColor(`${subject || ''} ${style}`)
    : null;
  return spec.scaffold(subject, style, { chroma });
}

/**
 * Compose the combined-props grid prompt (PM_GRID_PROPS): one image, one cell per
 * slot, one shared chroma backdrop stated once. Each cell keeps its slot's
 * invariants (via spec.cellEssence) and its style bucket (via slotStyleClauses);
 * the shared base style is stated once in the tail. The BG_CLAUSE hex rides in the
 * prompt text so chromaFromPrompt recovers the keying color as usual.
 *
 * Returns { prompt, chroma, cellSlots, layout } or NULL when:
 * - the chroma pick collides to white (green AND magenta subjects) — a white
 *   backdrop on light props is the known keying hazard, so the pipeline falls back
 *   to individual calls where each slot picks its own screen; or
 * - no layout exists for the slot count / a slot lacks a cellEssence.
 */
export function buildPropsGridPrompt(cellSlots, subjects, styleGuide, namedBySlot = {}) {
  const layout = PROPS_GRID_SPEC.layouts[cellSlots.length];
  if (!layout) return null;
  const cells = [];
  for (const slot of cellSlots) {
    const spec = SLOT_SPECS[slot];
    if (!spec?.cellEssence) return null;
    const subject = subjects[slot] ?? (spec.subjectKey ? subjects[spec.subjectKey] : undefined);
    const style = slotStyleClauses(slot, styleGuide, { userNamed: !!namedBySlot[slot] });
    cells.push({ slot, text: spec.cellEssence(subject, style), styleText: style, subject });
  }
  const chroma = pickChromaColor(cells.map((c) => `${c.subject || ''} ${c.styleText}`).join(' '));
  if (!chroma) return null; // white collision → individual calls
  // Positional naming ("cell 2 (top-right)") is the anti-cell-swap measure — the
  // sheet scaffold's numbered-cell convention, applied to arbitrary small grids.
  const posFor = (i) => {
    const col = i % layout.cols;
    const colWord = col === 0 ? 'left' : (col === layout.cols - 1 ? 'right' : 'middle');
    if (layout.rows === 1) return colWord;
    const rowWord = Math.floor(i / layout.cols) === 0 ? 'top' : 'bottom';
    return `${rowWord}-${colWord}`;
  };
  const cellLines = cells.map((c, i) => `cell ${i + 1} (${posFor(i)}): ${c.text}`);
  for (let i = 0; i < (layout.emptyCells || 0); i++) {
    const idx = cells.length + i;
    cellLines.push(`cell ${idx + 1} (${posFor(idx)}): completely empty, nothing drawn, only the flat backdrop color`);
  }
  const prompt =
    `a ${layout.cols}x${layout.rows} grid of ${cellLines.length} cells, each cell containing one ` +
    `separate standalone 2d video game asset sprite, each subject alone in its own grid cell, ` +
    `centered with clear margin, subjects never touch or overlap each other or the cell ` +
    `boundaries. Reading left to right, top to bottom: ` +
    cellLines.join('; ') + `. ` +
    `Every cell shares one continuous backdrop: ${BG_CLAUSE(chroma)}, in every single cell, ` +
    `no grid lines, no cell borders, no dividers, no shadows, no text, ` +
    `${styleBase(styleGuide)}`;
  return { prompt, chroma, cellSlots: [...cellSlots], layout };
}
