import Phaser from 'phaser';
import { DEFAULT_CONFIG } from '../gameConfig';
import { getTheme } from './themes';
import GameModeManager from './GameModeManager';
import MultiCameraManager from './MultiCameraManager';
import { compileAssetUrls } from './geminiService';
import ParallaxGroundSystem from './ParallaxGroundSystem';
import SpriteAlignmentManager from './SpriteAlignmentManager';


export default class GameManagerScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameManagerScene' });
  }

  preload() {
    // Configure Phaser loader to handle cross-origin image requests
    this.load.crossOrigin = 'anonymous';

    // Hook loader listeners for rich console debugging and UI synchronization
    this.load.on('loaderror', (fileObj) => {
      const errorMsg = `Phaser Preloader failed to load asset key "${fileObj.key}" from URL: ${fileObj.url}`;
      console.error('[Phaser Preloader Error]', errorMsg);
      window.dispatchEvent(new CustomEvent('playmint-error', { detail: { message: errorMsg } }));
    });

    this.load.on('filecomplete', (key, type, data) => {
      console.log(`[Phaser Preloader Success] Successfully loaded asset: "${key}" (${type})`);
      window.dispatchEvent(new CustomEvent('phaser-file-complete', { detail: { key } }));
    });

    this.load.on('complete', () => {
      console.log('[Phaser Preloader Complete] All queued assets loaded.');
      window.dispatchEvent(new CustomEvent('phaser-load-complete'));
    });

    const hasPreloaded = !!this.gameConfig?.preloadedImages;
    if (hasPreloaded) {
      console.log('[Phaser Preloader] Dynamic assets already registered via browser preloader. Bypassing loader requests.');
    } else {
      // Guarantee that dynamicAssetUrls is always present
      if (!this.gameConfig?.dynamicAssetUrls) {
        console.warn('[Phaser Preloader] Config missing dynamicAssetUrls. Compiling fallback assets on the fly...');
        const theme = this.gameConfig?.themeKey || 'ice';
        const mode = this.gameConfig?.gameType || 'runner';
        const assets = {
          background_far: `${theme} complete detailed scenery landscape background backdrop`,
          floor: `${theme} soil ground surface texture`,
          platform: `${theme} floating platform ledge block`,
          player: `${mode === 'platformer' ? 'adventurer explorer hero character' : 'runner speed runner athlete character'}`,
          enemy: `${theme} themed basic monster creature enemy`,
          obstacle: `${theme} hazard spike or barrier obstacle`
        };
        if (this.gameConfig) {
          this.gameConfig.dynamicAssetUrls = compileAssetUrls(assets);
        }
      }

      const urls = this.gameConfig?.dynamicAssetUrls;
      if (urls) {
        console.log('[Phaser Preloader] Loading dynamic assets:', urls);
        if (urls.background_far) this.load.image('dyn_bg_far', urls.background_far);
        if (urls.floor) this.load.image('dyn_floor', urls.floor);
        if (urls.platform) this.load.image('dyn_platform', urls.platform);
        if (urls.player) this.load.image('dyn_player', urls.player);
        if (urls.enemy) this.load.image('dyn_enemy', urls.enemy);
        if (urls.obstacle) this.load.image('dyn_obstacle', urls.obstacle);
      }
    }

    this.load.spritesheet('dude', 'assets/dude.png', { frameWidth: 32, frameHeight: 48 });
    this.load.atlas('fox', 'assets/atlas/atlas.png', 'assets/atlas/atlas.json');
    this.load.image('crate', 'assets/crate.png');
    this.load.image('ground', 'assets/ground.png');
    this.load.svg('projectile', 'assets/shuriken.svg', { width: 48, height: 16 }); // Laser bolt
    this.load.svg('shuriken', 'assets/shuriken.svg', { width: 32, height: 32 });
    this.load.svg('fireball', 'assets/fireball.svg', { width: 32, height: 32 });
    this.load.svg('laser', 'assets/laser.svg', { width: 48, height: 16 });
    // Melee slash animation frames
    this.load.svg('slash_f0', 'assets/slash_f0.svg', { width: 128, height: 128 });
    this.load.svg('slash_f1', 'assets/slash_f1.svg', { width: 128, height: 128 });
    this.load.svg('slash_f2', 'assets/slash_f2.svg', { width: 128, height: 128 });
    this.load.svg('slash_f3', 'assets/slash_f3.svg', { width: 128, height: 128 });
    this.load.svg('slash_f4', 'assets/slash_f4.svg', { width: 128, height: 128 });
    this.load.svg('slash_f5', 'assets/slash_f5.svg', { width: 128, height: 128 });
    this.load.image('stone_tile', 'assets/stone_tile.png');
    this.load.image('lava_ground', 'assets/themes/lava/lava_ground.png');
    this.load.image('lava_tile', 'assets/themes/lava/lava_tile.png');
    this.load.image('ice_tile', 'assets/themes/ice/ice_tile.png');
    this.load.image('bg_default_base', 'assets/themes/forest/bg_far.png');
    this.load.image('bg_lava_base', 'assets/themes/lava/bg.png');
    this.load.image('bg_lava_sky', 'assets/themes/lava/sky.png');
    this.load.image('bg_lava_mountains', 'assets/themes/lava/mountains.png');
    this.load.image('bg_lava_clouds', 'assets/themes/lava/clouds.png');
    this.load.image('bg_ice_sky', 'assets/themes/ice/sky.png');
    this.load.image('bg_ice_mountains', 'assets/themes/ice/mountains.png');
    this.load.image('bg_ice_clouds', 'assets/themes/ice/clouds.png');
    this.load.image('forest_bg_far', 'assets/themes/forest/bg_far.png');
    this.load.image('forest_bg_mid', 'assets/themes/forest/bg_mid.png');
    this.load.image('forest_ground', 'assets/themes/forest/ground_tile.png');
    this.load.image('forest_platform', 'assets/themes/forest/ground_tile.png');
    this.load.image('winter_bg_1', 'assets/themes/winter/bg-1.png');
    this.load.image('winter_bg_2', 'assets/themes/winter/bg-2.png');
    this.load.image('winter_bg_3', 'assets/themes/winter/bg-3.png');
    this.load.image('winter_ground_1', 'assets/themes/winter/winter_ground_1.png');
    this.load.image('pine_snow', 'assets/themes/winter/pine-snow.gif');
    // City theme
    this.load.image('city_ground', 'assets/themes/city/city_tile.png');
    this.load.image('city_tile', 'assets/themes/city/city_tile.png');
    this.load.image('city_bg_far', 'assets/themes/city/bg_far.png');
    this.load.image('city_bg_mid', 'assets/themes/city/bg_mid.png');
    this.load.image('city_bg_near', 'assets/themes/city/bg_near.png');
    // Space theme
    this.load.image('space_ground', 'assets/scifi_tileset.png');
    this.load.image('space_tile', 'assets/scifi_tileset.png');
    this.load.image('space_bg_stars', 'assets/themes/space/bg_stars.png');
    this.load.image('space_bg_nebula', 'assets/themes/space/bg_nebula.png');
    this.load.image('space_bg_planet', 'assets/themes/space/bg_planet.png');
  }

  init(data) {
    this.gameConfig = {
      ...DEFAULT_CONFIG,
      ...(window.__GAME_LIVE_CONFIG || {}),
      ...data
    };

    // Register preloaded HTML images into Phaser's Texture Manager
    const preloaded = this.gameConfig?.preloadedImages;
    if (preloaded) {
      console.log('[Phaser GameManagerScene] Registering preloaded HTML images into Texture Manager:', Object.keys(preloaded));
      
      const textureMap = {
        background_far: 'dyn_bg_far',
        floor: 'dyn_floor',
        platform: 'dyn_platform',
        player: 'dyn_player',
        enemy: 'dyn_enemy',
        obstacle: 'dyn_obstacle'
      };

      Object.entries(preloaded).forEach(([key, img]) => {
        const textureKey = textureMap[key] || key;
        if (this.textures.exists(textureKey)) {
          this.textures.remove(textureKey);
        }
        this.textures.addImage(textureKey, img);
        console.log(`[Phaser GameManagerScene] Successfully registered preloaded texture: "${textureKey}"`);
      });
    }

    this.gameModeManager = new GameModeManager(this);
  }

  create() {
    this.isGameOver = false;
    window.dispatchEvent(new CustomEvent('game-reset'));
    this.score = 0;
    window.dispatchEvent(new CustomEvent('update-score', { detail: this.score }));
    this.activeTheme = getTheme(this.gameConfig.themeKey);
    this.secondaryTheme = this.gameConfig.secondaryThemeKey ? getTheme(this.gameConfig.secondaryThemeKey) : null;

    // Enable multitouch for mobile controls (movement + jumping)
    this.input.addPointer(2);

    const width = this.scale.width;
    const height = this.scale.height;

    this.LOGICAL_FLOOR_Y = 1000;
    const floorHeight = this.secondaryTheme?.floorHeight || this.activeTheme.floorHeight || this.gameConfig.floorHeight || 100;

    // Initialize improvement systems
    this.parallaxSystem = new ParallaxGroundSystem(this);
    this.alignmentManager = new SpriteAlignmentManager(this);

    // Create a smooth background gradient
    this.bgGraphics = this.add.graphics();
    this.bgGraphics.setScrollFactor(0); // Pinned to camera
    this.bgGraphics.setDepth(-20);
    this.bgLayers = [];
    this.createBackgroundLayers();
    this.drawBackground(width, height); // Draw background immediately (fixes black screen)

    // Score state is managed in React. Update via DOM event.
    if (this.gameConfig.gameType === 'runner') {
      this.scoreTimer = this.time.addEvent({
        delay: this.gameConfig.scoreTimerDelay || 100,
        callback: () => {
          if (!this.isGameOver) {
            this.score += 1;
            window.dispatchEvent(new CustomEvent('update-score', { detail: this.score }));
          }
        },
        loop: true
      });
    }

    // Floor - Make it wide enough to cover the world width if we are in platformer mode.
    const floorWidth = this.gameConfig.gameType === 'platformer' ? 4000 : Math.max(width * 2, 4000);
    const floorTexture = this.gameConfig.dynamicAssetUrls ? 'dyn_floor' : (this.secondaryTheme?.floorTexture || this.activeTheme.floorTexture || 'ground');
    const floorFrameIndex = this.gameConfig.dynamicAssetUrls ? 0 : (this.secondaryTheme?.floorFrame !== undefined ? this.secondaryTheme.floorFrame : (this.activeTheme.floorFrame !== undefined ? this.activeTheme.floorFrame : 0));
    const textureObj = this.textures.get(floorTexture);
    const frame = textureObj?.get(floorFrameIndex);

    if (frame && frame.width && frame.height) {
      const tileWidth = frame.width;
      const tileHeight = frame.height;
      const scaleY = floorHeight / tileHeight;
      const scaledWidth = tileWidth * scaleY;
      const repeatCount = Math.ceil(floorWidth / scaledWidth);

      this.floorSegments = [];
      for (let i = 0; i < repeatCount; i++) {
        const tile = this.add.sprite(i * scaledWidth, this.LOGICAL_FLOOR_Y, floorTexture, floorFrameIndex).setOrigin(0, 0);
        tile.setScale(scaleY);
        this.floorSegments.push(tile);
      }

      this.floor = this.add.rectangle(0, this.LOGICAL_FLOOR_Y, floorWidth, floorHeight, 0x000000, 0);
      this.floor.setOrigin(0, 0);
    } else {
      this.floor = this.add.tileSprite(0, this.LOGICAL_FLOOR_Y, floorWidth, floorHeight, floorTexture, floorFrameIndex).setOrigin(0, 0);
      const themeTileScale = this.secondaryTheme?.floorTileScale || this.activeTheme.floorTileScale || 0.15;
      this.floor.tileScaleX = this.gameConfig.dynamicAssetUrls ? 1.0 : (this.gameConfig.floorTileScale || themeTileScale);
      this.floor.tileScaleY = this.gameConfig.dynamicAssetUrls ? 1.0 : (this.gameConfig.floorTileScale || themeTileScale);
    }
    this.physics.add.existing(this.floor, true); // Static

    // Bounds must accommodate the static depth
    this.physics.world.setBounds(0, 0, floorWidth, this.LOGICAL_FLOOR_Y + floorHeight);

    // Animations
    if (!this.anims.exists('run')) {
      this.anims.create({
        key: 'run',
        frames: this.anims.generateFrameNumbers('dude', { start: 5, end: 8 }),
        frameRate: 10,
        repeat: -1
      });
    }

    // Fox animations
    if (!this.anims.exists('fox_run')) {
      this.anims.create({
        key: 'fox_run',
        frames: this.anims.generateFrameNames('fox', { prefix: 'run-', start: 1, end: 8 }),
        frameRate: 12,
        repeat: -1
      });
    }
    if (!this.anims.exists('fox_idle')) {
      this.anims.create({
        key: 'fox_idle',
        frames: this.anims.generateFrameNames('fox', { prefix: 'idle-', start: 1, end: 4 }),
        frameRate: 6,
        repeat: -1
      });
    }
    if (!this.anims.exists('fox_jump')) {
      this.anims.create({
        key: 'fox_jump',
        frames: this.anims.generateFrameNames('fox', { prefix: 'jump-', start: 1, end: 5 }),
        frameRate: 10,
        repeat: 0
      });
    }
    if (!this.anims.exists('star_spin')) {
      try {
        const frames = this.anims.generateFrameNames('fox', { prefix: 'star/star-', start: 1, end: 4 });
        if (frames && frames.length > 0) {
          this.anims.create({
            key: 'star_spin',
            frames: frames,
            frameRate: 8,
            repeat: -1
          });
        }
      } catch (e) {
        console.warn('Could not load star atlas frames, skipping anim creation');
      }
    }
    if (!this.anims.exists('slug_walk')) {
      try {
        let frames = this.anims.generateFrameNames('fox', { prefix: 'slug/slug-', start: 1, end: 2 });
        if (!frames || frames.length === 0) {
          // Fallback to walk frames which are present in the atlas
          frames = this.anims.generateFrameNames('fox', { prefix: 'walk-', start: 1, end: 4 });
        }
        if (frames && frames.length > 0) {
          this.anims.create({
            key: 'slug_walk',
            frames: frames,
            frameRate: 6,
            repeat: -1
          });
        }
      } catch (e) {
        console.warn('Could not load slug atlas frames');
      }
    }
    if (!this.anims.exists('yeti_walk')) {
      try {
        const frames = this.anims.generateFrameNames('fox', { prefix: 'yeti-', start: 1, end: 8 });
        if (frames && frames.length > 0) {
          this.anims.create({
            key: 'yeti_walk',
            frames: frames,
            frameRate: 8,
            repeat: -1
          });
        }
      } catch (e) {
        console.warn('Could not load yeti atlas frames');
      }
    }

    // Melee slash animation — 6 SVG textures cycled as individual frames
    if (!this.anims.exists('slash_anim')) {
      this.anims.create({
        key: 'slash_anim',
        frames: [
          { key: 'slash_f0' },
          { key: 'slash_f1' },
          { key: 'slash_f2' },
          { key: 'slash_f3' },
          { key: 'slash_f4' },
          { key: 'slash_f5' },
        ],
        frameRate: 18,  // ~333 ms total — snappy but readable
        repeat: 0        // play once then fire ANIMATION_COMPLETE
      });
    }

    // Player Base Logic
    const playerYOffset = 150;
    const playerX = 150;
    const playerType = this.activeTheme.playerType || 'dude';
    
    let playerTexture = playerType;
    let playerFrame = undefined;
    if (this.gameConfig.dynamicAssetUrls) {
      playerTexture = 'dyn_player';
      playerFrame = undefined;
    } else if (playerType === 'yeti') {
      playerTexture = 'fox';
      playerFrame = 'yeti-1';
    } else if (playerType === 'fox') {
      playerTexture = 'fox';
      playerFrame = 'idle-1';
    }
    
    this.player = this.physics.add.sprite(playerX, this.LOGICAL_FLOOR_Y - playerYOffset, playerTexture, playerFrame);
    let scale = this.gameConfig.playerScale || (playerType === 'fox' || playerType === 'yeti' ? 1.8 : 1.5);
    if (this.gameConfig.dynamicAssetUrls) {
      const textureObj = this.textures.get('dyn_player');
      const frame = textureObj?.get(0);
      const h = frame ? frame.height : 128;
      // Target a standardized height of 64px
      scale = 64 / h;
    }
    this.player.setScale(scale);

    // Use SpriteAlignmentManager for better ground contact
    if (this.alignmentManager && this.gameConfig.dynamicAssetUrls) {
      // Apply intelligent alignment for dynamic assets
      this.alignmentManager.initializeSprite(this.player, {
        type: 'character',
        groundY: this.LOGICAL_FLOOR_Y,
        facing: 'right',
        anchor: 'bottom-center',
        autoScale: false // We already scaled it above
      });
    } else {
      // Set precise hitbox size and offsets for static assets
      if (this.gameConfig.dynamicAssetUrls) {
        // Cropped textures fit the character content tightly, so use full texture bounds with zero offset
        this.player.body.setSize(this.player.width, this.player.height);
        this.player.body.setOffset(0, 0);
        // Ensure the player faces right (prompts request right-facing sprites)
        this.player.setFlipX(false);
      } else if (playerType === 'fox') {
        this.player.body.setSize(24, 25);
        this.player.body.setOffset(14, 18);
      } else if (playerType === 'yeti') {
        this.player.body.setSize(26, 28);
        this.player.body.setOffset(4, 5);
      } else {
        // dude
        this.player.body.setSize(20, 42);
        this.player.body.setOffset(6, 6);
      }
    }

    this.physics.add.collider(this.player, this.floor);

    // Initialize Multi-Camera Manager
    this.cameraManager = new MultiCameraManager(this);
    const cameraMode = this.gameConfig.gameType === 'runner' 
      ? 'side-scrolling' 
      : (this.gameConfig.gameType === 'platformer' ? 'follow-target' : 'fixed-arena');
    this.cameraManager.setMode(cameraMode, this.player);

    // Core game mode handling
    this.gameModeManager.setMode(this.gameConfig.gameType);
    this.gameModeManager.create();

    // DOM-level keyboard handling — bypasses Phaser KeyboardPlugin entirely
    this.keyStates = {};
    this.domKeyDown = (e) => {
      const el = document.activeElement;
      const isTextInput = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')));
      if (isTextInput) return;
      if (e.repeat) return;

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }

      if (this.isGameOver || this.isGamePaused) return;

      this.keyStates[e.code] = true;

      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        this.gameModeManager.jump();
      }
      if (e.code === 'KeyE') {
        this.keyStates._meleeTrigger = true;
      }
      if (e.code === 'KeyF') {
        this.keyStates._shootTrigger = true;
      }
    };
    window.addEventListener('keydown', this.domKeyDown);

    this.domKeyUp = (e) => {
      this.keyStates[e.code] = false;
    };
    window.addEventListener('keyup', this.domKeyUp);

    // Click/tap: restarts on game-over or jumps in Runner mode.
    this.input.on('pointerdown', () => {
      if (this.isGameOver) {
        this.scene.restart();
      } else if (this.gameConfig.gameType === 'runner') {
        this.gameModeManager.jump();
      }
    }, this);

    // Dynamic resize handler - ONLY updates camera and UI
    this.scale.on('resize', this.handleResize, this);
    this.handleResize(this.scale); // Force initial camera alignment

    // Mobile orientation change handler — longer delay lets the browser settle
    this.orientationHandler = () => {
      if (this._orientationTimeout) clearTimeout(this._orientationTimeout);
      this._orientationTimeout = setTimeout(() => {
        if (this.scale && this.scale.refresh) {
          this.scale.refresh();
        }
        this.handleResize(this.scale);
      }, 400);
    };
    window.addEventListener('orientationchange', this.orientationHandler);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', this.orientationHandler);
    }

    // Live tuning integration
    this.updateConfigListener = (e) => {
      const newConfig = e.detail;
      const oldConfig = { ...this.gameConfig };

      this.gameConfig = { ...this.gameConfig, ...newConfig };

      if (newConfig.gameType !== oldConfig.gameType) {
        // Instant Restart for UX Gap
        this.scene.restart();
      } else {
        if (newConfig.themeKey && newConfig.themeKey !== oldConfig.themeKey) {
          this.scene.restart();
          return;
        }
        this.gameModeManager.onConfigUpdate(newConfig, oldConfig);
      }
    };
    window.addEventListener('update-game-config', this.updateConfigListener);

    this.restartGameListener = () => {
      if (this.isGameOver) {
        this.scene.restart();
      }
    };
    window.addEventListener('restart-game', this.restartGameListener);

    this.isGamePaused = false;
    this.togglePauseListener = (e) => {
      const isPaused = e.detail.isPaused;
      if (isPaused) {
        this.physics.pause();
        if (this.scoreTimer) this.scoreTimer.paused = true;
        this.anims.pauseAll();
        this.tweens.pauseAll();
        if (this.gameModeManager?.activeMode?.obstacleTimer) {
          this.gameModeManager.activeMode.obstacleTimer.paused = true;
        }
        this.isGamePaused = true;
      } else {
        if (!this.isGameOver) {
          this.physics.resume();
          if (this.scoreTimer) this.scoreTimer.paused = false;
          this.anims.resumeAll();
          this.tweens.resumeAll();
          if (this.gameModeManager?.activeMode?.obstacleTimer) {
            this.gameModeManager.activeMode.obstacleTimer.paused = false;
          }
        }
        this.isGamePaused = false;
      }
    };
    window.addEventListener('toggle-pause-game', this.togglePauseListener);

    this.events.on('shutdown', () => {
      window.removeEventListener('keydown', this.domKeyDown);
      window.removeEventListener('keyup', this.domKeyUp);
      window.removeEventListener('toggle-pause-game', this.togglePauseListener);
      window.removeEventListener('update-game-config', this.updateConfigListener);
      window.removeEventListener('orientationchange', this.orientationHandler);
      window.removeEventListener('restart-game', this.restartGameListener);
      if (screen.orientation) {
        screen.orientation.removeEventListener('change', this.orientationHandler);
      }
      if (this.bgLayers) {
        this.bgLayers.forEach((layer) => layer.destroy());
        this.bgLayers = [];
      }
      if (this.floorSegments) {
        this.floorSegments.forEach((segment) => segment.destroy());
        this.floorSegments = [];
      }
      if (this.gameModeManager) {
        this.gameModeManager.cleanup();
      }
    });
  }

  drawBackground(width, height) {
    this.bgGraphics.clear();
    this.bgGraphics.fillStyle(0x0a0f16, 1);
    this.bgGraphics.fillRect(-width, -height, width * 3, height * 3);
  }

  createBackgroundLayers() {
    if (this.bgLayers && this.bgLayers.length) {
      this.bgLayers.forEach((layer) => layer.destroy());
    }
    this.bgLayers = [];

    const theme = this.activeTheme || getTheme(this.gameConfig.themeKey);
    const width = this.scale.width;
    const height = this.scale.height;
    
    let layers = theme.backgroundLayers || [];
    if (this.gameConfig.dynamicAssetUrls) {
      layers = [
        { key: 'dyn_bg_far', speed: 0.02, scale: 1 }
      ];
    }

    layers.forEach((layer) => {
      const texture = this.textures.get(layer.key);
      const source = texture.getSourceImage();
      const textureWidth = source?.width || width;
      const textureHeight = source?.height || height;
      const baseScaleX = width / textureWidth;
      const baseScaleY = height / textureHeight;
      const baseScale = Math.max(baseScaleX, baseScaleY);

      const sprite = this.add.sprite(width / 2, height / 2, layer.key)
        .setOrigin(0.5, 0.5)
        .setScrollFactor(0)
        .setDepth(-5 + this.bgLayers.length);

      const finalScale = (layer.scale || 1) * baseScale;
      sprite.__layerScale = layer.scale || 1;
      sprite.setScale(finalScale);
      if (layer.alpha != null) {
        sprite.setAlpha(layer.alpha);
      }
      if (layer.tint) {
        sprite.setTint(layer.tint);
      }

      sprite.__scrollSpeed = layer.speed || 0.1;
      this.bgLayers.push(sprite);
    });
  }

  handleResize(gameSize) {
    // Delay slightly to allow the DOM/browser to settle after a mobile rotation
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      if (!this.cameras || !this.cameras.main) return;

      // Sanitize dimensions to prevent NaN/Matrix errors during mobile rotation
      const width = Math.max(1, this.scale.width);
      const height = Math.max(1, this.scale.height);

      // Delegate resizing to Multi-Camera Manager
      if (this.cameraManager) {
        this.cameraManager.handleResize({ width, height });
      } else {
        this.cameras.main.setViewport(0, 0, width, height);
      }

      const zoomFactor = this.cameras.main.zoom;

      this.drawBackground(width, height);
      if (this.bgLayers && this.bgLayers.length) {
        this.bgLayers.forEach((layer) => {
          const texture = this.textures.get(layer.texture.key);
          const source = texture.getSourceImage();
          const textureWidth = source?.width || width;
          const textureHeight = source?.height || height;
          const logicalWidth = width / zoomFactor;
          const logicalHeight = height / zoomFactor;
          const baseScaleX = logicalWidth / textureWidth;
          const baseScaleY = logicalHeight / textureHeight;
          const baseScale = Math.max(baseScaleX, baseScaleY);
          const desiredScale = (layer.__layerScale || 1) * baseScale;
          layer.setScale(desiredScale);
          layer.setPosition(width / 2, height / 2);
        });
      }

      if (this.floorSegments && this.floorSegments.length) {
        const floorWidth = this.gameConfig.gameType === 'platformer' ? 4000 : Math.max(width * 4, 1600);
        const floorHeight = this.activeTheme?.floorHeight || this.gameConfig.floorHeight || 100;
        const floorTexture = this.gameConfig.dynamicAssetUrls ? 'dyn_floor' : (this.activeTheme.floorTexture || 'ground');
        const floorFrameIndex = this.gameConfig.dynamicAssetUrls ? 0 : (this.activeTheme.floorFrame !== undefined ? this.activeTheme.floorFrame : 0);
        const textureObj = this.textures.get(floorTexture);
        const frame = textureObj?.get(floorFrameIndex);

        if (frame && frame.width && frame.height) {
          const tileWidth = frame.width;
          const tileHeight = frame.height;
          const scaleY = floorHeight / tileHeight;
          const scaledWidth = tileWidth * scaleY;
          const repeatCount = Math.ceil(floorWidth / scaledWidth);

          while (this.floorSegments.length < repeatCount) {
            const tile = this.add.sprite(0, this.LOGICAL_FLOOR_Y, floorTexture, floorFrameIndex).setOrigin(0, 0);
            tile.setScale(scaleY);
            this.floorSegments.push(tile);
          }
          while (this.floorSegments.length > repeatCount) {
            const tile = this.floorSegments.pop();
            tile.destroy();
          }

          this.floorSegments.forEach((tile, index) => {
            tile.setScale(scaleY);
            tile.setPosition(index * scaledWidth, this.LOGICAL_FLOOR_Y);
          });
        }
      }

      if (this.gameModeManager && this.gameModeManager.handleResize) {
        this.gameModeManager.handleResize({ width, height });
      }

    }, 150);
  }

  playPlayerAnim(animName) {
    if (this.gameConfig.dynamicAssetUrls) {
      if (this.player && this.player.anims) {
        this.player.anims.stop();
      }
      return;
    }
    const playerType = this.activeTheme.playerType || 'dude';
    if (playerType === 'fox') {
      if (animName === 'run') {
        this.player.play('fox_run', true);
      } else if (animName === 'idle') {
        this.player.play('fox_idle', true);
      } else if (animName === 'jump') {
        this.player.play('fox_jump', true);
      }
    } else if (playerType === 'yeti') {
      if (animName === 'run') {
        this.player.play('yeti_walk', true);
      } else if (animName === 'idle') {
        this.player.anims.stop();
        this.player.setFrame('yeti-1');
      } else if (animName === 'jump') {
        this.player.anims.stop();
        this.player.setFrame('yeti-6');
      }
    } else {
      // dude
      if (animName === 'run') {
        this.player.play('run', true);
      } else if (animName === 'idle') {
        this.player.anims.stop();
        this.player.setFrame(5);
      } else if (animName === 'jump') {
        this.player.anims.stop();
        this.player.setFrame(6);
      }
    }
  }

  getThemeAccent() {
    const tints = {
      lava: '#FF6B3D',
      ice: '#66AAFF',
      forest: '#66CC66',
      city: '#4488CC',
      space: '#AA66FF'
    };
    return tints[this.activeTheme?.key] || '#00E599';
  }

  createGameOverUI(isWin, playerTint, scoreBonus) {
    if (scoreBonus) {
      this.score += scoreBonus;
      window.dispatchEvent(new CustomEvent('update-score', { detail: this.score }));
    }

    // Apply player tint
    this.player.setTint(playerTint);

    // Dispatch the custom event to trigger React UI
    window.dispatchEvent(new CustomEvent('game-over', {
      detail: {
        isWin,
        score: this.score,
        themeKey: this.gameConfig.themeKey || 'default',
        gameType: this.gameConfig.gameType || 'runner'
      }
    }));
  }

  hitObstacle(player, obstacle) {
    if (this.isGameOver) return;
    this.isGameOver = true;

    this.physics.pause();
    this.player.anims.stop();

    this.createGameOverUI(false, 0x888888, 0);
  }

  winGame() {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.hasWon = true;

    this.physics.pause();
    this.player.anims.stop();

    this.createGameOverUI(true, 0x00FF00, 500);
  }

  update(time, delta) {
    if (this.isGameOver || this.isGamePaused) return;

    // Update parallax backgrounds if enabled
    if (this.parallaxSystem) {
      this.parallaxSystem.update(time, delta);
    }

    // Update sprite alignment if needed
    if (this.alignmentManager && this.player && this.player.body) {
      this.alignmentManager.updateFacing(this.player, this.player.body.velocity.x);
    }

    if (this.gameConfig.gameType === 'runner') {
       this.virtualScrollX = (this.virtualScrollX || 0) + (this.gameModeManager?.activeMode?.runSpeed || this.gameConfig.runSpeed) * (delta / 1000);
    }
    const scrollX = this.gameConfig.gameType === 'runner' ? this.virtualScrollX : (this.cameras?.main?.scrollX || 0);

    if (this.bgLayers && this.bgLayers.length) {
      const screenWidth = this.scale.width;
      this.bgLayers.forEach((layer) => {
        if (this.gameConfig.gameType === 'runner') {
          layer.x = screenWidth / 2;
        } else {
          layer.x = (screenWidth / 2) - (scrollX * (layer.__scrollSpeed || 0.1));
        }
      });
    }
    this.gameModeManager.update(time, delta);
  }
}
