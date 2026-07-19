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
    if (this.gameInputListener) {
      window.removeEventListener('game-input', this.gameInputListener);
      this.gameInputListener = null;
    }
  }
}

