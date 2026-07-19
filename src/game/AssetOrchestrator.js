/**
 * AssetOrchestrator - Next-generation AI orchestration system for game asset generation
 * Supports multiple AI providers with unified interface
 */

// Asset specification constants for consistent generation
export const ASSET_SPECS = {
  player: {
    width: 128,
    height: 128,
    anchor: "bottom-center",
    format: "png",
    transparent: true,
    groundAligned: true
  },
  enemy: {
    width: 96,
    height: 96,
    anchor: "bottom-center",
    format: "png",
    transparent: true,
    groundAligned: true
  },
  platform: {
    width: 256,
    height: 64,
    tileable: true,
    format: "png",
    transparent: false
  },
  obstacle: {
    width: 64,
    height: 128,
    anchor: "bottom-center",
    format: "png",
    transparent: true,
    groundAligned: true
  },
  floor: {
    width: 2048,
    height: 256,
    seamless: true,
    format: "png",
    transparent: false
  },
  backgrounds: [
    {
      layer: "far",
      width: 2048,
      height: 768,
      parallax: 0.1,
      format: "png"
    },
    {
      layer: "mid",
      width: 2048,
      height: 512,
      parallax: 0.3,
      format: "png"
    },
    {
      layer: "near",
      width: 2048,
      height: 384,
      parallax: 0.5,
      format: "png"
    }
  ]
};

// Provider configurations
const PROVIDERS = {
  GEMINI_IMAGEN: 'gemini_imagen',
  SEELE_AI: 'seele_ai',
  SPRITE_FUSION: 'sprite_fusion',
  STABLE_DIFFUSION: 'stable_diffusion',
  DALLE3: 'dalle3'
};

class AssetOrchestrator {
  constructor(config = {}) {
    this.provider = config.provider || PROVIDERS.GEMINI_IMAGEN;
    this.apiKey = config.apiKey;
    this.styleCache = new Map();
    this.promptCache = new Map();
    this.parallelGeneration = config.parallelGeneration !== false;
    this.qualityMode = config.qualityMode || 'high'; // 'low', 'medium', 'high'

    // Initialize provider-specific clients
    this.initializeProvider();
  }

  initializeProvider() {
    switch(this.provider) {
      case PROVIDERS.GEMINI_IMAGEN:
        this.client = new GeminiImagenProvider(this.apiKey);
        break;
      case PROVIDERS.SEELE_AI:
        this.client = new SeeleAIProvider(this.apiKey);
        break;
      case PROVIDERS.SPRITE_FUSION:
        this.client = new SpriteFusionProvider(this.apiKey);
        break;
      case PROVIDERS.STABLE_DIFFUSION:
        this.client = new StableDiffusionProvider(this.apiKey);
        break;
      case PROVIDERS.DALLE3:
        this.client = new DallE3Provider(this.apiKey);
        break;
      default:
        throw new Error(`Unknown provider: ${this.provider}`);
    }
  }

  /**
   * Main entry point for game generation
   */
  async generateGame(prompt, options = {}) {
    try {
      console.log(`🎮 Starting game generation with ${this.provider}`);

      // Step 1: Generate game configuration using Gemini
      const gameConfig = await this.generateGameConfig(prompt);

      // Step 2: Create unified style guide
      const styleGuide = await this.generateStyleGuide(gameConfig);

      // Step 3: Generate all assets (parallel or sequential based on config)
      const assets = await this.generateAssets(gameConfig, styleGuide, options);

      // Step 4: Post-process assets for consistency
      const processedAssets = await this.postProcessAssets(assets);

      return {
        gameConfig,
        styleGuide,
        assets: processedAssets,
        metadata: {
          provider: this.provider,
          generationTime: Date.now(),
          qualityMode: this.qualityMode
        }
      };
    } catch (error) {
      console.error('Asset generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate game configuration using Gemini orchestrator
   */
  async generateGameConfig(prompt) {
    // Use existing Gemini service for game logic generation
    const geminiService = await import('./geminiService.js');
    const config = await geminiService.orchestrateAIGeneration(prompt);
    return config;
  }

  /**
   * Generate unified style guide for visual consistency
   */
  async generateStyleGuide(gameConfig) {
    const cacheKey = `style_${gameConfig.themeKey}_${this.qualityMode}`;

    if (this.styleCache.has(cacheKey)) {
      return this.styleCache.get(cacheKey);
    }

    const styleGuide = {
      artStyle: this.determineArtStyle(gameConfig),
      colorPalette: this.extractColorPalette(gameConfig),
      lightingDirection: 'top-right',
      perspective: 'side-view-2d',
      characterOrientation: 'facing-right',
      groundLevel: 'bottom-aligned',
      consistencyRules: {
        outlineWidth: 2,
        shadowOpacity: 0.3,
        antiAliasing: this.qualityMode === 'high',
        pixelPerfect: true
      }
    };

    this.styleCache.set(cacheKey, styleGuide);
    return styleGuide;
  }

  /**
   * Determine art style based on theme and quality mode
   */
  determineArtStyle(gameConfig) {
    const themeStyles = {
      'ice': 'crystalline-pixel-art',
      'lava': 'volcanic-glow-art',
      'forest': 'organic-pixel-art',
      'space': 'neon-retro-art',
      'desert': 'sun-baked-pixel-art',
      'underwater': 'bioluminescent-art',
      'cyberpunk': 'neon-tech-art',
      'fantasy': 'magical-painted-art'
    };

    return themeStyles[gameConfig.themeKey] || 'classic-pixel-art';
  }

  /**
   * Extract color palette from game configuration
   */
  extractColorPalette(gameConfig) {
    const themePalettes = {
      'ice': ['#E6F3FF', '#B3D9FF', '#4D94FF', '#1A5ECC', '#0D2E66'],
      'lava': ['#FF6B35', '#FF4500', '#DC143C', '#8B0000', '#4B0000'],
      'forest': ['#228B22', '#32CD32', '#90EE90', '#8FBC8F', '#2F4F2F'],
      'space': ['#000033', '#191970', '#4B0082', '#9400D3', '#DDA0DD'],
      'desert': ['#F4A460', '#DEB887', '#D2691E', '#8B4513', '#654321'],
      'underwater': ['#006994', '#00CED1', '#48D1CC', '#40E0D0', '#7FFFD4'],
      'cyberpunk': ['#FF00FF', '#00FFFF', '#FF1493', '#00FF00', '#1E90FF'],
      'fantasy': ['#9370DB', '#8A2BE2', '#DA70D6', '#BA55D3', '#9932CC']
    };

    return themePalettes[gameConfig.themeKey] || themePalettes['forest'];
  }

  /**
   * Generate all game assets
   */
  async generateAssets(gameConfig, styleGuide, options) {
    const assetPrompts = this.createAssetPrompts(gameConfig, styleGuide);

    if (this.parallelGeneration) {
      // Generate background first for context, then everything else in parallel
      const backgroundAssets = await this.generateBackgrounds(assetPrompts.backgrounds, styleGuide);

      const [player, enemies, platforms, obstacles, floor] = await Promise.all([
        this.generateCharacter(assetPrompts.player, styleGuide, 'player'),
        this.generateCharacter(assetPrompts.enemy, styleGuide, 'enemy'),
        this.generatePlatform(assetPrompts.platform, styleGuide),
        this.generateObstacle(assetPrompts.obstacle, styleGuide),
        this.generateFloor(assetPrompts.floor, styleGuide)
      ]);

      return {
        backgrounds: backgroundAssets,
        player,
        enemies,
        platforms,
        obstacles,
        floor
      };
    } else {
      // Sequential generation for providers that require it
      const backgroundAssets = await this.generateBackgrounds(assetPrompts.backgrounds, styleGuide);
      const floor = await this.generateFloor(assetPrompts.floor, styleGuide);
      const platforms = await this.generatePlatform(assetPrompts.platform, styleGuide);
      const player = await this.generateCharacter(assetPrompts.player, styleGuide, 'player');
      const enemies = await this.generateCharacter(assetPrompts.enemy, styleGuide, 'enemy');
      const obstacles = await this.generateObstacle(assetPrompts.obstacle, styleGuide);

      return {
        backgrounds: backgroundAssets,
        player,
        enemies,
        platforms,
        obstacles,
        floor
      };
    }
  }

  /**
   * Create optimized prompts for each asset type
   */
  createAssetPrompts(gameConfig, styleGuide) {
    const theme = gameConfig.assetDesignDirections || {};
    const style = styleGuide.artStyle;
    const palette = styleGuide.colorPalette.join(', ');

    return {
      backgrounds: {
        far: `${style}, distant ${theme.backgrounds || 'landscape'}, parallax layer, colors: ${palette}, atmospheric perspective, no ground`,
        mid: `${style}, middle distance ${theme.backgrounds || 'landscape'}, parallax layer, colors: ${palette}, medium detail, no ground`,
        near: `${style}, foreground ${theme.backgrounds || 'landscape'} elements, parallax layer, colors: ${palette}, high detail, no ground`
      },
      player: `${style}, ${theme.characters || 'hero character'}, facing right, full body, standing pose, bottom-aligned, transparent background, colors: ${palette}`,
      enemy: `${style}, ${theme.characters || 'enemy character'}, facing right, full body, idle pose, bottom-aligned, transparent background, colors: ${palette}`,
      platform: `${style}, ${theme.levelElements || 'platform'}, tileable texture, seamless edges, top surface visible, colors: ${palette}`,
      obstacle: `${style}, ${theme.hazards || 'obstacle'}, vertical orientation, bottom-aligned, transparent background, colors: ${palette}`,
      floor: `${style}, continuous ground texture, ${theme.levelElements || 'ground'}, seamless horizontal tiling, detailed surface, colors: ${palette}`
    };
  }

  /**
   * Generate background layers with parallax support
   */
  async generateBackgrounds(prompts, styleGuide) {
    const backgrounds = {};

    for (const spec of ASSET_SPECS.backgrounds) {
      const prompt = prompts[spec.layer];
      backgrounds[spec.layer] = await this.client.generateImage({
        prompt,
        width: spec.width,
        height: spec.height,
        format: spec.format,
        styleGuide
      });
    }

    return backgrounds;
  }

  /**
   * Generate character sprites with ground alignment
   */
  async generateCharacter(prompt, styleGuide, type) {
    const spec = ASSET_SPECS[type];

    return await this.client.generateImage({
      prompt,
      width: spec.width,
      height: spec.height,
      format: spec.format,
      transparent: spec.transparent,
      groundAligned: spec.groundAligned,
      anchor: spec.anchor,
      styleGuide
    });
  }

  /**
   * Generate platform tiles
   */
  async generatePlatform(prompt, styleGuide) {
    const spec = ASSET_SPECS.platform;

    return await this.client.generateImage({
      prompt,
      width: spec.width,
      height: spec.height,
      format: spec.format,
      tileable: spec.tileable,
      styleGuide
    });
  }

  /**
   * Generate obstacles
   */
  async generateObstacle(prompt, styleGuide) {
    const spec = ASSET_SPECS.obstacle;

    return await this.client.generateImage({
      prompt,
      width: spec.width,
      height: spec.height,
      format: spec.format,
      transparent: spec.transparent,
      groundAligned: spec.groundAligned,
      anchor: spec.anchor,
      styleGuide
    });
  }

  /**
   * Generate continuous floor texture
   */
  async generateFloor(prompt, styleGuide) {
    const spec = ASSET_SPECS.floor;

    return await this.client.generateImage({
      prompt,
      width: spec.width,
      height: spec.height,
      format: spec.format,
      seamless: spec.seamless,
      styleGuide
    });
  }

  /**
   * Post-process assets for consistency
   */
  async postProcessAssets(assets) {
    // Apply any necessary post-processing
    // This is where we'd handle alignment, sizing, etc.
    // For now, return assets as-is since modern APIs handle this
    return assets;
  }
}

/**
 * Provider implementations
 */

class GeminiImagenProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async generateImage(params) {
    // Implementation for Google Gemini + Imagen
    const { prompt, width, height, format, transparent } = params;

    // Construct Imagen API call
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${this.apiKey}`;

    const aspectRatio = width > height ? '16:9' : '1:1';

    const response = await fetch(imagenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
          personGeneration: 'ALLOW_ADULT'
        }
      })
    });

    const resJson = await response.json();
    const base64Data = resJson?.predictions?.[0]?.bytesBase64Encoded;

    if (!base64Data) {
      throw new Error('Failed to generate image');
    }

    return {
      data: base64Data,
      format: 'base64',
      mimeType: resJson?.predictions?.[0]?.mimeType || 'image/png'
    };
  }
}

class SeeleAIProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    // Use proxy for local development to avoid CORS
    this.baseUrl = import.meta.env.VITE_SEELE_PROXY_URL || 'http://localhost:3001/api' || 'https://openapi.seeles.ai';
  }

  async generateImage(params) {
    const { prompt, width, height, transparent, groundAligned, anchor } = params;

    if (!this.apiKey) {
      throw new Error('SEELE API key not configured. Set VITE_SEELE_API_KEY in .env');
    }

    try {
      // Step 1: Create job
      const jobResponse = await fetch(`${this.baseUrl}/v2/api/jobs`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: prompt,
          model: 'Seele02-flash', // Fast model
          engine: 'unity' // Game engine optimization
        })
      });

      const jobResult = await jobResponse.json();

      if (!jobResult.ok) {
        const errorMsg = jobResult.error?.message || 'Job creation failed';
        if (errorMsg.includes('credit') || errorMsg.includes('koin') || errorMsg.includes('balance')) {
          throw new Error('SEELE API: Insufficient credits. Please add Koin credits to your account at seeles.ai');
        }
        throw new Error(`SEELE API error: ${errorMsg}`);
      }

      const jobId = jobResult.data.job_id;
      console.log(`SEELE job created: ${jobId}`);

      // Step 2: Poll for completion
      let attempts = 0;
      const maxAttempts = 60; // 10 minutes max
      let jobData;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

        const statusResponse = await fetch(`${this.baseUrl}/v2/api/jobs/${jobId}`, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`
          }
        });

        const statusResult = await statusResponse.json();

        if (!statusResult.ok) {
          throw new Error('Failed to check job status');
        }

        jobData = statusResult.data;
        console.log(`SEELE job status: ${jobData.status}`);

        if (jobData.status === 'finished') {
          break;
        }

        attempts++;
      }

      if (jobData.status !== 'finished') {
        throw new Error('SEELE job timeout');
      }

      // Step 3: Get artifact URLs
      if (!jobData.artifacts || jobData.artifacts.length === 0) {
        throw new Error('SEELE: No artifacts generated. You may need Standard tier or higher for downloads.');
      }

      const artifact = jobData.artifacts[0];

      if (!artifact.urls || artifact.urls.length === 0) {
        throw new Error('SEELE: No download URLs available. Upgrade to Standard tier or higher at seeles.ai');
      }

      // Return the first URL
      return {
        data: artifact.urls[0],
        format: 'url',
        mimeType: 'image/png',
        metadata: {
          width: width,
          height: height,
          transparent: transparent,
          credits_used: jobData.total_koin
        }
      };

    } catch (error) {
      console.error('SEELE API generation failed:', error);
      throw error;
    }
  }
}

class SpriteFusionProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.spritefusion.com/v1';
  }

  async generateImage(params) {
    const { prompt, width, height, transparent, tileable } = params;

    const response = await fetch(`${this.baseUrl}/sprite`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        dimensions: { width, height },
        transparent,
        tileable,
        export_format: 'png'
      })
    });

    const data = await response.json();
    return {
      data: data.sprite_url,
      format: 'url',
      metadata: data.metadata
    };
  }
}

class StableDiffusionProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.stability.ai/v1';
  }

  async generateImage(params) {
    const { prompt, width, height, styleGuide } = params;

    const response = await fetch(`${this.baseUrl}/generation/stable-diffusion-xl-1024-v1-0/text-to-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt }],
        cfg_scale: 7,
        height,
        width,
        samples: 1,
        steps: 30,
        style_preset: 'pixel-art'
      })
    });

    const data = await response.json();
    return {
      data: data.artifacts[0].base64,
      format: 'base64',
      mimeType: 'image/png'
    };
  }
}

class DallE3Provider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  async generateImage(params) {
    const { prompt, width, height } = params;

    // DALL-E 3 only supports specific sizes
    const size = width >= 1024 ? '1024x1024' : '512x512';

    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size,
        quality: 'hd',
        response_format: 'b64_json'
      })
    });

    const data = await response.json();
    return {
      data: data.data[0].b64_json,
      format: 'base64',
      mimeType: 'image/png'
    };
  }
}

export { AssetOrchestrator, PROVIDERS };