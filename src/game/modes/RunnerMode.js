import Phaser from 'phaser';
import BaseMode from './BaseMode';

export default class RunnerMode extends BaseMode {
  init() {
    const theme = this.scene.activeTheme || {};
    // Prioritize gameConfig (prompt modifiers) -> theme defaults -> hardcoded fallback
    this.baseSpeed = this.scene.gameConfig.runSpeed || theme.moveSpeed || 350;
    this.runSpeed = this.baseSpeed;
    this.obstacles = null;
    this.obstacleTimer = null;
    this.coins = null;

    // Mobile control and keyboard state
    this.mobileControls = [];
    this.uiContainer = null;
  }

  create() {
    const theme = this.scene.activeTheme || {};
    this.scene.player.setGravityY(this.scene.gameConfig.gravity || (theme.gravity || 1800));
    this.scene.playPlayerAnim('run');

    this.obstacles = this.scene.physics.add.group();

    this.obstacleTimer = this.scene.time.addEvent({
      delay: this.scene.gameConfig.obstacleDelay || 1200,
      callback: this.spawnObstacle,
      callbackScope: this,
      loop: true
    });

    this.scene.physics.add.collider(this.obstacles, this.scene.floor);
    this.scene.physics.add.collider(this.scene.player, this.obstacles, this.scene.hitObstacle, null, this.scene);

    // Coin pickups: spawned in an arc over obstacles (see spawnCoinArc), collected
    // on overlap for score. Same pattern as PlatformerMode's collectibles.
    this.coins = this.scene.physics.add.group();
    this.scene.physics.add.overlap(this.scene.player, this.coins, (player, coin) => {
      if (!coin || !coin.active) return;
      coin.destroy();
      this.scene.score += (this.scene.gameConfig.coinValue ?? 25);
      window.dispatchEvent(new CustomEvent('update-score', { detail: this.scene.score }));
    }, null, this);

    this.gameInputListener = (e) => {
      if (!e.detail) return;
      const { action, state } = e.detail;
      const isDown = state === 'down';

      if (action === 'jump' && isDown) {
        this.jump();
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

  spawnObstacle() {
    if (this.scene.isGameOver) return;

    const scale = Phaser.Math.FloatBetween(this.scene.gameConfig.obstacleScaleMin || 0.8, this.scene.gameConfig.obstacleScaleMax || 1.2);
    const spawnX = this.scene.cameras.main.scrollX + this.scene.cameras.main.width + 16;
    const obstacleTexture = this.scene.gameConfig.dynamicAssetUrls ? 'dyn_obstacle' : (this.scene.activeTheme?.obstacleTexture || 'crate');

    // Obtain frame dimensions for proper obstacle scaling normalization
    const textureObj = this.scene.textures.get(obstacleTexture);
    const frame = textureObj?.get(0);
    const frameWidth = frame ? frame.width : 64;
    const frameHeight = frame ? frame.height : 64;

    const targetSize = this.scene.gameConfig.dynamicAssetUrls ? 54 : 64;
    const normalizedScaleX = (targetSize / frameWidth) * scale;
    const normalizedScaleY = (targetSize / frameHeight) * scale;

    // Center origin and adjust position based on scaled height so it sits on the ground
    const obstacle = this.scene.add.sprite(spawnX, this.scene.LOGICAL_FLOOR_Y - (targetSize * scale) / 2, obstacleTexture);
    obstacle.setScale(normalizedScaleX, normalizedScaleY);
    this.scene.physics.add.existing(obstacle);
    this.obstacles.add(obstacle);

    if (this.scene.gameConfig.dynamicAssetUrls) {
      obstacle.body.setSize(obstacle.width, obstacle.height);
      obstacle.body.setOffset(0, 0);
    }

    const theme = this.scene.activeTheme || {};
    obstacle.body.setGravityY(this.scene.gameConfig.gravity || (theme.gravity || 1800));
    obstacle.body.setVelocityX(-this.runSpeed);

    this.spawnCoinArc(spawnX);
  }

  // A 3-coin arc traced over the obstacle so collecting rewards the jump the
  // obstacle forces anyway. Piggybacks on the obstacle spawn — no second timer,
  // so pause handling (which reaches into obstacleTimer by name) needs no changes
  // and physics.pause() freezes coins like everything else.
  spawnCoinArc(obstacleX) {
    if (!this.coins || Math.random() > 0.7) return; // ~70% of obstacles carry coins
    const useDyn = this.scene.gameConfig.dynamicAssetUrls && this.scene.textures.exists('dyn_collectible');
    const textureKey = useDyn ? 'dyn_collectible' : 'coin';
    const frame = this.scene.textures.get(textureKey)?.get(0);
    // Max-dimension normalization: generated art is cropped to content and can be
    // any aspect; the static coin.svg is square. Target ~28px either way.
    const coinScale = 28 / Math.max(frame?.width || 28, frame?.height || 28);
    const floorY = this.scene.LOGICAL_FLOOR_Y;
    [[-70, -110], [0, -150], [70, -110]].forEach(([dx, dy]) => {
      const coin = this.coins.create(obstacleX + dx, floorY + dy, textureKey);
      coin.setScale(coinScale);
      coin.body.setAllowGravity(false);
      coin.body.setVelocityX(-this.runSpeed);
    });
  }

  update(time, delta) {
    if (this.scene.isGameOver || this.scene.isGamePaused) return;

    if (this.scene.player.body.touching.down || this.scene.player.body.blocked.down) {
      this.scene.playPlayerAnim('run');
    }

    // Scroll floor
    if (this.scene.floorSegments) {
      this.scene.floorSegments.forEach((tile) => {
        tile.x -= (this.runSpeed * (delta / 1000));
      });
      const tileWidth = this.scene.floorSegments[0]?.displayWidth || 16;
      this.scene.floorSegments.forEach((tile) => {
        if (tile.x + tileWidth < this.scene.cameras.main.scrollX) {
          const maxX = Math.max(...this.scene.floorSegments.map(seg => seg.x));
          tile.x = maxX + tileWidth;
        }
      });
    } else {
      this.scene.floor.tilePositionX += (this.runSpeed * (delta / 1000)) / this.scene.floor.tileScaleX;
    }

    // Cleanup off-screen obstacles
    if (this.obstacles && this.obstacles.children) {
      this.obstacles.children.iterate((obstacle) => {
        if (obstacle && obstacle.x < -50) {
          obstacle.destroy();
        }
      });
    }

    // Cleanup off-screen (missed) coins
    if (this.coins && this.coins.children) {
      this.coins.children.iterate((coin) => {
        if (coin && coin.x < -50) {
          coin.destroy();
        }
      });
    }

    // Progressive speed
    this.runSpeed += this.scene.gameConfig.speedIncrement || 0.05;
  }

  jump() {
    if (this.scene.isGameOver) return;
    
    if (this.scene.player.body.touching.down || this.scene.player.body.blocked.down) {
      this.scene.player.body.setVelocityY(-(this.scene.gameConfig.jumpForce || 750));
      this.scene.playPlayerAnim('jump');
    }
  }

  handleResize(gameSize) {
    if (!this.scene || !this.scene.cameras || !this.scene.cameras.main) return;
    const safeWidth = Math.max(1, gameSize.width);
    const safeHeight = Math.max(1, gameSize.height);
    
    if (this.scene.cameraManager) {
      this.scene.cameraManager.handleResize({ width: safeWidth, height: safeHeight });
    }
  }

  onConfigUpdate(newConfig, oldConfig) {
    this.baseSpeed = newConfig.runSpeed || 350;
    this.runSpeed = this.baseSpeed;

    if (this.scene.player && this.scene.player.body) {
      this.scene.player.body.setGravityY(newConfig.gravity || 1800);
    }

    if (this.obstacles && this.obstacles.children) {
      this.obstacles.children.iterate((obstacle) => {
        if (obstacle && obstacle.body) {
          obstacle.body.setGravityY(newConfig.gravity || 1800);
          obstacle.body.setVelocityX(-this.runSpeed);
        }
      });
    }

    if (this.coins && this.coins.children) {
      this.coins.children.iterate((coin) => {
        if (coin && coin.body) coin.body.setVelocityX(-this.runSpeed);
      });
    }

    if (oldConfig.obstacleDelay !== newConfig.obstacleDelay) {
      if (this.obstacleTimer) this.obstacleTimer.remove();
      this.obstacleTimer = this.scene.time.addEvent({
        delay: newConfig.obstacleDelay || 1200,
        callback: this.spawnObstacle,
        callbackScope: this,
        loop: true
      });
    }
  }

  cleanup() {
    if (this.obstacleTimer) {
      this.obstacleTimer.remove();
    }
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    if (this.resizeListener) {
      this.scene.scale.off('resize', this.resizeListener, this);
    }
    if (this.obstacles && this.obstacles.scene) {
      try { this.obstacles.clear(true, true); } catch (e) {}
    }
    if (this.coins && this.coins.scene) {
      try { this.coins.clear(true, true); } catch { /* scene already torn down */ }
    }
    if (this.gameInputListener) {
      window.removeEventListener('game-input', this.gameInputListener);
      this.gameInputListener = null;
    }
  }
}

