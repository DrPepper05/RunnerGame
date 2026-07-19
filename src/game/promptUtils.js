/**
 * PlayMint AI Generation Matrix
 * Prompt Parsing and Parameter Generation Utilities
 */

// Automated mechanics tuning table mapping keywords to gameplay variables
export const MECHANICS_TUNING_TABLE = {
  // Speed Modifiers
  fast: { runSpeed: 550, actionWalkSpeed: 420, obstacleDelay: 900, label: 'Turbo Speed' },
  speed: { runSpeed: 500, actionWalkSpeed: 380, obstacleDelay: 1000, label: 'Fast Pace' },
  zoom: { runSpeed: 600, actionWalkSpeed: 450, obstacleDelay: 800, label: 'Zoom Speed' },
  slow: { runSpeed: 240, actionWalkSpeed: 180, obstacleDelay: 1800, label: 'Slow Motion' },
  easy: { runSpeed: 260, actionWalkSpeed: 200, obstacleDelay: 1600, label: 'Relaxed/Easy' },
  chill: { runSpeed: 250, actionWalkSpeed: 190, obstacleDelay: 1700, label: 'Chill Mode' },

  // Gravity & Jump Modifiers
  jump: { jumpForce: 850, actionJumpHeight: 700, gravity: 1600, actionGravity: 1300, label: 'High Leap' },
  float: { jumpForce: 650, actionJumpHeight: 800, gravity: 1000, actionGravity: 800, label: 'Floaty Jump' },
  moon: { jumpForce: 600, actionJumpHeight: 850, gravity: 800, actionGravity: 600, label: 'Moon Gravity' },
  space: { jumpForce: 650, actionJumpHeight: 750, gravity: 900, actionGravity: 700, label: 'Space Physics' },
  heavy: { jumpForce: 950, actionJumpHeight: 500, gravity: 2400, actionGravity: 2100, label: 'Heavy Gravity' },

  // Threat & Combat Modifiers
  fight: { actionEnemyCount: 8, obstacleDelay: 850, actionProjectileEnabled: true, label: 'Combat Action' },
  combat: { actionEnemyCount: 9, obstacleDelay: 800, actionProjectileEnabled: true, label: 'Deep Combat' },
  enemies: { actionEnemyCount: 7, label: 'Enemy Swarm' },
  shoot: { actionProjectileEnabled: true, actionEnemyCount: 6, label: 'Ranged Combat' },
  hard: { actionEnemyCount: 8, runSpeed: 480, gravity: 2000, obstacleDelay: 850, label: 'Hard Challenge' },
  hardcore: { actionEnemyCount: 12, runSpeed: 600, gravity: 2200, obstacleDelay: 600, actionProjectileEnabled: true, label: 'Hardcore Survival' },
  peaceful: { actionEnemyCount: 0, obstacleDelay: 2500, label: 'Zen / Peaceful' },

  // World Bounding Modifiers
  short: { worldWidth: 1600, label: 'Mini Level' },
  long: { worldWidth: 5000, label: 'Expanded Level' },
  huge: { worldWidth: 8000, label: 'Mega Level' }
};

/**
 * Creates a structural metadata object to detail what assets are requested
 * from the generative AI asset layer (Month 1 structural code hooks)
 */
export function createAssetGenerationRequest(promptText, themeKey) {
  const cleanPrompt = promptText.trim();
  return {
    requestId: `gen-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    prompt: cleanPrompt,
    theme: themeKey,
    stylePreset: "retro-pixel-art-8bit",
    dimensions: {
      tileWidth: 64,
      tileHeight: 64
    },
    assetManifest: [
      {
        assetId: "player_texture",
        category: "character_spritesheet",
        spec: { frames: 12, frameWidth: 32, frameHeight: 48 },
        prompt: `Pixel art character sheet of a hero matching the theme "${cleanPrompt}". Front and profile running anims, retro colors.`
      },
      {
        assetId: "enemy_texture",
        category: "enemy_spritesheet",
        spec: { frames: 8, frameWidth: 32, frameHeight: 32 },
        prompt: `Pixel art character spritesheet for a dangerous patrolling monster or creature fitting the theme "${cleanPrompt}".`
      },
      {
        assetId: "platform_texture",
        category: "tile_sprite",
        spec: { width: 64, height: 32 },
        prompt: `Pixel art tiling block for platforms and ground segments. Textures should match a "${cleanPrompt}" environment.`
      },
      {
        assetId: "sky_layer",
        category: "parallax_bg_sky",
        spec: { scrollSpeedRatio: 0.02, scaleY: 1.0 },
        prompt: `Beautiful pixel art sky and horizon panoramic view themed for "${cleanPrompt}". Seamlessly loopable landscape.`
      },
      {
        assetId: "foreground_layer",
        category: "parallax_bg_mountains",
        spec: { scrollSpeedRatio: 0.15, scaleY: 1.15 },
        prompt: `Pixel art parallax overlay detailing silhouettes and midground structures for "${cleanPrompt}". Seamlessly loopable.`
      }
    ]
  };
}

/**
 * Generates procedural layout array configurations based on prompt keywords and difficulty
 */
export function generateProceduralLayout(promptText, mode, worldWidth = 4000, difficulty = 5) {
  const lower = promptText.toLowerCase();
  const floorY = 1000; // Match LOGICAL_FLOOR_Y

  // Setup layout variables based on prompt modifiers
  let verticality = 'normal'; // normal | vertical (tower) | flat
  if (lower.match(/(tower|high|vertical|climb|mountain)/)) {
    verticality = 'vertical';
  } else if (lower.match(/(flat|straight|ground|plain)/)) {
    verticality = 'flat';
  }

  let platformDensity = 'normal'; // sparse | normal | packed
  if (lower.match(/(cluttered|packed|spooky|trap|bridge)/)) {
    platformDensity = 'packed';
  } else if (lower.match(/(sparse|empty|wide|easy)/)) {
    platformDensity = 'sparse';
  }

  const platforms = [];
  const startX = 400;
  const finishBlockX = worldWidth - 400;

  // Decide platform density settings
  let spacing = 400;
  let defaultWidthScale = 1.5;
  if (platformDensity === 'packed') {
    spacing = 280;
    defaultWidthScale = 1.0;
  } else if (platformDensity === 'sparse') {
    spacing = 550;
    defaultWidthScale = 2.0;
  }

  // Iterate X coordinate from startX to finishBlockX
  let currentX = startX;
  let lastY = floorY - 80;
  let index = 0;

  while (currentX < finishBlockX - 200) {
    let scaleX = defaultWidthScale + (Math.random() * 0.8 - 0.4);
    if (scaleX < 0.8) scaleX = 0.8;

    let targetY = floorY - 80;
    if (verticality === 'vertical') {
      // Steeper jumps upwards and downwards
      const yOffset = Math.floor(Math.random() * 160) - 80; // range [-80, +80]
      targetY = Math.max(floorY - 260, Math.min(lastY + yOffset, floorY - 40));
    } else if (verticality === 'flat') {
      targetY = floorY - 50; // flat levels have lower uniform platforms
    } else {
      // Standard layout jumps
      const yOffset = Math.floor(Math.random() * 100) - 50; // range [-50, +50]
      targetY = Math.max(floorY - 180, Math.min(lastY + yOffset, floorY - 50));
    }

    // Determine enemy spawns based on difficulty
    const hasEnemy = (index % 2 === 1) && (difficulty > 2) && (Math.random() * 10 < difficulty);

    platforms.push({
      x: Math.round(currentX),
      y: Math.round(targetY),
      scaleX: parseFloat(scaleX.toFixed(2)),
      hasEnemy: hasEnemy
    });

    lastY = targetY;
    currentX += spacing + (Math.random() * 80 - 40);
    index++;
  }

  // Always append the final Win Zone anchor platform at the end of the map
  platforms.push({
    x: finishBlockX,
    y: floorY - 150,
    scaleX: 3.0,
    hasEnemy: false
  });

  return platforms;
}

/**
 * Parses user prompts and builds a customized configuration
 */
export function parsePromptKeywords(text) {
  const lower = text.toLowerCase().trim();

  let mode = null;
  let themeKey = null;
  const modifiers = {
    isFast: false,
    isSlow: false,
    isHard: false,
    isLowGravity: false,
    highJump: false,
    lessSpeed: false,
    moreSpeed: false,
    hardcore: false,
  };
  let keywordsMatched = 0;

  // 1. Parse Mode Intent
  if (lower.match(/(action|quest|fight|platformer|enemies|shoot|kill|combat)/)) {
    mode = 'action_quest';
    keywordsMatched++;
  } else if (lower.match(/(run|dash|runner|dodge|sprint)/)) {
    mode = 'standard';
    keywordsMatched++;
  }

  // 2. Parse Theme Intent
  const themeDefs = [
    { key: 'lava', regex: /(lava|volcano|molten|inferno|ash)/ },
    { key: 'ice', regex: /(ice|snow|frost|glacier|winter)/ },
    { key: 'forest', regex: /(forest|jungle|wood|trees|verdant)/ },
    { key: 'city', regex: /(city|urban|town|building|skyscraper|street|sidewalk|neon)/ },
    { key: 'space', regex: /(space|cosmic|galaxy|nebula|planet|asteroid|star|solar|alien)/ }
  ];

  const matchedThemes = [];
  themeDefs.forEach(t => {
    const match = lower.match(t.regex);
    if (match) {
      matchedThemes.push({ key: t.key, index: match.index });
    }
  });

  matchedThemes.sort((a, b) => a.index - b.index);

  themeKey = null;
  let secondaryThemeKey = null;

  if (matchedThemes.length > 0) {
    themeKey = matchedThemes[0].key;
    keywordsMatched++;
  }
  if (matchedThemes.length > 1) {
    secondaryThemeKey = matchedThemes[1].key;
    keywordsMatched++;
  }

  // 3. Match explicit mechanics modifier keywords
  if (lower.match(/(high(er)? jump|big jump|jump higher|super jump|leap)/)) {
    modifiers.highJump = true;
    keywordsMatched++;
  }
  if (lower.match(/(less speed|slow(er)?|chill|relaxed|easy)/)) {
    modifiers.lessSpeed = true;
    modifiers.isSlow = true;
    keywordsMatched++;
  }
  if (lower.match(/(more speed|fast(er)?|speed up|quick|zoom|turbo|rapid)/)) {
    modifiers.moreSpeed = true;
    modifiers.isFast = true;
    keywordsMatched++;
  }
  if (lower.match(/(hardcore|insane|extreme|impossible|chaos|death)/)) {
    modifiers.hardcore = true;
    modifiers.isHard = true;
    keywordsMatched++;
  }
  if (lower.match(/(moon|float|space|fly|low gravity|zero gravity|weightless)/)) {
    modifiers.isLowGravity = true;
    keywordsMatched++;
  }

  // 4. Map tuning configurations dynamically using the Tuning Table
  const tuningParams = {};
  const activeLabels = [];
  Object.keys(MECHANICS_TUNING_TABLE).forEach(kw => {
    if (lower.includes(kw)) {
      Object.assign(tuningParams, MECHANICS_TUNING_TABLE[kw]);
      if (MECHANICS_TUNING_TABLE[kw].label) {
        activeLabels.push(MECHANICS_TUNING_TABLE[kw].label);
      }
      keywordsMatched++;
    }
  });

  // Calculate difficulty index
  let difficulty = 5;
  if (modifiers.isHard || modifiers.hardcore) difficulty = 8;
  if (modifiers.isSlow || modifiers.lessSpeed) difficulty = 3;

  // Resolve world width from parameters
  const worldWidth = tuningParams.worldWidth || 4000;

  // 5. Generate Procedural Level Layout Array (Foundational Layout Array)
  const resolvedMode = mode || 'standard';
  const layoutArray = resolvedMode === 'action_quest' 
    ? generateProceduralLayout(lower, resolvedMode, worldWidth, difficulty)
    : null;

  // 6. Generate AI Asset Generation Request Template (Code Hook API)
  const resolvedTheme = themeKey || 'ice';
  const assetRequest = createAssetGenerationRequest(text, resolvedTheme);

  return {
    mode,
    themeKey,
    secondaryThemeKey,
    modifiers,
    tuningParams,
    activeLabels: Array.from(new Set(activeLabels)),
    layoutArray,
    assetRequest,
    keywordsMatched
  };
}

/**
 * Generates custom title dynamically based on prompt theme and mode
 */
export function generateTitle(text, mode, themeKey) {
  const trimmed = text.trim();
  if (trimmed.length > 4 && trimmed.length < 36) {
    return trimmed
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  const themeWords = {
    lava: ['Ashfall', 'Molten', 'Cinder', 'Inferno', 'Ember', 'Scorch'],
    ice: ['Glacier', 'Frost', 'Arctic', 'Snowfall', 'Permafrost', 'Hoarfrost'],
    forest: ['Verdant', 'Wildwood', 'Grove', 'Emerald', 'Fern', 'Canopy'],
    city: ['Urban', 'Metro', 'Concrete', 'Skyline', 'Asphalt', 'Neon'],
    space: ['Stellar', 'Cosmic', 'Astral', 'Orbit', 'Nebula', 'Void'],
    default: ['Prime', 'Core', 'Nova', 'Omega', 'Apex', 'Flux'],
  };
  const modeWords =
    mode === 'action_quest'
      ? ['Quest', 'Runes', 'Raid', 'Path', 'Chronicle', 'Saga']
      : ['Run', 'Sprint', 'Rush', 'Dash', 'Circuit', 'Marathon'];

  const list = themeWords[themeKey] || themeWords.default;
  return `${list[Math.floor(Math.random() * list.length)]} ${modeWords[Math.floor(Math.random() * modeWords.length)]}`;
}
