import { parsePromptKeywords, generateTitle, generateProceduralLayout, MECHANICS_TUNING_TABLE } from './promptUtils';

/**
 * PlayMint Local Generation Service
 * Generates game configurations locally without any API calls
 * Uses deterministic algorithms and templates for instant generation
 */

/**
 * Generate game configuration locally without API calls
 * @param {string} promptText - User prompt text
 * @param {Function} onProgress - Progress callback
 * @returns {Object} Game configuration object
 */
export async function generateGameConfig(promptText, onProgress = () => {}) {
  try {
    onProgress('[SYSTEM] Initializing local game generation...', 10);

    // Parse the prompt to extract keywords and modifiers
    const parsed = parsePromptKeywords(promptText);
    onProgress('[SYSTEM] Analyzing prompt keywords and modifiers...', 20);

    // Determine game mode
    const gameType = parsed.mode === 'action_quest' ? 'platformer' : 'runner';

    // Determine theme (default to ice if none found)
    const theme = parsed.themeKey || 'ice';
    const secondaryTheme = parsed.secondaryThemeKey || theme;

    // Generate game name
    const gameName = generateTitle(promptText, parsed.mode || 'standard', theme);
    onProgress(`[SYSTEM] Generated game: "${gameName}"...`, 30);

    // Set difficulty based on modifiers
    let difficulty = 5;
    if (parsed.modifiers.isHard || parsed.modifiers.hardcore) {
      difficulty = 8;
    } else if (parsed.modifiers.isSlow || parsed.modifiers.lessSpeed) {
      difficulty = 3;
    }

    // Set physics parameters with defaults
    let runSpeed = 400;
    let jumpForce = 700;
    let gravity = 1600;
    let obstacleDelay = 1200;
    let actionJumpHeight = 600;
    let actionGravity = 1400;
    let actionEnemyCount = 5;
    let actionProjectileEnabled = false;
    let worldWidth = 4000;

    // Apply tuning parameters from table
    if (parsed.tuningParams.runSpeed) runSpeed = parsed.tuningParams.runSpeed;
    if (parsed.tuningParams.jumpForce) jumpForce = parsed.tuningParams.jumpForce;
    if (parsed.tuningParams.gravity) gravity = parsed.tuningParams.gravity;
    if (parsed.tuningParams.obstacleDelay) obstacleDelay = parsed.tuningParams.obstacleDelay;
    if (parsed.tuningParams.actionJumpHeight) actionJumpHeight = parsed.tuningParams.actionJumpHeight;
    if (parsed.tuningParams.actionGravity) actionGravity = parsed.tuningParams.actionGravity;
    if (parsed.tuningParams.actionEnemyCount) actionEnemyCount = parsed.tuningParams.actionEnemyCount;
    if (parsed.tuningParams.actionProjectileEnabled) actionProjectileEnabled = parsed.tuningParams.actionProjectileEnabled;
    if (parsed.tuningParams.worldWidth) worldWidth = parsed.tuningParams.worldWidth;

    // Apply individual modifiers
    if (parsed.modifiers.isFast || parsed.modifiers.moreSpeed) {
      runSpeed = Math.min(runSpeed * 1.3, 800);
    }
    if (parsed.modifiers.isSlow || parsed.modifiers.lessSpeed) {
      runSpeed = Math.max(runSpeed * 0.7, 200);
    }
    if (parsed.modifiers.highJump) {
      jumpForce = Math.min(jumpForce * 1.3, 1000);
      actionJumpHeight = Math.min(actionJumpHeight * 1.3, 900);
    }
    if (parsed.modifiers.isLowGravity) {
      gravity = Math.max(gravity * 0.6, 800);
      actionGravity = Math.max(actionGravity * 0.6, 600);
      jumpForce = Math.min(jumpForce * 1.1, 900);
    }
    if (parsed.modifiers.hardcore) {
      difficulty = 10;
      runSpeed = Math.min(runSpeed * 1.5, 800);
      obstacleDelay = Math.max(obstacleDelay * 0.6, 600);
      actionEnemyCount = Math.min(actionEnemyCount * 2, 15);
    }

    onProgress('[SYSTEM] Configured physics and gameplay parameters...', 40);

    // Generate procedural layout for platformer mode
    let layoutArray = [];
    if (gameType === 'platformer') {
      layoutArray = generateProceduralLayout(promptText, 'action_quest', worldWidth, difficulty);
      onProgress('[SYSTEM] Generated procedural level layout...', 50);
    } else {
      // For runner mode, create a simple layout
      layoutArray = [
        { x: 400, y: 900, scaleX: 1.5, hasEnemy: false },
        { x: 800, y: 850, scaleX: 1.2, hasEnemy: false },
        { x: 1200, y: 900, scaleX: 1.8, hasEnemy: difficulty > 3 },
        { x: 1600, y: 820, scaleX: 1.3, hasEnemy: false },
        { x: 2000, y: 880, scaleX: 1.5, hasEnemy: difficulty > 5 },
        { x: 2400, y: 850, scaleX: 1.4, hasEnemy: false },
        { x: 2800, y: 900, scaleX: 1.6, hasEnemy: difficulty > 7 },
        { x: 3200, y: 840, scaleX: 1.5, hasEnemy: false },
        { x: 3600, y: 850, scaleX: 3.0, hasEnemy: false }
      ];
    }

    onProgress('[SYSTEM] Creating asset design templates...', 60);

    // Create asset design directions based on theme
    const assetDesignDirections = generateAssetDirections(theme, secondaryTheme, promptText, gameType);

    onProgress('[SYSTEM] Compiling asset generation prompts...', 70);

    // Create merged assets object for URL compilation
    const mergedAssets = {
      background_far: assetDesignDirections.backgrounds,
      floor: assetDesignDirections.levelElements,
      platform: assetDesignDirections.platforms,
      player: assetDesignDirections.player,
      enemy: assetDesignDirections.enemy,
      obstacle: assetDesignDirections.hazards,
      styleGuide: assetDesignDirections.styleGuide,
      colorPalette: assetDesignDirections.colorPalette,
      seed: Math.floor(Math.random() * 1000000)
    };

    onProgress('[SYSTEM] Generating asset URLs...', 80);

    // Compile the final configuration
    const config = {
      gameType,
      gameName,
      difficulty,
      runSpeed,
      jumpForce,
      gravity,
      obstacleDelay,
      actionJumpHeight,
      actionGravity,
      actionEnemyCount,
      actionProjectileEnabled,
      layoutArray,
      dynamicAssetUrls: compileAssetUrls(mergedAssets),
      assetDesignDirections // Include for debugging
    };

    onProgress('[SYSTEM] Local generation complete!', 90);

    console.log('[Local Generation] Final config:', config);

    return {
      success: true,
      config,
      logs: [`Generated locally: ${gameName} (${theme} theme, difficulty ${difficulty})`]
    };

  } catch (error) {
    console.error('[Local Generation Error]:', error);
    throw error;
  }
}

/**
 * Generate asset design directions based on theme
 */
function generateAssetDirections(theme, secondaryTheme, promptText, gameType) {
  // Theme-specific asset descriptions
  const themes = {
    ice: {
      backgrounds: 'frozen tundra with icy mountains, snow-covered peaks, glaciers, aurora borealis sky, crystalline ice formations',
      levelElements: 'frozen ground with snow texture, icy surface, frost patterns',
      platforms: 'ice platform block, frozen ledge, crystalline structure',
      player: gameType === 'platformer'
        ? 'arctic warrior with fur coat, ice sword, blue armor'
        : 'winter athlete runner, cold weather gear, athletic build',
      enemy: 'ice golem monster, frozen yeti creature, frost elemental',
      hazards: 'ice spikes, frozen stalactites, sharp icicles',
      colorPalette: 'cool blues, whites, cyans, pale purples, ice blue (#E6F3FF, #B3D9FF, #4D94FF)',
      atmosphere: 'cold, crystalline, shimmering'
    },
    lava: {
      backgrounds: 'volcanic landscape with lava flows, molten rock, ash clouds, red sky, erupting volcanos',
      levelElements: 'volcanic rock ground, obsidian surface, cracked magma texture',
      platforms: 'volcanic rock platform, obsidian ledge, basalt block',
      player: gameType === 'platformer'
        ? 'fire knight with flaming sword, heat-resistant armor'
        : 'heat runner with protective suit, athletic stance',
      enemy: 'lava golem, fire demon, magma elemental creature',
      hazards: 'lava pit, fire geyser, molten rock spike',
      colorPalette: 'reds, oranges, dark grays, yellow highlights (#FF6B35, #FF4500, #DC143C, #8B0000)',
      atmosphere: 'hot, glowing, dangerous'
    },
    forest: {
      backgrounds: 'dense forest with tall trees, canopy layers, sunlight filtering through leaves, moss and vines',
      levelElements: 'grass and dirt ground, forest floor with leaves, natural earth texture',
      platforms: 'wooden log platform, tree branch, moss-covered stone',
      player: gameType === 'platformer'
        ? 'forest ranger with bow and arrow, green cloak'
        : 'nature runner, athletic explorer, green outfit',
      enemy: 'forest wolf, giant spider, evil tree creature',
      hazards: 'thorn bush, poison plant, falling branch',
      colorPalette: 'greens, browns, earth tones (#228B22, #32CD32, #8FBC8F, #654321)',
      atmosphere: 'natural, organic, mysterious'
    },
    city: {
      backgrounds: 'urban cityscape with skyscrapers, neon signs, busy streets, night skyline, modern buildings',
      levelElements: 'concrete sidewalk, asphalt road, urban ground texture',
      platforms: 'metal scaffold, concrete ledge, building rooftop',
      player: gameType === 'platformer'
        ? 'urban ninja with tech gear, cyberpunk outfit'
        : 'parkour runner, urban athlete, street clothes',
      enemy: 'security robot, street thug, drone enemy',
      hazards: 'electrical barrier, steam vent, construction hazard',
      colorPalette: 'grays, neon colors, blues, purples (#696969, #FF00FF, #00FFFF, #1E90FF)',
      atmosphere: 'urban, modern, neon-lit'
    },
    space: {
      backgrounds: 'cosmic space with stars, nebulas, distant planets, asteroid fields, galaxy backdrop',
      levelElements: 'metallic space station floor, alien ground surface, lunar terrain',
      platforms: 'floating space platform, asteroid chunk, metal beam',
      player: gameType === 'platformer'
        ? 'space marine with laser rifle, powered armor'
        : 'astronaut runner, space suit, jetpack',
      enemy: 'alien creature, space pirate, robot sentinel',
      hazards: 'laser barrier, meteor, energy field',
      colorPalette: 'deep purples, blues, pinks, cosmic colors (#000033, #4B0082, #9400D3, #DDA0DD)',
      atmosphere: 'cosmic, futuristic, otherworldly'
    }
  };

  // Get theme data or use forest as default
  const themeData = themes[theme] || themes.forest;

  // Mix in secondary theme if present
  let finalData = { ...themeData };
  if (secondaryTheme && secondaryTheme !== theme && themes[secondaryTheme]) {
    const secondaryData = themes[secondaryTheme];
    // Blend some elements
    finalData.backgrounds = `${themeData.backgrounds}, with elements of ${secondaryData.atmosphere} atmosphere`;
    finalData.colorPalette = `${themeData.colorPalette}, accented with ${secondaryData.colorPalette}`;
  }

  // Add any custom elements from prompt
  const customElements = extractCustomElements(promptText);
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
    styleGuide: '16-bit pixel art style, retro game aesthetic, clear pixel definition, vibrant colors, side-view perspective',
    colorPalette: finalData.colorPalette
  };
}

/**
 * Extract custom elements from prompt text
 */
function extractCustomElements(promptText) {
  const lower = promptText.toLowerCase();
  const customElements = [];

  // Look for specific descriptive words
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
 * Map text prompts to Pollinations AI URLs
 * (Keeping this for compatibility with image generation)
 */
export function compileAssetUrls(assets) {
  const safeGet = (val, fallback) => (val && typeof val === 'string' && val.trim() ? val : fallback);
  const cleanPrompt = (text) => {
    let cleaned = text.trim().toLowerCase();
    // Sanitize adblock-triggering words to prevent request blocks in the browser
    cleaned = cleaned.replace(/\bobstacle\b/g, 'barrier');
    cleaned = cleaned.replace(/\bhazard\b/g, 'danger');
    cleaned = cleaned.replace(/\badvert\b/g, 'promo');
    return encodeURIComponent(cleaned);
  };

  const styleGuide = safeGet(assets?.styleGuide, 'retro aesthetic');
  const colorPalette = safeGet(assets?.colorPalette, 'standard arcade colors');
  const globalStyle = `${styleGuide}, using color palette ${colorPalette}, 16-bit pixel art style, perfectly flat 2D game asset, sharp pixels, clear outlines`;

  // Read Pollinations Key if set to authorize requests at the URL level
  const polliKey = import.meta.env.VITE_POLLINATIONS_API_KEY || localStorage.getItem('POLLINATIONS_API_KEY') || '';
  const authSuffix = polliKey.trim() ? `&key=${polliKey.trim()}` : '';

  const finalFar = safeGet(assets?.background_far, 'scenery landscape background backdrop');
  const finalFloor = safeGet(assets?.floor, 'ground surface tiling block texture');
  const finalPlatform = safeGet(assets?.platform, 'floating platform ledge block tile');
  const finalPlayer = safeGet(assets?.player, 'running character sprite');
  const finalEnemy = safeGet(assets?.enemy, 'patrolling enemy monster creature');
  const finalObstacle = safeGet(assets?.obstacle, 'danger barrier block or spike');

  const seed = assets?.seed || Math.floor(Math.random() * 1000000);

  const urls = {
    background_far: `https://image.pollinations.ai/prompt/${cleanPrompt(finalFar + ', detailed scenery landscape background, ' + globalStyle)}?width=1024&height=512&nologo=true&seed=${seed}${authSuffix}`,
    floor: `https://image.pollinations.ai/prompt/${cleanPrompt(finalFloor + ', solid seamless tiling floor block, filling full height, side view game texture, ' + globalStyle)}?width=128&height=128&nologo=true&seed=${seed}${authSuffix}`,
    platform: `https://image.pollinations.ai/prompt/${cleanPrompt(finalPlatform + ', flat floating platform ledge block tile, isolated on a solid flat white background, ' + globalStyle)}?width=128&height=64&nologo=true&seed=${seed}${authSuffix}`,
    player: `https://image.pollinations.ai/prompt/${cleanPrompt(finalPlayer + ', facing right, side profile view character sprite, isolated on a solid flat white background, ' + globalStyle)}?width=128&height=128&nologo=true&seed=${seed}${authSuffix}`,
    enemy: `https://image.pollinations.ai/prompt/${cleanPrompt(finalEnemy + ', side view patrolling monster game asset, isolated on a solid flat white background, ' + globalStyle)}?width=128&height=128&nologo=true&seed=${seed}${authSuffix}`,
    obstacle: `https://image.pollinations.ai/prompt/${cleanPrompt(finalObstacle + ', barrier danger, isolated on a solid flat white background, ' + globalStyle)}?width=128&height=128&nologo=true&seed=${seed}${authSuffix}`
  };

  console.log('[Local Generation URLs] Compiled asset urls:', urls);
  return urls;
}

/**
 * Legacy function for backward compatibility
 */
export async function orchestrateAIGeneration(promptText) {
  console.log('[Legacy] orchestrateAIGeneration called, redirecting to generateGameConfig');
  const result = await generateGameConfig(promptText);
  return result.config;
}