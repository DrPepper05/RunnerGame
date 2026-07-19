/**
 * AssetSystemDemo - Demo and testing for new AI orchestration system
 * Provides examples and test cases for all new features
 */

import { AssetSystemIntegration } from './AssetSystemIntegration.js';
import { PROVIDERS } from './AssetOrchestrator.js';

export class AssetSystemDemo {
  constructor() {
    this.integration = null;
    this.testResults = [];
    this.demoMode = false;
  }

  /**
   * Initialize demo with configuration
   */
  async initialize(config = {}) {
    console.log('🎮 Initializing Asset System Demo...');

    this.integration = new AssetSystemIntegration({
      provider: config.provider || PROVIDERS.GEMINI_IMAGEN,
      enableNewSystem: true,
      enableParallax: true,
      enableAlignment: true,
      enableOptimization: true,
      debugMode: config.debugMode || false
    });

    // Initialize with dummy scene for testing
    const mockScene = this.createMockScene();
    await this.integration.initialize(mockScene, config.apiKey);

    console.log('✅ Demo initialized successfully');
    return this;
  }

  /**
   * Create mock scene for testing
   */
  createMockScene() {
    return {
      LOGICAL_FLOOR_Y: 1000,
      game: {
        config: {
          width: 1280,
          height: 720
        }
      },
      textures: {
        get: (key) => ({
          get: (frame) => ({
            width: 128,
            height: 128
          })
        }),
        addImage: (key, img) => console.log(`Texture added: ${key}`)
      },
      add: {
        tileSprite: (...args) => ({
          setOrigin: () => {},
          setScale: () => {},
          setScrollFactor: () => {},
          setDepth: () => {},
          setTint: () => {},
          setAlpha: () => {}
        }),
        sprite: (...args) => ({
          setOrigin: () => {},
          setScale: () => {},
          body: {
            setSize: () => {},
            setOffset: () => {}
          }
        }),
        image: (...args) => ({
          setScrollFactor: () => {},
          setAlpha: () => {},
          setDepth: () => {}
        }),
        rectangle: (...args) => ({
          setDepth: () => {},
          setAlpha: () => {}
        }),
        graphics: () => ({
          setDepth: () => {},
          lineStyle: () => {},
          strokeRect: () => {},
          lineBetween: () => {},
          fillStyle: () => {},
          fillCircle: () => {}
        }),
        particles: () => ({
          setScrollFactor: () => {},
          setDepth: () => {}
        })
      },
      physics: {
        add: {
          existing: () => {},
          sprite: () => ({
            body: {
              setSize: () => {},
              setOffset: () => {}
            }
          })
        }
      },
      cameras: {
        main: {
          scrollX: 0,
          width: 1280,
          setBounds: () => {},
          startFollow: () => {},
          setFollowOffset: () => {}
        }
      },
      load: {
        image: () => {},
        start: () => {}
      },
      tweens: {
        add: () => {}
      }
    };
  }

  /**
   * Run all demo tests
   */
  async runAllDemos() {
    console.log('\n🧪 Running Asset System Demos...\n');

    const demos = [
      this.demoBasicGeneration,
      this.demoParallaxSystem,
      this.demoSpriteAlignment,
      this.demoTokenOptimization,
      this.demoProviderSwitching,
      this.demoBatchProcessing,
      this.demoErrorHandling
    ];

    for (const demo of demos) {
      await this.runDemo(demo.bind(this));
    }

    this.printResults();
  }

  /**
   * Run a single demo
   */
  async runDemo(demoFunction) {
    const name = demoFunction.name;
    console.log(`\n▶️  Running: ${name}`);

    try {
      const result = await demoFunction();
      this.testResults.push({
        name,
        status: 'PASS',
        result
      });
      console.log(`✅ ${name} completed successfully`);
    } catch (error) {
      this.testResults.push({
        name,
        status: 'FAIL',
        error: error.message
      });
      console.error(`❌ ${name} failed:`, error.message);
    }
  }

  /**
   * Demo 1: Basic asset generation
   */
  async demoBasicGeneration() {
    console.log('Testing basic asset generation...');

    const prompt = 'cyberpunk runner with neon lights';
    const result = await this.integration.generateGameAssets(prompt, {
      context: {
        difficulty: 7,
        gameType: 'runner'
      }
    });

    // Verify result structure
    if (!result.gameConfig || !result.assets || !result.styleGuide) {
      throw new Error('Missing expected result properties');
    }

    console.log('Generated game config:', result.gameConfig.gameName);
    console.log('Style guide:', result.styleGuide.artStyle);
    console.log('Assets generated:', Object.keys(result.assets));

    return result;
  }

  /**
   * Demo 2: Parallax background system
   */
  async demoParallaxSystem() {
    console.log('Testing parallax background system...');

    const mockAssets = {
      backgrounds: {
        far: 'mock_far_texture',
        mid: 'mock_mid_texture',
        near: 'mock_near_texture'
      },
      floor: 'mock_floor_texture'
    };

    if (this.integration.parallaxSystem) {
      this.integration.parallaxSystem.initialize(mockAssets);

      // Test parallax intensity adjustment
      this.integration.parallaxSystem.setParallaxIntensity(0.5);
      this.integration.parallaxSystem.setParallaxIntensity(1.0);

      // Test weather effects
      this.integration.parallaxSystem.addWeatherEffects('fog');

      console.log('Parallax config:', this.integration.parallaxSystem.getConfig());
    }

    return { parallaxInitialized: true };
  }

  /**
   * Demo 3: Sprite alignment system
   */
  async demoSpriteAlignment() {
    console.log('Testing sprite alignment system...');

    if (this.integration.alignmentManager) {
      // Create mock sprite
      const mockSprite = {
        width: 128,
        height: 128,
        texture: { key: 'test_sprite' },
        frame: { name: 'frame0', width: 128, height: 128 },
        setOrigin: () => {},
        setFlipX: () => {},
        setScale: () => {},
        alignmentData: {}
      };

      // Initialize with alignment
      this.integration.alignmentManager.initializeSprite(mockSprite, {
        type: 'character',
        groundY: 1000,
        facing: 'right',
        anchor: 'bottom-center'
      });

      console.log('Sprite alignment data:', mockSprite.alignmentData);

      // Test facing update
      this.integration.alignmentManager.updateFacing(mockSprite, 100); // Moving right
      this.integration.alignmentManager.updateFacing(mockSprite, -100); // Moving left

      return { alignmentApplied: true };
    }

    return { alignmentApplied: false };
  }

  /**
   * Demo 4: Token optimization
   */
  async demoTokenOptimization() {
    console.log('Testing token optimization...');

    if (this.integration.tokenOptimizer) {
      const longPrompt = `
        Create a detailed game environment with the following specifications:
        - Theme: Cyberpunk city at night with neon lights and rain
        - Character: A futuristic ninja with glowing weapons
        - Enemies: Robot sentinels with laser eyes
        - Platforms: Floating magnetic platforms
        - Background: Multiple layers of city buildings with parallax scrolling
        - Style: High detail pixel art with vibrant colors
      `;

      // Test optimization
      const optimization = this.integration.tokenOptimizer.optimizePrompt(longPrompt, {
        styleGuide: {
          artStyle: 'cyberpunk-pixel-art',
          colorPalette: ['#FF00FF', '#00FFFF', '#FF1493']
        }
      });

      console.log(`Original tokens: ~${longPrompt.length / 4}`);
      console.log(`Tokens saved: ${optimization.tokensSaved}`);
      console.log(`Cache key: ${optimization.cacheKey}`);

      // Test cache hit
      const secondOptimization = this.integration.tokenOptimizer.optimizePrompt(longPrompt, {
        styleGuide: {
          artStyle: 'cyberpunk-pixel-art',
          colorPalette: ['#FF00FF', '#00FFFF', '#FF1493']
        }
      });

      console.log(`Cache hit: ${secondOptimization.cached}`);

      // Get optimization stats
      const stats = this.integration.tokenOptimizer.getStats();
      console.log('Optimization stats:', stats);

      return stats;
    }

    return { optimizationEnabled: false };
  }

  /**
   * Demo 5: Provider switching
   */
  async demoProviderSwitching() {
    console.log('Testing provider switching...');

    const originalProvider = this.integration.config.provider;

    // Switch to different provider
    await this.integration.switchProvider(PROVIDERS.DALLE3, 'mock_api_key');
    console.log('Switched to DALL-E 3');

    // Switch back
    await this.integration.switchProvider(originalProvider, 'mock_api_key');
    console.log(`Switched back to ${originalProvider}`);

    return { providerSwitchingWorked: true };
  }

  /**
   * Demo 6: Batch processing
   */
  async demoBatchProcessing() {
    console.log('Testing batch processing...');

    if (this.integration.tokenOptimizer) {
      // Create multiple requests
      const requests = [
        { type: 'character', prompt: 'ninja', model: 'fast', maxTokens: 100, execute: async () => 'ninja_result' },
        { type: 'character', prompt: 'robot', model: 'fast', maxTokens: 100, execute: async () => 'robot_result' },
        { type: 'character', prompt: 'alien', model: 'fast', maxTokens: 100, execute: async () => 'alien_result' }
      ];

      // Batch process
      const promises = requests.map(req =>
        this.integration.tokenOptimizer.batchRequest(req)
      );

      const results = await Promise.all(promises);
      console.log('Batch results:', results);

      return { batchProcessed: results.length };
    }

    return { batchProcessingEnabled: false };
  }

  /**
   * Demo 7: Error handling and fallback
   */
  async demoErrorHandling() {
    console.log('Testing error handling...');

    // Test with invalid prompt
    try {
      await this.integration.generateGameAssets('', { allowFallback: false });
    } catch (error) {
      console.log('Caught expected error for empty prompt');
    }

    // Test fallback mechanism
    const result = await this.integration.generateGameAssets('test prompt', {
      allowFallback: true
    });

    console.log('Fallback handled successfully');

    return { errorHandlingWorked: true };
  }

  /**
   * Interactive demo mode
   */
  async startInteractiveDemo() {
    console.log('\n🎮 Starting Interactive Demo Mode\n');
    console.log('Commands:');
    console.log('  generate <prompt> - Generate assets with prompt');
    console.log('  parallax <on|off> - Toggle parallax system');
    console.log('  alignment <on|off> - Toggle alignment system');
    console.log('  optimization <on|off> - Toggle token optimization');
    console.log('  debug <on|off> - Toggle debug mode');
    console.log('  stats - Show system statistics');
    console.log('  clear - Clear caches');
    console.log('  exit - Exit demo mode\n');

    this.demoMode = true;

    // In a real implementation, this would listen for user input
    // For now, we'll just demonstrate the structure
    return { interactiveMode: 'ready' };
  }

  /**
   * Handle interactive command
   */
  async handleCommand(command, ...args) {
    if (!this.demoMode) return;

    switch(command) {
      case 'generate':
        const prompt = args.join(' ');
        console.log(`Generating with prompt: "${prompt}"`);
        const result = await this.integration.generateGameAssets(prompt);
        console.log('Generation complete:', result.gameConfig.gameName);
        break;

      case 'parallax':
        const parallaxEnabled = args[0] === 'on';
        this.integration.toggleSubsystem('parallax', parallaxEnabled);
        break;

      case 'alignment':
        const alignmentEnabled = args[0] === 'on';
        this.integration.toggleSubsystem('alignment', alignmentEnabled);
        break;

      case 'optimization':
        const optimizationEnabled = args[0] === 'on';
        this.integration.toggleSubsystem('optimization', optimizationEnabled);
        break;

      case 'debug':
        const debugEnabled = args[0] === 'on';
        this.integration.toggleSubsystem('debug', debugEnabled);
        break;

      case 'stats':
        const stats = this.integration.getStats();
        console.log('System Statistics:', JSON.stringify(stats, null, 2));
        break;

      case 'clear':
        if (this.integration.tokenOptimizer) {
          this.integration.tokenOptimizer.clearCache();
        }
        console.log('Caches cleared');
        break;

      case 'exit':
        this.demoMode = false;
        console.log('Exiting demo mode');
        break;

      default:
        console.log('Unknown command:', command);
    }
  }

  /**
   * Print test results
   */
  printResults() {
    console.log('\n📊 Demo Results Summary\n');
    console.log('═'.repeat(50));

    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;

    this.testResults.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : '❌';
      console.log(`${icon} ${result.name}: ${result.status}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    });

    console.log('═'.repeat(50));
    console.log(`Total: ${passed} passed, ${failed} failed\n`);

    return {
      passed,
      failed,
      total: this.testResults.length
    };
  }

  /**
   * Performance benchmark
   */
  async runPerformanceBenchmark() {
    console.log('\n⚡ Running Performance Benchmark...\n');

    const prompts = [
      'forest adventure with magical creatures',
      'space station with alien enemies',
      'underwater temple with sea monsters',
      'volcanic cavern with lava hazards',
      'ice palace with frozen enemies'
    ];

    const benchmarkResults = [];

    for (const prompt of prompts) {
      const startTime = Date.now();

      try {
        await this.integration.generateGameAssets(prompt);
        const elapsed = Date.now() - startTime;

        benchmarkResults.push({
          prompt,
          time: elapsed,
          status: 'success'
        });

        console.log(`✅ "${prompt}" - ${elapsed}ms`);
      } catch (error) {
        benchmarkResults.push({
          prompt,
          time: 0,
          status: 'failed',
          error: error.message
        });

        console.log(`❌ "${prompt}" - Failed`);
      }
    }

    // Calculate statistics
    const successfulRuns = benchmarkResults.filter(r => r.status === 'success');
    const avgTime = successfulRuns.reduce((sum, r) => sum + r.time, 0) / successfulRuns.length;
    const minTime = Math.min(...successfulRuns.map(r => r.time));
    const maxTime = Math.max(...successfulRuns.map(r => r.time));

    console.log('\n📈 Benchmark Results:');
    console.log(`Average time: ${avgTime.toFixed(0)}ms`);
    console.log(`Min time: ${minTime}ms`);
    console.log(`Max time: ${maxTime}ms`);
    console.log(`Success rate: ${(successfulRuns.length / prompts.length * 100).toFixed(0)}%`);

    return benchmarkResults;
  }
}

// Export for testing
export default AssetSystemDemo;

// Auto-run demo if this file is executed directly
if (import.meta.url === new URL(import.meta.url).href) {
  const demo = new AssetSystemDemo();
  demo.initialize().then(() => demo.runAllDemos());
}