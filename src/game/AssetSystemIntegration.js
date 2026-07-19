/**
 * AssetSystemIntegration - Integrates new AI orchestration with existing game
 * Provides compatibility layer and migration path
 */

import { AssetOrchestrator, PROVIDERS, ASSET_SPECS } from './AssetOrchestrator.js';
import ParallaxGroundSystem from './ParallaxGroundSystem.js';
import SpriteAlignmentManager from './SpriteAlignmentManager.js';
import TokenOptimizer from './TokenOptimizer.js';

export class AssetSystemIntegration {
  constructor(config = {}) {
    // Configuration
    this.config = {
      provider: config.provider || PROVIDERS.GEMINI_IMAGEN,
      enableNewSystem: config.enableNewSystem !== false,
      enableParallax: config.enableParallax !== false,
      enableAlignment: config.enableAlignment !== false,
      enableOptimization: config.enableOptimization !== false,
      migrationMode: config.migrationMode || 'gradual', // 'gradual' or 'immediate'
      debugMode: config.debugMode || false
    };

    // Initialize subsystems
    this.orchestrator = null;
    this.parallaxSystem = null;
    this.alignmentManager = null;
    this.tokenOptimizer = null;

    // Stats tracking
    this.stats = {
      generationsCompleted: 0,
      failedGenerations: 0,
      averageGenerationTime: 0,
      totalTokensSaved: 0
    };
  }

  /**
   * Initialize all subsystems
   */
  async initialize(scene, apiKey) {
    this.scene = scene;

    // Initialize Asset Orchestrator
    if (this.config.enableNewSystem) {
      this.orchestrator = new AssetOrchestrator({
        provider: this.config.provider,
        apiKey: apiKey || this.getApiKey(),
        parallelGeneration: true,
        qualityMode: 'high'
      });
    }

    // Initialize Token Optimizer
    if (this.config.enableOptimization) {
      this.tokenOptimizer = new TokenOptimizer({
        enableCaching: true,
        enableCompression: true,
        enableBatching: true
      });
    }

    // Initialize Parallax System
    if (this.config.enableParallax && scene) {
      this.parallaxSystem = new ParallaxGroundSystem(scene);
    }

    // Initialize Alignment Manager
    if (this.config.enableAlignment && scene) {
      this.alignmentManager = new SpriteAlignmentManager(scene);
      this.alignmentManager.setDebugMode(this.config.debugMode);
    }

    console.log('🎮 Asset System Integration initialized', this.config);
    return this;
  }

  /**
   * Get API key from environment or localStorage based on provider
   */
  getApiKey() {
    // SEELE AI
    if (this.config.provider === PROVIDERS.SEELE_AI) {
      return import.meta.env.VITE_SEELE_API_KEY ||
             localStorage.getItem('SEELE_API_KEY');
    }

    // Google Gemini (default)
    if (this.config.provider === PROVIDERS.GEMINI_IMAGEN) {
      return import.meta.env.VITE_GEMINI_API_KEY ||
             localStorage.getItem('GEMINI_API_KEY') ||
             localStorage.getItem('API_KEY');
    }

    // OpenAI/DALL-E
    if (this.config.provider === PROVIDERS.DALLE3) {
      return import.meta.env.VITE_OPENAI_API_KEY ||
             localStorage.getItem('OPENAI_API_KEY');
    }

    // Stability AI
    if (this.config.provider === PROVIDERS.STABLE_DIFFUSION) {
      return import.meta.env.VITE_STABILITY_API_KEY ||
             localStorage.getItem('STABILITY_API_KEY');
    }

    // Fallback
    return import.meta.env.VITE_API_KEY ||
           localStorage.getItem('API_KEY');
  }

  /**
   * Main entry point - replaces existing generation flow
   */
  async generateGameAssets(prompt, options = {}) {
    const startTime = Date.now();

    try {
      let result;

      if (this.config.enableNewSystem) {
        // Use new orchestration system
        result = await this.generateWithNewSystem(prompt, options);
      } else {
        // Fallback to legacy system
        result = await this.generateWithLegacySystem(prompt, options);
      }

      // Update statistics
      const generationTime = Date.now() - startTime;
      this.updateStats(true, generationTime);

      return result;
    } catch (error) {
      console.error('Asset generation failed:', error);
      this.updateStats(false);

      // Fallback strategy
      if (this.config.enableNewSystem && options.allowFallback !== false) {
        console.log('Attempting fallback to legacy system...');
        return await this.generateWithLegacySystem(prompt, options);
      }

      throw error;
    }
  }

  /**
   * Generate using new orchestration system
   */
  async generateWithNewSystem(prompt, options) {
    console.log('🚀 Using new AI orchestration system');

    // Optimize prompt if token optimizer is enabled
    let optimizedPrompt = prompt;
    let cacheKey = null;

    if (this.tokenOptimizer) {
      const optimization = this.tokenOptimizer.optimizePrompt(prompt, options.context || {});

      if (optimization.cached) {
        console.log(`✅ Cache hit! Saved ${optimization.tokensSaved} tokens`);
        return optimization.response;
      }

      optimizedPrompt = optimization.prompt;
      cacheKey = optimization.cacheKey;
      this.stats.totalTokensSaved += optimization.tokensSaved;
    }

    // Generate assets using orchestrator
    const result = await this.orchestrator.generateGame(optimizedPrompt, options);

    // Cache the result
    if (this.tokenOptimizer && cacheKey) {
      this.tokenOptimizer.cacheResponse(cacheKey, result);
    }

    // Process generated assets
    const processedAssets = await this.processGeneratedAssets(result.assets);

    // Apply to scene if available
    if (this.scene) {
      await this.applyAssetsToScene(processedAssets, result.gameConfig);
    }

    return {
      ...result,
      assets: processedAssets,
      stats: {
        generationTime: Date.now() - Date.now(),
        tokensSaved: this.stats.totalTokensSaved
      }
    };
  }

  /**
   * Generate using legacy system (backward compatibility)
   */
  async generateWithLegacySystem(prompt, options) {
    console.log('Using legacy generation system');

    // Import legacy gemini service
    const geminiService = await import('./geminiService.js');

    // Use existing orchestration
    const result = await geminiService.orchestrateAIGeneration(prompt);

    // Convert to new format
    return this.convertLegacyResult(result);
  }

  /**
   * Process generated assets with new systems
   */
  async processGeneratedAssets(assets) {
    const processed = { ...assets };

    // Convert base64 to image elements if needed
    for (const key in processed) {
      const asset = processed[key];

      if (asset && asset.format === 'base64') {
        processed[key] = await this.base64ToImage(asset.data, asset.mimeType);
      } else if (asset && asset.format === 'url') {
        processed[key] = await this.urlToImage(asset.data);
      }
    }

    return processed;
  }

  /**
   * Apply assets to the game scene
   */
  async applyAssetsToScene(assets, gameConfig) {
    if (!this.scene) return;

    // Apply parallax backgrounds
    if (this.parallaxSystem && assets.backgrounds) {
      this.parallaxSystem.initialize(assets, {
        continuous: true,
        decorations: true
      });
    }

    // Apply sprites with alignment
    if (this.alignmentManager) {
      // Player sprite
      if (assets.player && this.scene.player) {
        this.alignmentManager.initializeSprite(this.scene.player, {
          type: 'character',
          groundY: this.scene.LOGICAL_FLOOR_Y,
          facing: 'right',
          anchor: 'bottom-center'
        });
      }

      // Enemy sprites
      if (assets.enemies && this.scene.enemies) {
        this.scene.enemies.children.entries.forEach(enemy => {
          this.alignmentManager.initializeSprite(enemy, {
            type: 'enemy',
            groundY: enemy.y,
            facing: enemy.body.velocity.x > 0 ? 'right' : 'left',
            anchor: 'bottom-center'
          });
        });
      }
    }
  }

  /**
   * Convert legacy result to new format
   */
  convertLegacyResult(legacyResult) {
    return {
      gameConfig: legacyResult,
      styleGuide: {
        artStyle: legacyResult.assetDesignDirections?.styleGuide || 'pixel-art',
        colorPalette: legacyResult.assetDesignDirections?.colorPalette || []
      },
      assets: {
        backgrounds: {
          far: legacyResult.dynamicAssetUrls?.background_far,
          mid: null,
          near: null
        },
        player: legacyResult.dynamicAssetUrls?.player,
        enemies: legacyResult.dynamicAssetUrls?.enemy,
        platforms: legacyResult.dynamicAssetUrls?.platform,
        obstacles: legacyResult.dynamicAssetUrls?.obstacle,
        floor: legacyResult.dynamicAssetUrls?.floor
      }
    };
  }

  /**
   * Convert base64 to image element
   */
  async base64ToImage(base64Data, mimeType = 'image/png') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `data:${mimeType};base64,${base64Data}`;
    });
  }

  /**
   * Load image from URL
   */
  async urlToImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  /**
   * Update statistics
   */
  updateStats(success, generationTime = 0) {
    if (success) {
      this.stats.generationsCompleted++;
      const total = this.stats.averageGenerationTime * (this.stats.generationsCompleted - 1);
      this.stats.averageGenerationTime = (total + generationTime) / this.stats.generationsCompleted;
    } else {
      this.stats.failedGenerations++;
    }
  }

  /**
   * Get system statistics
   */
  getStats() {
    const stats = { ...this.stats };

    if (this.tokenOptimizer) {
      stats.tokenOptimization = this.tokenOptimizer.getStats();
    }

    if (this.alignmentManager) {
      stats.managedSprites = this.alignmentManager.managedSprites.size;
    }

    if (this.parallaxSystem) {
      stats.parallaxConfig = this.parallaxSystem.getConfig();
    }

    return stats;
  }

  /**
   * Update integration in game loop
   */
  update(time, delta) {
    // Update parallax system
    if (this.parallaxSystem) {
      this.parallaxSystem.update(time, delta);
    }

    // Update sprite alignments if needed
    if (this.alignmentManager && this.scene?.player) {
      // Update player facing based on movement
      if (this.scene.player.body) {
        this.alignmentManager.updateFacing(
          this.scene.player,
          this.scene.player.body.velocity.x
        );
      }

      // Update enemy facings
      if (this.scene.enemies) {
        this.scene.enemies.children.entries.forEach(enemy => {
          if (enemy.body) {
            this.alignmentManager.updateFacing(enemy, enemy.body.velocity.x);
          }
        });
      }
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.parallaxSystem) {
      this.parallaxSystem.destroy();
    }

    if (this.alignmentManager) {
      this.alignmentManager.destroy();
    }

    if (this.tokenOptimizer) {
      this.tokenOptimizer.clearCache();
    }
  }

  /**
   * Switch between providers at runtime
   */
  async switchProvider(newProvider, apiKey) {
    console.log(`Switching from ${this.config.provider} to ${newProvider}`);

    this.config.provider = newProvider;

    // Reinitialize orchestrator with new provider
    this.orchestrator = new AssetOrchestrator({
      provider: newProvider,
      apiKey: apiKey || this.getApiKey(),
      parallelGeneration: true,
      qualityMode: 'high'
    });

    // Clear caches
    if (this.tokenOptimizer) {
      this.tokenOptimizer.clearCache();
    }

    return this;
  }

  /**
   * Enable/disable subsystems at runtime
   */
  toggleSubsystem(subsystem, enabled) {
    switch(subsystem) {
      case 'parallax':
        this.config.enableParallax = enabled;
        if (!enabled && this.parallaxSystem) {
          this.parallaxSystem.destroy();
        }
        break;
      case 'alignment':
        this.config.enableAlignment = enabled;
        if (!enabled && this.alignmentManager) {
          this.alignmentManager.setDebugMode(false);
        }
        break;
      case 'optimization':
        this.config.enableOptimization = enabled;
        break;
      case 'debug':
        this.config.debugMode = enabled;
        if (this.alignmentManager) {
          this.alignmentManager.setDebugMode(enabled);
        }
        break;
    }

    console.log(`${subsystem} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Export configuration for persistence
   */
  exportConfig() {
    return {
      config: this.config,
      stats: this.getStats(),
      cache: this.tokenOptimizer?.exportCache()
    };
  }

  /**
   * Import configuration
   */
  importConfig(data) {
    if (data.config) {
      this.config = { ...this.config, ...data.config };
    }

    if (data.cache && this.tokenOptimizer) {
      this.tokenOptimizer.importCache(data.cache);
    }

    console.log('Configuration imported successfully');
  }
}

// Export singleton instance for easy integration
export const assetSystem = new AssetSystemIntegration();

export default AssetSystemIntegration;