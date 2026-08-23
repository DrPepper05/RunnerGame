/**
 * Impact feedback (added 2026-08-20).
 *
 * Before this module the game had almost no feel: no camera shake, no flash, no
 * hit pause, no pickup response — a fatal collision simply froze physics and
 * put a React overlay on screen, and the only "particles" anywhere were eight
 * hand-rolled rectangles in the enemy death path. (There is still no audio;
 * sound is a later milestone.)
 *
 * Design rules this module follows:
 *  · Readable over spectacular. Shake stays small enough to keep a phone screen
 *    playable — the brief is "clean and readable", not "screen goes berserk".
 *  · Never tween the player's `angle`. Pixel-art characters read as broken when
 *    rotated (the old tilt-bob fallback proved it — removed 2026-08-23), and
 *    SpriteAlignmentManager owns the player's transform. Scale, tint and
 *    position only.
 *  · Scale effects are relative and yoyo back, so they land exactly on the
 *    sprite's configured scale (dynamic players are scaled to 64/frameHeight,
 *    static ones by playerScale — an absolute tween would break one of them).
 *  · Everything is tween/particle/camera based, so the existing pause plumbing
 *    (anims.pauseAll + tweens.pauseAll) freezes it for free.
 */

const DOT_TEXTURE = 'pm_fx_dot';

export default class HitFx {
  constructor(scene) {
    this.scene = scene;
    this.ensureDotTexture();
  }

  // A 6x6 white dot, tinted per burst. Generated rather than shipped: it costs
  // nothing and avoids another file the asset pipeline would have to know about.
  ensureDotTexture() {
    if (this.scene.textures.exists(DOT_TEXTURE)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 6, 6);
    g.generateTexture(DOT_TEXTURE, 6, 6);
    g.destroy();
  }

  get camera() {
    return this.scene.cameras?.main || null;
  }

  shake(intensity = 0.004, duration = 120) {
    this.camera?.shake(duration, intensity, false);
  }

  flash(r = 255, g = 60, b = 60, duration = 150) {
    this.camera?.flash(duration, r, g, b, false);
  }

  /** White-out a sprite briefly, then restore whatever tint it had. */
  flashSprite(sprite, ms = 90, color = 0xffffff) {
    if (!sprite || !sprite.active || !sprite.setTintFill) return;
    const hadTint = sprite.isTinted ? sprite.tintTopLeft : null;
    sprite.setTintFill(color);
    this.scene.time.delayedCall(ms, () => {
      if (!sprite.active) return;
      if (hadTint != null) sprite.setTint(hadTint);
      else sprite.clearTint();
    });
  }

  /**
   * A short freeze on impact. Physics only — tweens and the scene clock keep
   * running so the flash and shake still play during the pause, which is what
   * makes the hit read as a hit rather than as a dropped frame.
   */
  hitstop(ms = 90) {
    const world = this.scene.physics?.world;
    if (!world || world.isPaused) return;
    world.pause();
    this.scene.time.delayedCall(ms, () => {
      // Never un-pause a run that ended (or was paused by the menu) meanwhile.
      if (this.scene.isGameOver || this.scene.isGamePaused) return;
      this.scene.physics.world.resume();
    });
  }

  burst(x, y, { color = 0xffffff, count = 10, speed = 200, lifespan = 420, gravityY = 320, scale = 1 } = {}) {
    if (!this.scene.add) return;
    const emitter = this.scene.add.particles(x, y, DOT_TEXTURE, {
      speed: { min: speed * 0.3, max: speed },
      angle: { min: 0, max: 360 },
      scale: { start: scale, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan,
      gravityY,
      tint: color,
      emitting: false
    });
    emitter.setDepth(100);
    emitter.explode(count);
    this.scene.time.delayedCall(lifespan + 200, () => emitter.destroy());
  }

  /** Rising, fading label in world space — score gains, mostly. */
  popText(x, y, text, color = '#ffffff') {
    if (!this.scene.add) return;
    const label = this.scene.add.text(x, y, String(text), {
      fontFamily: 'Outfit, Inter, sans-serif',
      fontSize: '20px',
      fontStyle: 'bold',
      color,
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5, 1).setDepth(101);
    this.scene.tweens.add({
      targets: label,
      y: y - 46,
      alpha: 0,
      duration: 650,
      ease: 'Cubic.easeOut',
      onComplete: () => label.destroy()
    });
  }

  /**
   * Relative squash/stretch that always returns to the sprite's own scale.
   *
   * Two hard rules, both learned from a live regression (2026-08-21: the player
   * flattened to a streak a few pixels tall):
   *
   *  1. ONE pulse per sprite, restoring to the sprite's TRUE base scale. The
   *     first version captured `base` from the CURRENT scale, so a pulse that
   *     started while another was mid-squash inherited — and then restored to —
   *     the squashed value. Every overlap ratcheted the resting scale flatter.
   *
   *  2. The physics body's BOTTOM must not move. Arcade bodies rescale with the
   *     sprite and are positioned from its origin, so squashing a centre-origin
   *     sprite (every static theme player) from the middle lifts the body off the
   *     floor by a few px → gravity drops it → `touching.down` flickers → the
   *     landing edge fires AGAIN → another squash → forever. That loop is what
   *     fed rule 1's ratchet. We keep the bottom fixed by shifting `y` by the
   *     exact amount the scale change would have moved it (a DELTA each tween
   *     tick, so physics movement during a takeoff stretch is preserved; Arcade
   *     re-derives the body from the sprite each preUpdate and resets `prev`, so
   *     the nudge never turns into velocity). Feet stay glued for ANY origin.
   */
  pulse(sprite, sx = 1.18, sy = 0.82, duration = 90) {
    if (!sprite || !sprite.active || !this.scene.tweens) return;

    // Rule 1 — a pulse already running owns the true base; stop it and restore
    // before starting over, so the new pulse starts from (and returns to) truth.
    if (sprite.__fxPulse) {
      sprite.__fxPulse.remove();
      sprite.__fxPulse = null;
      if (sprite.__fxBase) sprite.setScale(sprite.__fxBase.x, sprite.__fxBase.y);
    }
    const base = { x: sprite.scaleX, y: sprite.scaleY };
    sprite.__fxBase = base;

    // Rule 2 — bodyBottom = y + scaleY * K. For a plain sprite K = (1-originY)*h;
    // with an Arcade body its offset/source size take part.
    const body = sprite.body;
    const K = body && typeof body.sourceHeight === 'number'
      ? (body.offset.y - sprite.displayOriginY + body.sourceHeight)
      : (1 - sprite.originY) * sprite.height;
    let prevScaleY = base.y;

    const tween = this.scene.tweens.add({
      targets: sprite,
      scaleX: base.x * sx,
      scaleY: base.y * sy,
      duration,
      yoyo: true,
      ease: 'Quad.easeOut',
      onUpdate: () => {
        if (!sprite.active) return;
        const dy = (sprite.scaleY - prevScaleY) * K;
        if (dy) sprite.y -= dy;
        prevScaleY = sprite.scaleY;
      },
      onComplete: () => {
        if (sprite.__fxPulse === tween) sprite.__fxPulse = null;
        if (!sprite.active) return;
        // Exact restore (yoyo can land a hair off), bottom included.
        const dy = (base.y - sprite.scaleY) * K;
        sprite.setScale(base.x, base.y);
        if (dy) sprite.y -= dy;
      }
    });
    sprite.__fxPulse = tween;
  }

  // ── Composed beats ─────────────────────────────────────────────────────────

  /** Fatal hit. The loudest thing in the game, deliberately. */
  playerHit(player, x, y) {
    this.flash(220, 50, 50, 170);
    this.shake(0.009, 220);
    this.flashSprite(player, 140);
    this.burst(x ?? player?.body?.center?.x ?? player?.x, y ?? player?.body?.center?.y ?? player?.y, {
      color: 0xff5555, count: 14, speed: 260, scale: 1.2
    });
  }

  /**
   * Non-fatal enemy damage: replaces a tween that animated no property at all.
   * Deliberately does NOT touch tint — a damaged enemy stays tinted red as a
   * state marker, which is gameplay information, not an effect, so its owner
   * (PlatformerMode.damageEnemy) keeps control of it.
   */
  enemyHit(enemy, impactX, impactY) {
    this.pulse(enemy, 1.25, 0.8, 70);
    this.shake(0.0025, 70);
    this.burst(impactX ?? enemy.x, impactY ?? enemy.y, {
      color: 0xffdd55, count: 6, speed: 150, lifespan: 300, scale: 0.8
    });
  }

  enemyKilled(enemy, points) {
    this.shake(0.004, 110);
    this.burst(enemy.x, enemy.y, { color: 0xff4444, count: 14, speed: 240, scale: 1.1 });
    if (points) this.popText(enemy.x, enemy.y - 20, `+${points}`, '#FFD166');
  }

  /** Highest-frequency feedback in the game, and it had none at all. */
  pickup(x, y, points) {
    this.burst(x, y, { color: 0xffd54a, count: 8, speed: 130, lifespan: 340, gravityY: -40, scale: 0.7 });
    if (points) this.popText(x, y - 10, `+${points}`, '#FFD166');
  }

  projectileImpact(x, y) {
    this.burst(x, y, { color: 0xaad4ff, count: 5, speed: 130, lifespan: 260, gravityY: 0, scale: 0.7 });
  }

  landing(x, y) {
    this.burst(x, y, { color: 0xdddddd, count: 5, speed: 90, lifespan: 300, gravityY: 120, scale: 0.6 });
  }
}
