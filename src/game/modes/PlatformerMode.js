import Phaser from 'phaser';
import BaseMode from './BaseMode';
import Projectile from '../objects/Projectile';
import MeleeAttack from '../objects/MeleeAttack';

export default class PlatformerMode extends BaseMode {
  init() {
    const theme = this.scene.activeTheme || {};
    // Prioritize gameConfig (prompt modifiers) -> theme defaults -> hardcoded fallback
    this.moveSpeed = this.scene.gameConfig.actionWalkSpeed || theme.moveSpeed || 300;
    this.jumpForce = this.scene.gameConfig.actionJumpHeight || theme.jumpForce || 600;
    this.gravity = this.scene.gameConfig.actionGravity || theme.gravity || 1500;
    
    // Feature hooks for future combat implementation
    this.enemyCount = this.scene.gameConfig.actionEnemyCount || 5;
    this.projectilesEnabled = this.scene.gameConfig.actionProjectileEnabled || false;
    
    // Determine world width based on theme
    this.worldWidth = theme.worldWidth || 4000;
    
    // We will track input state directly
    this.movingLeft = false;
    this.movingRight = false;
    
    // Multitouch: track which pointer is pressing each button
    this.leftPointerId = null;
    this.rightPointerId = null;
    
    this.platforms = null;
    this.enemies = null;
    this.projectiles = null;
    this.meleeAttacks = null;   // Pool of MeleeAttack animated sprites
    this.winZone = null;
    this.collectibles = null;
    this.progressMilestones = new Set();

    // Melee cooldown: prevent spamming (ms)
    this.meleeCooldown = 0;
    this.MELEE_COOLDOWN_MS = 400;
    
    // Mobile controls container
    this.mobileControls = [];
    this.uiContainer = null;
  }

  create() {
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;
    
    // Set explicit bounds to prevent walking into the void
    this.scene.physics.world.setBounds(0, 0, this.worldWidth, this.scene.LOGICAL_FLOOR_Y + 100);
    
    // Note: this.scene.floor is created by GameManagerScene and scaled. 
    // In GameManagerScene, we'll ensure floor width covers the world bounds if in platformer mode.

    // Config Player
    this.scene.player.setGravityY(this.gravity);
    this.scene.player.setCollideWorldBounds(true);
    
    // Spawn at theme-defined position
    const theme = this.scene.activeTheme || {};
    const spawnX = theme.spawnX || 150;
    const spawnY = typeof theme.spawnY === 'number' ? (this.scene.LOGICAL_FLOOR_Y + theme.spawnY) : (this.scene.LOGICAL_FLOOR_Y - 250);
    this.scene.player.setPosition(spawnX, spawnY);

    // Camera follow - handled via Multi-Camera Manager
    if (this.scene.cameraManager) {
      this.scene.cameraManager.setMode('follow-target', this.scene.player);
    } else {
      this.updateCameraBounds(this.scene.scale);
      this.scene.cameras.main.startFollow(this.scene.player, true, 0.08, 0.08);
    }

    // Create fixed platforms for Level 1
    this.platforms = this.scene.physics.add.staticGroup();
    this.enemies = this.scene.physics.add.group();
    this.collectibles = this.scene.physics.add.group();
    this.projectiles = this.scene.physics.add.group({
      classType: Projectile,
      maxSize: 10,
      runChildUpdate: true
    });
    this.meleeAttacks = this.scene.physics.add.group({
      classType: MeleeAttack,
      maxSize: 5,
      runChildUpdate: false
    });

    this.buildLevel1(height);

    this.spawnEnemiesForPlatforms();
    
    // Enable collision
    this.scene.physics.add.collider(this.scene.player, this.platforms);
    this.scene.physics.add.collider(this.enemies, this.platforms);
    this.scene.physics.add.collider(this.enemies, this.scene.floor);
    this.scene.physics.add.collider(this.projectiles, this.platforms, (proj) => {
      if (proj.deactivate) proj.deactivate();
    });

    this.scene.physics.add.overlap(this.scene.player, this.collectibles, (player, collectible) => {
      if (!collectible || !collectible.active) return;
      this.awardScore(25);
      collectible.destroy();
    });
    
    // Player hits enemy -> Game Over (if not attacking)
    this.scene.physics.add.overlap(this.scene.player, this.enemies, this.handlePlayerEnemyCollision, null, this);

    // Projectile hits enemy -> Kill Enemy
    this.scene.physics.add.overlap(this.projectiles, this.enemies, (proj, enemy) => {
      if (proj.deactivate) proj.deactivate();
      this.damageEnemy(enemy);
    });

    // Melee hits enemy -> Kill Enemy (only once per swing via hasHit flag)
    this.scene.physics.add.overlap(this.meleeAttacks, this.enemies, (atk, enemy) => {
      if (!atk.hasHit) {
        atk.hasHit = true;
        this.damageEnemy(enemy);
      }
    });

    // Player reaches Win Zone
    if (this.winZone) {
      this.scene.physics.add.overlap(this.scene.player, this.winZone, () => {
        if (this.scene.winGame) this.scene.winGame();
      });
    }

    this.gameInputListener = (e) => {
      if (!e.detail) return;
      const { action, state } = e.detail;
      const isDown = state === 'down';

      if (action === 'left') {
        this.movingLeft = isDown;
      } else if (action === 'right') {
        this.movingRight = isDown;
      } else if (action === 'jump' && isDown) {
        this.jump();
      } else if (action === 'melee' && isDown) {
        this.melee();
      } else if (action === 'shoot' && isDown) {
        this.shoot();
      }
    };
    window.addEventListener('game-input', this.gameInputListener);

    this.resizeListener = (gameSize) => {
      if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => {
        this.handleResize(gameSize);
      }, 150);
    };
    this.scene.scale.on('resize', this.resizeListener, this);
  }

  handleResize(gameSize) {
    if (!this.scene || !this.scene.cameras || !this.scene.cameras.main) return;
    const safeWidth = Math.max(1, gameSize.width);
    const safeHeight = Math.max(1, gameSize.height);
    const camera = this.scene.cameras.main;
    const viewWidth = camera.width || safeWidth;
    const viewHeight = camera.height || safeHeight;
    this.updateMobileControlSizing(viewWidth, viewHeight);
    this.repositionMobileControls(viewWidth, viewHeight);
    
    if (this.scene.cameraManager) {
      this.scene.cameraManager.handleResize({ width: safeWidth, height: safeHeight });
    } else {
      this.updateCameraBounds({ width: safeWidth, height: safeHeight });
    }
  }

  updateCameraBounds(gameSize) {
    if (!this.scene || !this.scene.cameras || !this.scene.cameras.main) return;
    
    // The camera bounds must be at least as tall as the screen, otherwise the camera breaks
    const minHeight = this.scene.LOGICAL_FLOOR_Y + 100;
    const boundsHeight = Math.max(minHeight, gameSize.height);
    
    this.scene.cameras.main.setBounds(0, 0, this.worldWidth, boundsHeight);
    
    // Nudge the follow target to ensure the camera re-centers after a bounds update
    if (this.scene.player) {
      this.scene.cameras.main.startFollow(this.scene.player, true, 0.08, 0.08);
      // Force an immediate snap to prevent the camera from "flying" or being stuck if it lost focus during rotation
      this.scene.cameras.main.centerOn(this.scene.player.x, this.scene.player.y);
    }
  }

  buildLevel1(sceneHeight) {
    const floorY = this.scene.LOGICAL_FLOOR_Y;
    
    // Very simple hand-placed static map
    const theme = this.scene.activeTheme || {};
    const isSmallWorld = (theme.worldWidth || 4000) < 2000;
    const layout = this.scene.gameConfig.layoutArray || (isSmallWorld ? [
      { x: 180, y: floorY - 20, scaleX: 5, hasEnemy: false },
      { x: 350, y: floorY - 35, scaleX: 5, hasEnemy: true },
      { x: 520, y: floorY - 20, scaleX: 5, hasEnemy: false },
      { x: 690, y: floorY - 35, scaleX: 5, hasEnemy: true },
      { x: 850, y: floorY - 25, scaleX: 8, hasEnemy: false }, // Big finish block
    ] : [
      { x: 400, y: floorY - 80, scaleX: 1.5, hasEnemy: false },
      { x: 800, y: floorY - 150, scaleX: 2.0, hasEnemy: true },
      { x: 1200, y: floorY - 80, scaleX: 1.0, hasEnemy: false },
      { x: 1500, y: floorY - 180, scaleX: 1.5, hasEnemy: true },
      { x: 1900, y: floorY - 250, scaleX: 1.5, hasEnemy: false },
      { x: 2300, y: floorY - 150, scaleX: 1.0, hasEnemy: true },
      { x: 2600, y: floorY - 80, scaleX: 1.5, hasEnemy: false },
      { x: 3000, y: floorY - 120, scaleX: 1.0, hasEnemy: true },
      { x: 3400, y: floorY - 200, scaleX: 3.0, hasEnemy: false }, // Big finish block
    ]);

    const maxEnemies = this.enemyCount;

    const TILE_W = theme.tileWidth || 64;
    const PLATFORM_H = theme.platformHeight || 32;
    const themePlatformTexture = this.scene.gameConfig.dynamicAssetUrls ? 'dyn_platform' : (this.scene.activeTheme?.platformTexture || 'stone_tile');
    const collectibleTexture = this.scene.activeTheme?.collectibleTexture || 'crate';

    // Retrieve dimensions of the platform texture frame for correct dynamic repeating tile scale
    const textureObj = this.scene.textures.get(themePlatformTexture);
    const frame = textureObj?.get(0);
    const frameWidth = frame ? frame.width : TILE_W;
    const frameHeight = frame ? frame.height : PLATFORM_H;

    layout.forEach((p, index) => {
      const platWidth = p.scaleX * TILE_W;

      // Visual: tileSprite (repeats the texture instead of stretching)
      const block = this.scene.add.tileSprite(p.x, p.y, platWidth, PLATFORM_H, themePlatformTexture);
      
      // Dynamic tile scaling:
      block.tileScaleX = TILE_W / frameWidth;
      block.tileScaleY = PLATFORM_H / frameHeight;

      // Physics: add static body matching the tileSprite dimensions
      this.scene.physics.add.existing(block, true);
      this.platforms.add(block);

      // Store edges for patrol logic
      block.leftEdge = p.x - (platWidth / 2);
      block.rightEdge = p.x + (platWidth / 2);
      
      if (p.hasEnemy && maxEnemies > 0) {
        block.hasEnemySpot = true;
      }

      if (!p.hasEnemy && index % 2 === 0) {
        const collectible = this.collectibles.create(p.x, p.y - 80, collectibleTexture);
        if (collectibleTexture === 'fox') {
          if (this.scene.anims.exists('star_spin')) {
            collectible.play('star_spin', true);
          } else {
            collectible.setFrame('idle-1');
          }
          collectible.setScale(1.5); // stars are 16x16, scale to 24px
        } else {
          collectible.setScale(0.5);
        }
        collectible.body.setAllowGravity(false);
      }

      // Add win zone on the last block
      if (index === layout.length - 1) {
        this.winZone = this.scene.physics.add.sprite(p.x, p.y - 100, 'crate').setVisible(false);
        this.winZone.body.setAllowGravity(false);
        this.winZone.body.setSize(100, 200);
      }
    });
  }

  jump() {
    if (this.scene.isGameOver) return;

    const touchingDown = this.scene.player.body.touching.down || this.scene.player.body.blocked.down;
    if (touchingDown) {
      this.scene.player.setVelocityY(-this.jumpForce);
    }
  }

  update(time, delta) {
    if (this.scene.isGameOver || this.scene.isGamePaused) return;

    const { player } = this.scene;
    let isMoving = false;

    // Movement Logic with organic acceleration and friction deceleration
    const accel = 1200;      // px/s^2 acceleration rate
    const drag = 1600;       // px/s^2 friction/drag rate
    const dt = delta / 1000; // delta time in seconds

    if (this.scene.keyStates.ArrowLeft || this.scene.keyStates.KeyA || this.movingLeft) {
      let vx = player.body.velocity.x;
      vx = Math.max(-this.moveSpeed, vx - accel * dt);
      player.setVelocityX(vx);
      player.setFlipX(true);
      isMoving = true;
    } else if (this.scene.keyStates.ArrowRight || this.scene.keyStates.KeyD || this.movingRight) {
      let vx = player.body.velocity.x;
      vx = Math.min(this.moveSpeed, vx + accel * dt);
      player.setVelocityX(vx);
      player.setFlipX(false);
      isMoving = true;
    } else {
      let vx = player.body.velocity.x;
      if (vx > 0) {
        vx = Math.max(0, vx - drag * dt);
      } else if (vx < 0) {
        vx = Math.min(0, vx + drag * dt);
      }
      player.setVelocityX(vx);
      if (vx !== 0) {
        isMoving = true;
      }
    }

    // Combat Input — via keyStates from domKeyDown
    if (this.scene.keyStates._meleeTrigger) {
      this.scene.keyStates._meleeTrigger = false;
      this.melee();
    }
    if (this.projectilesEnabled && this.scene.keyStates._shootTrigger) {
      this.scene.keyStates._shootTrigger = false;
      this.shoot();
    }

    // Tick down melee cooldown
    if (this.meleeCooldown > 0) this.meleeCooldown -= delta;

    // Enemy Patrol Logic
    this.enemies.children.iterate((enemy) => {
      if (!enemy || !enemy.active) return;
      
      // Face direction of movement
      if (enemy.body.velocity.x > 0) enemy.setFlipX(false);
      else if (enemy.body.velocity.x < 0) enemy.setFlipX(true);
      
      // Edge detection
      if (enemy.patrolPlatform) {
        const p = enemy.patrolPlatform;
        const eX = enemy.x;
        if (enemy.body.velocity.x > 0 && eX > p.rightEdge - 10) {
          enemy.setVelocityX(-50);
        } else if (enemy.body.velocity.x < 0 && eX < p.leftEdge + 10) {
          enemy.setVelocityX(50);
        }
      }
    });

    const progressIndex = Math.floor(player.x / 400);
    if (!this.progressMilestones.has(progressIndex)) {
      this.progressMilestones.add(progressIndex);
      if (progressIndex > 0) this.awardScore(10);
    }

    // Animation Logic
    const touchingDown = player.body.touching.down || player.body.blocked.down;
    
    if (touchingDown) {
      if (isMoving) {
        this.scene.playPlayerAnim('run');
      } else {
        this.scene.playPlayerAnim('idle');
      }
    } else {
      this.scene.playPlayerAnim('jump');
    }
  }

  cleanupStaleTouchPointers() {
    if (this.leftPointerId != null) {
      const ptr = this.scene.input.manager.pointers.find(p => p.id === this.leftPointerId);
      if (!ptr || !ptr.isDown) {
        this.movingLeft = false;
        this.leftPointerId = null;
        if (this.btnLeft) this.btnLeft.setAlpha(0.65);
      }
    }
    if (this.rightPointerId != null) {
      const ptr = this.scene.input.manager.pointers.find(p => p.id === this.rightPointerId);
      if (!ptr || !ptr.isDown) {
        this.movingRight = false;
        this.rightPointerId = null;
        if (this.btnRight) this.btnRight.setAlpha(0.65);
      }
    }
  }

  jump() {
    if (this.scene.isGameOver) return;

    const touchingDown = this.scene.player.body.touching.down || this.scene.player.body.blocked.down;
    if (touchingDown) {
      this.scene.player.setVelocityY(-this.jumpForce);
    }
  }

  melee() {
    if (this.scene.isGameOver) return;
    if (this.meleeCooldown > 0) return;   // Respect cooldown

    this.meleeCooldown = this.MELEE_COOLDOWN_MS;

    // Flash the player white to show an attack was registered
    this.scene.player.setTintFill(0xffffff);
    this.scene.time.delayedCall(80, () => this.scene.player.clearTint());

    // Retrieve an inactive MeleeAttack from the pool
    const atk = this.meleeAttacks.get();
    if (!atk) return;   // Pool exhausted – silently skip

    const isFacingLeft = this.scene.player.flipX;
    // Place the slash in front of the player
    const offsetX = isFacingLeft ? -72 : 72;
    atk.swing(
      this.scene.player.x + offsetX,
      this.scene.player.y,
      isFacingLeft
    );
  }

  shoot() {
    if (this.scene.isGameOver || !this.projectilesEnabled) return;
    
    // Retrieve an inactive projectile from the pool
    const projectile = this.projectiles.get();
    
    if (projectile) {
      const isFacingLeft = this.scene.player.flipX;
      const offsetX = isFacingLeft ? -20 : 20;
      
      // Set the themed texture, defaulting to 'projectile'
      const textureKey = this.scene.gameConfig.actionProjectileType || 'projectile';
      projectile.setTexture(textureKey);

      // Fire it
      projectile.fire(this.scene.player.x + offsetX, this.scene.player.y, isFacingLeft);
    }
  }

  damageEnemy(enemy) {
    if (!enemy || !enemy.active || enemy._dying) return;
    
    enemy.health -= 1;
    this.awardScore(10);
    
    if (enemy.health <= 0) {
      // Mark dying immediately to prevent double-processing from rapid overlaps
      enemy._dying = true;
      if (enemy.body) {
        enemy.body.enable = false;
      }

      // Death particles
      for (let i = 0; i < 8; i++) {
        const bit = this.scene.add.rectangle(enemy.x, enemy.y, 6, 6, 0xff4444);
        this.scene.physics.add.existing(bit);
        bit.body.setVelocity(
          Phaser.Math.Between(-120, 120),
          Phaser.Math.Between(-250, -50)
        );
        bit.body.setAllowGravity(true);
        this.scene.time.delayedCall(600, () => bit.destroy());
      }

      // Fade-out + shrink before removal
      this.scene.tweens.add({
        targets: enemy,
        alpha: 0,
        scaleX: 0,
        scaleY: 0,
        duration: 200,
        ease: 'Power2',
        onComplete: () => {
          if (enemy.scene) {
            this.enemies.remove(enemy, true, true);
          }
        }
      });

      this.awardScore(100);
    } else {
      // Damage flash
      enemy.setTintFill(0xffffff);
      this.scene.tweens.add({
        targets: enemy,
        duration: 60,
        yoyo: true,
        onComplete: () => {
          if (enemy.active) enemy.setTint(0xff0000);
        }
      });
    }
  }

  handlePlayerEnemyCollision(player, enemy) {
    if (enemy._dying) return;
    this.scene.hitObstacle();
  }

  onConfigUpdate(newConfig, oldConfig) {
    this.jumpForce = newConfig.actionJumpHeight || 600;
    this.enemyCount = newConfig.actionEnemyCount || 5;
    this.projectilesEnabled = !!newConfig.actionProjectileEnabled;
    this.moveSpeed = newConfig.actionWalkSpeed || 300;
    
    if (newConfig.actionGravity !== oldConfig.actionGravity) {
      this.gravity = newConfig.actionGravity || 1500;
      if (this.scene.player && this.scene.player.body) {
        this.scene.player.body.setGravityY(this.gravity);
      }
    }
    if (newConfig.actionEnemyCount !== oldConfig.actionEnemyCount) {
      this.refreshEnemies();
    }
  }

  awardScore(points) {
    if (!points) return;
    this.scene.score += points;
    window.dispatchEvent(new CustomEvent('update-score', { detail: this.scene.score }));
  }

  refreshEnemies() {
    if (!this.enemies) return;
    this.enemies.clear(true, true);
    this.spawnEnemiesForPlatforms();
  }

  spawnEnemiesForPlatforms() {
    if (!this.platforms) return;
    let enemiesCreated = 0;
    const maxEnemies = this.enemyCount;
    const theme = this.scene.activeTheme;
    const enemyTexture = this.scene.gameConfig.dynamicAssetUrls ? 'dyn_enemy' : (theme?.enemyTexture || 'dude');

    const enemySpots = [];
    const fallbackSpots = [];

    this.platforms.children.iterate((block) => {
      if (!block || !block.leftEdge || !block.rightEdge) return;
      if (block.hasEnemySpot) enemySpots.push(block);
      else fallbackSpots.push(block);
    });

    const spawnOnBlock = (block) => {
      if (!block || enemiesCreated >= maxEnemies) return;
      
      // Safety guard: do not spawn enemies on top of or too close to the player starting spawn point
      const spawnX = theme?.spawnX || 150;
      if (block.x < spawnX + 120) return;

      const enemy = this.enemies.create(block.x, block.y - 40, enemyTexture);
      enemy.health = 3;
      enemy.setGravityY(this.gravity);
      
      if (this.scene.gameConfig.dynamicAssetUrls) {
        const textureObj = this.scene.textures.get(enemyTexture);
        const frame = textureObj?.get(0);
        const h = frame ? frame.height : 128;
        // Target a standardized height of 50px
        enemy.setScale(50 / h);
        enemy.body.setSize(enemy.width, enemy.height);
        enemy.body.setOffset(0, 0);
      } else if (enemyTexture === 'fox') {
        enemy.setScale(1.5);
        const enemyAnim = theme?.enemyAnim || 'slug_walk';
        if (enemyAnim === 'yeti_walk') {
          enemy.body.setSize(26, 28);
          enemy.body.setOffset(4, 5);
        } else {
          enemy.body.setSize(24, 25);
          enemy.body.setOffset(14, 18);
        }
        enemy.play(enemyAnim, true);
      } else {
        enemy.setFrame(5);
        enemy.setTint(0xff0000);
        enemy.body.setSize(20, 42);
        enemy.body.setOffset(6, 6);
      }
      
      enemy.setVelocityX(50);
      enemy.setBounceX(1);
      enemy.setCollideWorldBounds(true);
      enemy.patrolPlatform = block;
      enemiesCreated++;
    };

    enemySpots.forEach(spawnOnBlock);
    fallbackSpots.forEach(spawnOnBlock);
  }

  cleanup() {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    if (this.resizeListener) {
      this.scene.scale.off('resize', this.resizeListener, this);
    }
    // Reset camera follow securely
    if (this.scene && this.scene.cameras && this.scene.cameras.main) {
      this.scene.cameras.main.stopFollow();
      if (this.scene.cameras.main.removeBounds) {
        this.scene.cameras.main.removeBounds();
      }
    }
    
    if (this.platforms && this.platforms.scene) {
      try { this.platforms.clear(true, true); } catch (e) {}
    }
    
    if (this.enemies && this.enemies.scene) {
      try { this.enemies.clear(true, true); } catch (e) {}
    }

    if (this.collectibles && this.collectibles.scene) {
      try { this.collectibles.clear(true, true); } catch (e) {}
    }

    if (this.meleeAttacks && this.meleeAttacks.scene) {
      try { this.meleeAttacks.clear(true, true); } catch (e) {}
    }
    
    if (this.gameInputListener) {
      window.removeEventListener('game-input', this.gameInputListener);
      this.gameInputListener = null;
    }
  }
}
