import Phaser from 'phaser';
import BaseMode from './BaseMode';
import Projectile from '../objects/Projectile';

// Top-down arena survival shooter. No gravity, 360° movement. On desktop the
// player continuously faces the mouse cursor (independent of movement) and F
// key / click fires a real directional shot toward it — mouse aim only
// engages after the first genuine (non-touch) pointer move, so it never
// hijacks rotation on a touch device. Touch has no cursor to aim with, so it
// keeps the original assisted aim: rotation follows movement, and the mobile
// fire button shoots at the nearest enemy in range (see CLAUDE.md's Shooter
// Arena section).
// Player/enemy art is a single static top-down sprite rotated at render time,
// never a directional sheet — GameManagerScene skips SpriteAlignmentManager's
// ground-anchor/flip logic for this mode and leaves the sprite origin centered.
export default class ShooterMode extends BaseMode {
  init() {
    const cfg = this.scene.gameConfig;

    this.moveSpeed = cfg.shooterMoveSpeed || 260;
    this.fireRate = cfg.shooterFireRate || 500;
    this.projectileSpeed = cfg.shooterProjectileSpeed || 500;
    this.fireRange = cfg.shooterFireRange || 400;
    this.enemySpeed = cfg.shooterEnemySpeed || 100;
    this.waveCount = cfg.shooterWaveCount || 5;
    this.enemiesPerWave = cfg.shooterEnemiesPerWave || 4;

    this.worldWidth = cfg.worldWidth || 2000;
    this.worldHeight = cfg.worldHeight || 1500;

    this.currentWave = 0;
    this.fireCooldown = 0;
    this.fireTrigger = false;
    this.mouseAimActive = false;
    this.mouseAiming = false;
    this.moveInput = { up: false, down: false, left: false, right: false };

    this.enemies = null;
    this.projectiles = null;
    this.collectibles = null;
  }

  create() {
    const { scene } = this;
    const player = scene.player;

    // World bounds/camera are already configured by GameManagerScene/cameraManager
    // before this runs — no gravity, full 360° movement, clamped to the arena.
    player.body.setAllowGravity(false);
    player.setCollideWorldBounds(true);
    player.setPosition(this.worldWidth / 2, this.worldHeight / 2);
    player.rotation = -Math.PI / 2; // face "up" by default, matches the art's authored facing

    this.enemies = scene.physics.add.group();
    this.projectiles = scene.physics.add.group({
      classType: Projectile,
      maxSize: 20,
      runChildUpdate: true
    });
    this.collectibles = scene.physics.add.group();

    scene.physics.add.overlap(player, this.enemies, this.handlePlayerEnemyCollision, null, this);

    scene.physics.add.overlap(this.projectiles, this.enemies, (proj, enemy) => {
      scene.fx?.projectileImpact(proj.x, proj.y);
      if (proj.deactivate) proj.deactivate();
      this.damageEnemy(enemy);
    });

    scene.physics.add.overlap(player, this.collectibles, (p, collectible) => {
      if (!collectible || !collectible.active) return;
      const value = scene.gameConfig.coinValue ?? 25;
      scene.fx?.pickup(collectible.x, collectible.y, value);
      this.awardScore(value);
      collectible.destroy();
    });

    this.gameInputListener = (e) => {
      if (!e.detail) return;
      const { action, state } = e.detail;
      const isDown = state === 'down';
      if (action === 'up') this.moveInput.up = isDown;
      else if (action === 'down') this.moveInput.down = isDown;
      else if (action === 'left') this.moveInput.left = isDown;
      else if (action === 'right') this.moveInput.right = isDown;
      else if (action === 'shoot' && isDown) this.fireTrigger = true;
    };
    window.addEventListener('game-input', this.gameInputListener);

    // Mouse aim engages on the first real (non-touch) pointer move — guards
    // against snapping the player to face (0,0) before the mouse has ever
    // moved, and keeps touch devices (which never fire a non-touch move) on
    // the assisted movement-facing/nearest-enemy behavior below.
    this.pointerMoveHandler = (pointer) => {
      if (pointer.wasTouch) return;
      this.mouseAimActive = true;
    };
    scene.input.on('pointermove', this.pointerMoveHandler, this);

    this.resizeListener = (gameSize) => {
      if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => {
        this.handleResize(gameSize);
      }, 150);
    };
    scene.scale.on('resize', this.resizeListener, this);

    this.spawnWave();
  }

  handleResize(gameSize) {
    if (!this.scene || !this.scene.cameras || !this.scene.cameras.main) return;
    const safeWidth = Math.max(1, gameSize.width);
    const safeHeight = Math.max(1, gameSize.height);
    if (this.scene.cameraManager) {
      this.scene.cameraManager.handleResize({ width: safeWidth, height: safeHeight });
    }
  }

  // Places enemies at randomized points on the arena perimeter, clear of the
  // camera's current framing, clamped inside the world bounds.
  spawnWave() {
    const { scene } = this;
    const count = this.enemiesPerWave + this.currentWave;
    const centerX = this.worldWidth / 2;
    const centerY = this.worldHeight / 2;
    const radius = Math.min(this.worldWidth, this.worldHeight) / 2 - 40;
    // Static/keyless path prefers the top-down placeholder figure over the
    // side-view theme sprite (which reads as lying down once rotated).
    const useTopdownPlaceholder = !scene.gameConfig.dynamicAssetUrls && scene.textures.exists('topdown_enemy');
    const enemyTexture = scene.gameConfig.dynamicAssetUrls ? 'dyn_enemy'
      : useTopdownPlaceholder ? 'topdown_enemy'
      : (scene.activeTheme?.enemyTexture || 'dude');

    for (let i = 0; i < count; i++) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const x = Phaser.Math.Clamp(centerX + Math.cos(angle) * radius, 20, this.worldWidth - 20);
      const y = Phaser.Math.Clamp(centerY + Math.sin(angle) * radius, 20, this.worldHeight - 20);

      const enemy = this.enemies.create(x, y, enemyTexture);
      enemy.health = 3;
      enemy.body.setAllowGravity(false);

      if (scene.gameConfig.dynamicAssetUrls) {
        const textureObj = scene.textures.get(enemyTexture);
        const frame = textureObj?.get(0);
        const h = frame ? frame.height : 128;
        enemy.setScale(50 / h);
        enemy.body.setSize(enemy.width, enemy.height);
        enemy.body.setOffset(0, 0);
      } else if (useTopdownPlaceholder) {
        // SVG authored at its in-game size (44px), already red — no tint needed.
        enemy.body.setSize(enemy.width, enemy.height);
        enemy.body.setOffset(0, 0);
      } else {
        enemy.setFrame(5);
        enemy.setTint(0xff0000);
        enemy.body.setSize(20, 42);
        enemy.body.setOffset(6, 6);
      }
      enemy.rotation = -Math.PI / 2;
    }

    this.currentWave += 1;
  }

  update(time, delta) {
    const { scene } = this;
    if (scene.isGameOver || scene.isGamePaused) return;

    const player = scene.player;
    const keys = scene.keyStates || {};
    const pointer = scene.input.activePointer;
    this.mouseAiming = this.mouseAimActive && !pointer.wasTouch;

    let vx = (keys.ArrowRight || keys.KeyD || this.moveInput.right ? 1 : 0)
      - (keys.ArrowLeft || keys.KeyA || this.moveInput.left ? 1 : 0);
    let vy = (keys.ArrowDown || keys.KeyS || this.moveInput.down ? 1 : 0)
      - (keys.ArrowUp || keys.KeyW || this.moveInput.up ? 1 : 0);

    const moving = vx !== 0 || vy !== 0;
    if (moving) {
      const len = Math.hypot(vx, vy);
      vx /= len; vy /= len;
      player.body.setVelocity(vx * this.moveSpeed, vy * this.moveSpeed);
      // Movement drives facing only when nothing is aiming for us — mouse aim
      // (below) overrides it so strafing doesn't spin the player off-target.
      if (!this.mouseAiming) player.rotation = Phaser.Math.Angle.Between(0, 0, vx, vy);
    } else {
      player.body.setVelocity(0, 0);
    }

    // Mouse aim: face the cursor every frame, independent of movement —
    // classic twin-stick feel. Recomputed after movement so it always wins.
    if (this.mouseAiming) {
      player.rotation = Phaser.Math.Angle.Between(player.x, player.y, pointer.worldX, pointer.worldY);
    }

    // Enemy AI: chase the player, rotate to face travel direction (same
    // rotate-at-render-time treatment as the player — locked art decision).
    this.enemies.children.iterate((enemy) => {
      if (!enemy || !enemy.active) return;
      const angle = Phaser.Math.Angle.Between(enemy.x, enemy.y, player.x, player.y);
      enemy.body.setVelocity(Math.cos(angle) * this.enemySpeed, Math.sin(angle) * this.enemySpeed);
      enemy.rotation = angle;
    });

    // Manual fire — F key / click (GameManagerScene) / mobile fire button
    // (gameInputListener above) set the trigger; cooldown still rate-limits it
    // so holding/mashing the trigger can't out-fire fireRate. Mouse aim fires
    // a real directional shot toward the cursor; touch has no cursor, so it
    // falls back to the assisted nearest-enemy shot.
    if (this.fireCooldown > 0) this.fireCooldown -= delta;
    if ((keys._shootTrigger || this.fireTrigger) && this.fireCooldown <= 0) {
      if (this.mouseAiming) {
        this.fireInDirection(player.rotation);
        this.fireCooldown = this.fireRate;
      } else {
        const target = this.findNearestEnemyInRange(player);
        if (target) {
          this.fireAt(target);
          this.fireCooldown = this.fireRate;
        }
      }
    }
    if (scene.keyStates) scene.keyStates._shootTrigger = false;
    this.fireTrigger = false;

    // Wave clear / win condition.
    if (this.enemies.countActive(true) === 0) {
      if (this.currentWave < this.waveCount) {
        this.spawnWave();
      } else if (scene.winGame) {
        scene.winGame();
      }
    }
  }

  findNearestEnemyInRange(player) {
    let nearest = null;
    let nearestDist = this.fireRange;
    this.enemies.children.iterate((enemy) => {
      if (!enemy || !enemy.active) return;
      const dist = Phaser.Math.Distance.Between(player.x, player.y, enemy.x, enemy.y);
      if (dist <= nearestDist) {
        nearestDist = dist;
        nearest = enemy;
      }
    });
    return nearest;
  }

  fireAt(target) {
    this.spawnProjectileToward(target.x, target.y);
  }

  // Mouse-aim fire: no target sprite, just a travel direction — project a
  // point far along it and reuse the same spawn path as fireAt().
  fireInDirection(angle) {
    const player = this.scene.player;
    this.spawnProjectileToward(
      player.x + Math.cos(angle) * this.fireRange,
      player.y + Math.sin(angle) * this.fireRange
    );
  }

  spawnProjectileToward(targetX, targetY) {
    const { scene } = this;
    const player = scene.player;
    const projectile = this.projectiles.get();
    if (!projectile) return;

    const useDynamic = scene.gameConfig.dynamicAssetUrls && scene.textures.exists('dyn_projectile');
    const textureKey = useDynamic ? 'dyn_projectile' : 'projectile';
    projectile.setTexture(textureKey);
    projectile.setScale(useDynamic ? 32 / projectile.frame.width : 1);

    projectile.fireAt(player.x, player.y, targetX, targetY, this.projectileSpeed);
    player.rotation = Phaser.Math.Angle.Between(player.x, player.y, targetX, targetY);
  }

  jump() {
    // No-op — shooter has no jump concept. Inherited BaseMode default is fine
    // too, but kept explicit for clarity since GameManagerScene's Space/W
    // handler unconditionally calls gameModeManager.jump().
  }

  damageEnemy(enemy) {
    if (!enemy || !enemy.active || enemy._dying) return;
    const { scene } = this;

    enemy.health -= 1;
    this.awardScore(10);

    if (enemy.health <= 0) {
      enemy._dying = true;
      if (enemy.body) enemy.body.enable = false;

      scene.fx?.enemyKilled(enemy, 100);
      scene.fx?.hitstop(60);

      scene.tweens.add({
        targets: enemy,
        alpha: 0,
        scaleX: 0,
        scaleY: 0,
        duration: 200,
        ease: 'Power2',
        onComplete: () => {
          if (enemy.scene) this.enemies.remove(enemy, true, true);
        }
      });

      this.awardScore(100);
    } else {
      scene.fx?.enemyHit(enemy);
      enemy.setTintFill(0xffffff);
      scene.time.delayedCall(70, () => {
        if (enemy.active) enemy.setTint(0xff0000);
      });
    }
  }

  handlePlayerEnemyCollision(player, enemy) {
    if (enemy._dying) return;
    this.scene.hitObstacle();
  }

  onConfigUpdate(newConfig) {
    this.moveSpeed = newConfig.shooterMoveSpeed || 260;
    this.fireRate = newConfig.shooterFireRate || 500;
    this.projectileSpeed = newConfig.shooterProjectileSpeed || 500;
    this.fireRange = newConfig.shooterFireRange || 400;
    this.enemySpeed = newConfig.shooterEnemySpeed || 100;
    // Wave/enemy-count changes apply starting the next wave, not mid-wave.
    this.waveCount = newConfig.shooterWaveCount || 5;
    this.enemiesPerWave = newConfig.shooterEnemiesPerWave || 4;
  }

  awardScore(points) {
    if (!points) return;
    this.scene.score += points;
    window.dispatchEvent(new CustomEvent('update-score', { detail: this.scene.score }));
  }

  cleanup() {
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    if (this.resizeListener) this.scene.scale.off('resize', this.resizeListener, this);
    if (this.pointerMoveHandler && this.scene?.input) {
      this.scene.input.off('pointermove', this.pointerMoveHandler, this);
      this.pointerMoveHandler = null;
    }

    if (this.scene && this.scene.cameras && this.scene.cameras.main) {
      this.scene.cameras.main.stopFollow();
      if (this.scene.cameras.main.removeBounds) this.scene.cameras.main.removeBounds();
    }

    if (this.enemies && this.enemies.scene) {
      try { this.enemies.clear(true, true); } catch { /* scene already torn down */ }
    }
    if (this.projectiles && this.projectiles.scene) {
      try { this.projectiles.clear(true, true); } catch { /* scene already torn down */ }
    }
    if (this.collectibles && this.collectibles.scene) {
      try { this.collectibles.clear(true, true); } catch { /* scene already torn down */ }
    }

    if (this.gameInputListener) {
      window.removeEventListener('game-input', this.gameInputListener);
      this.gameInputListener = null;
    }
  }
}
