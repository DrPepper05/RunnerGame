/**
 * ParallaxGroundSystem - Advanced multi-layer parallax background and ground rendering
 * Replaces the repeating tile system with continuous, smooth scrolling backgrounds
 */

export class ParallaxGroundSystem {
  constructor(scene) {
    this.scene = scene;
    this.layers = [];
    this.ground = null;
    this.foregroundElements = [];

    // Configuration for different layer types
    this.layerConfig = {
      far: {
        scrollFactor: 0.1,
        tint: 0xCCCCFF, // Slight blue tint for atmospheric perspective
        alpha: 0.8
      },
      mid: {
        scrollFactor: 0.3,
        tint: 0xEEEEEE,
        alpha: 0.9
      },
      near: {
        scrollFactor: 0.5,
        tint: 0xFFFFFF,
        alpha: 1.0
      },
      ground: {
        scrollFactor: 1.0,
        tint: 0xFFFFFF,
        alpha: 1.0
      },
      foreground: {
        scrollFactor: 1.2,
        tint: 0xFFFFFF,
        alpha: 0.7
      }
    };

    // Ground configuration
    this.groundConfig = {
      continuous: true,
      seamlessRepeat: true,
      edgeBlending: true
    };

    // Performance optimization
    this.cullingEnabled = true;
    this.viewportPadding = 200; // Pixels to render beyond viewport
  }

  /**
   * Initialize the parallax system with generated assets
   */
  initialize(assets, config = {}) {
    this.config = { ...this.groundConfig, ...config };

    // Clear any existing layers
    this.destroy();

    // Create background layers
    this.createBackgroundLayers(assets.backgrounds);

    // Create continuous ground
    this.createContinuousGround(assets.floor);

    // Optional: Create foreground elements
    if (assets.foreground) {
      this.createForegroundElements(assets.foreground);
    }

    // Set up camera follow
    this.setupCameraSystem();

    return this;
  }

  /**
   * Create multi-layer parallax backgrounds
   */
  createBackgroundLayers(backgrounds) {
    if (!backgrounds) return;

    // Define layer order (back to front)
    const layerOrder = ['far', 'mid', 'near'];

    layerOrder.forEach((layerName, index) => {
      if (backgrounds[layerName]) {
        const layer = this.createParallaxLayer(
          backgrounds[layerName],
          layerName,
          index
        );
        this.layers.push(layer);
      }
    });

    // Sort layers by depth
    this.layers.sort((a, b) => a.depth - b.depth);
  }

  /**
   * Create a single parallax layer
   */
  createParallaxLayer(texture, layerName, depth) {
    const config = this.layerConfig[layerName] || this.layerConfig.mid;
    const gameWidth = this.scene.game.config.width;
    const gameHeight = this.scene.game.config.height;

    // Determine if texture is already loaded or needs loading
    let textureKey;
    if (typeof texture === 'string') {
      textureKey = texture;
    } else if (texture.key) {
      textureKey = texture.key;
    } else {
      // Dynamic texture, register it
      textureKey = `parallax_${layerName}_${Date.now()}`;
      this.registerDynamicTexture(textureKey, texture);
    }

    // Get texture dimensions
    const textureObj = this.scene.textures.get(textureKey);
    const frame = textureObj?.get(0);
    const textureWidth = frame?.width || 2048;
    const textureHeight = frame?.height || 768;

    // Calculate scale to fit height
    const scaleY = gameHeight / textureHeight;
    const scaledWidth = textureWidth * scaleY;

    // Create tiling sprite for infinite scrolling
    const layer = this.scene.add.tileSprite(
      0,
      0,
      gameWidth * 2, // Make it wider for smooth scrolling
      textureHeight,
      textureKey
    );

    // Configure layer properties
    layer.setOrigin(0, 0);
    layer.setScale(scaleY);
    layer.setScrollFactor(config.scrollFactor, 1);
    layer.setDepth(depth - 100); // Ensure backgrounds are behind everything
    layer.setTint(config.tint);
    layer.setAlpha(config.alpha);

    // Store metadata
    layer.layerName = layerName;
    layer.parallaxConfig = config;
    layer.baseWidth = scaledWidth;

    return layer;
  }

  /**
   * Create continuous ground instead of repeating tiles
   */
  createContinuousGround(groundTexture) {
    if (!groundTexture) return;

    const gameWidth = this.scene.game.config.width;
    const floorY = this.scene.LOGICAL_FLOOR_Y || 1000;

    // Register dynamic texture if needed
    let textureKey;
    if (typeof groundTexture === 'string') {
      textureKey = groundTexture;
    } else {
      textureKey = `ground_${Date.now()}`;
      this.registerDynamicTexture(textureKey, groundTexture);
    }

    // Get texture dimensions
    const textureObj = this.scene.textures.get(textureKey);
    const frame = textureObj?.get(0);
    const textureWidth = frame?.width || 2048;
    const textureHeight = frame?.height || 256;

    // Create continuous ground using tileSprite for seamless scrolling
    this.ground = this.scene.add.tileSprite(
      0,
      floorY,
      gameWidth * 3, // Make it very wide
      textureHeight,
      textureKey
    );

    this.ground.setOrigin(0, 1); // Bottom-left origin
    this.ground.setDepth(10); // Above backgrounds but below game elements

    // Add physics for collision
    this.scene.physics.add.existing(this.ground, true); // Static body
    this.ground.body.setSize(gameWidth * 3, textureHeight * 0.5); // Collision only on top half

    // Store reference for the scene
    this.scene.floor = this.ground;

    // Optional: Add decorative elements on top of ground
    if (this.config.decorations) {
      this.addGroundDecorations();
    }

    return this.ground;
  }

  /**
   * Create optional foreground elements for added depth
   */
  createForegroundElements(foregroundAssets) {
    const config = this.layerConfig.foreground;

    foregroundAssets.forEach((asset, index) => {
      const element = this.scene.add.image(
        asset.x || Math.random() * 2000,
        asset.y || this.scene.LOGICAL_FLOOR_Y - 50,
        asset.texture
      );

      element.setScrollFactor(config.scrollFactor, 1);
      element.setAlpha(config.alpha);
      element.setDepth(200); // In front of most game elements

      this.foregroundElements.push(element);
    });
  }

  /**
   * Add decorative elements on the ground
   */
  addGroundDecorations() {
    const decorationTypes = ['grass', 'rocks', 'flowers', 'debris'];
    const decorationCount = 20;

    for (let i = 0; i < decorationCount; i++) {
      const type = Phaser.Math.RND.pick(decorationTypes);
      const x = Phaser.Math.Between(0, 3000);
      const y = this.scene.LOGICAL_FLOOR_Y - Phaser.Math.Between(5, 20);

      // Create simple decoration sprites (would use actual textures in production)
      const decoration = this.scene.add.rectangle(
        x, y,
        Phaser.Math.Between(10, 30),
        Phaser.Math.Between(5, 15),
        Phaser.Math.RND.pick([0x556B2F, 0x8B7355, 0x708090])
      );

      decoration.setDepth(11); // Just above ground
      decoration.setAlpha(0.6);
    }
  }

  /**
   * Set up camera system for smooth scrolling
   */
  setupCameraSystem() {
    const camera = this.scene.cameras.main;

    // Set camera bounds to allow scrolling
    const worldWidth = this.scene.gameConfig?.worldWidth || 10000;
    camera.setBounds(0, 0, worldWidth, this.scene.game.config.height);

    // Enable smooth camera following
    if (this.scene.player) {
      camera.startFollow(this.scene.player, true, 0.05, 0.05);
      camera.setFollowOffset(0, 100); // Slight offset to see ahead
    }
  }

  /**
   * Register a dynamic texture from asset data
   */
  registerDynamicTexture(key, textureData) {
    if (textureData.data && textureData.format) {
      if (textureData.format === 'base64') {
        // Create image from base64
        const img = new Image();
        img.src = `data:${textureData.mimeType || 'image/png'};base64,${textureData.data}`;

        img.onload = () => {
          this.scene.textures.addImage(key, img);
        };
      } else if (textureData.format === 'url') {
        // Load from URL
        this.scene.load.image(key, textureData.data);
        this.scene.load.start();
      }
    }
  }

  /**
   * Update parallax scrolling based on camera position
   */
  update(time, delta) {
    if (!this.scene.cameras.main) return;

    const camera = this.scene.cameras.main;
    const scrollX = camera.scrollX;

    // Update each parallax layer
    this.layers.forEach(layer => {
      if (layer && layer.active) {
        // Calculate tile position based on camera scroll and parallax factor
        const parallaxOffset = scrollX * (1 - layer.parallaxConfig.scrollFactor);
        layer.tilePositionX = scrollX - parallaxOffset;

        // Optional: Add subtle animation to certain layers
        if (layer.layerName === 'far') {
          // Gentle cloud drift
          layer.tilePositionX += time * 0.001;
        }
      }
    });

    // Update ground scrolling
    if (this.ground && this.ground.active) {
      this.ground.tilePositionX = scrollX;
    }

    // Cull off-screen elements for performance
    if (this.cullingEnabled) {
      this.cullOffscreenElements();
    }
  }

  /**
   * Cull elements outside viewport for performance
   */
  cullOffscreenElements() {
    const camera = this.scene.cameras.main;
    const viewLeft = camera.scrollX - this.viewportPadding;
    const viewRight = camera.scrollX + camera.width + this.viewportPadding;

    // Cull foreground elements
    this.foregroundElements.forEach(element => {
      const inView = element.x >= viewLeft && element.x <= viewRight;
      element.setVisible(inView);
      element.setActive(inView);
    });
  }

  /**
   * Clean up the parallax system
   */
  destroy() {
    // Destroy all layers
    this.layers.forEach(layer => {
      if (layer) layer.destroy();
    });
    this.layers = [];

    // Destroy ground
    if (this.ground) {
      this.ground.destroy();
      this.ground = null;
    }

    // Destroy foreground elements
    this.foregroundElements.forEach(element => {
      if (element) element.destroy();
    });
    this.foregroundElements = [];
  }

  /**
   * Get current parallax configuration
   */
  getConfig() {
    return {
      layers: this.layers.map(l => ({
        name: l.layerName,
        scrollFactor: l.parallaxConfig.scrollFactor
      })),
      groundEnabled: !!this.ground,
      cullingEnabled: this.cullingEnabled
    };
  }

  /**
   * Adjust parallax intensity at runtime
   */
  setParallaxIntensity(intensity = 1.0) {
    this.layers.forEach(layer => {
      const baseScrollFactor = this.layerConfig[layer.layerName].scrollFactor;
      const adjustedFactor = 1 - ((1 - baseScrollFactor) * intensity);
      layer.setScrollFactor(adjustedFactor, 1);
    });
  }

  /**
   * Enable or disable specific layers
   */
  toggleLayer(layerName, enabled) {
    const layer = this.layers.find(l => l.layerName === layerName);
    if (layer) {
      layer.setVisible(enabled);
      layer.setActive(enabled);
    }
  }

  /**
   * Add dynamic weather effects to layers
   */
  addWeatherEffects(weatherType) {
    switch(weatherType) {
      case 'rain':
        this.addRainEffect();
        break;
      case 'snow':
        this.addSnowEffect();
        break;
      case 'fog':
        this.addFogEffect();
        break;
      case 'dust':
        this.addDustEffect();
        break;
    }
  }

  /**
   * Add rain effect
   */
  addRainEffect() {
    const rainEmitter = this.scene.add.particles(0, 0, 'rain', {
      x: { min: 0, max: this.scene.game.config.width },
      y: -10,
      speedY: { min: 300, max: 500 },
      speedX: { min: -20, max: 20 },
      scale: { start: 1, end: 0.5 },
      alpha: { start: 0.6, end: 0 },
      quantity: 2,
      frequency: 50,
      lifespan: 2000
    });

    rainEmitter.setScrollFactor(0);
    rainEmitter.setDepth(150);
  }

  /**
   * Add fog effect overlay
   */
  addFogEffect() {
    const fog = this.scene.add.rectangle(
      0, 0,
      this.scene.game.config.width * 2,
      this.scene.game.config.height,
      0xFFFFFF
    );

    fog.setOrigin(0, 0);
    fog.setAlpha(0.3);
    fog.setScrollFactor(0);
    fog.setDepth(180);
    fog.setBlendMode(Phaser.BlendModes.SCREEN);

    // Animate fog opacity
    this.scene.tweens.add({
      targets: fog,
      alpha: { from: 0.2, to: 0.4 },
      duration: 3000,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1
    });
  }

  addSnowEffect() {
    // Implementation for snow particles
  }

  addDustEffect() {
    // Implementation for dust particles
  }
}

export default ParallaxGroundSystem;