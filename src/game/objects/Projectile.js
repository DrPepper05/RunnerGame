import Phaser from 'phaser';

export default class Projectile extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y) {
    // Call the parent constructor with the 'projectile' texture
    super(scene, x, y, 'projectile');

    // Add to the scene
    scene.add.existing(this);

    // Enable physics for this object
    scene.physics.add.existing(this);

    // Default configuration for the body
    if (this.body) {
      this.body.setAllowGravity(false);
      // Optional: adjust the bounding box size if the asset has a lot of empty space
      // this.body.setSize(width, height);
    }

    // Keep track of how long the projectile has been alive
    this.lifespan = 0;
  }

  /**
   * Fires the projectile from a specific location and in a specific direction.
   * @param {number} x - The initial X coordinate.
   * @param {number} y - The initial Y coordinate.
   * @param {boolean} isFacingLeft - True if the projectile should travel left.
   */
  fire(x, y, isFacingLeft) {
    // Reactivate and position the object
    this.setActive(true);
    this.setVisible(true);

    if (this.body) {
      // Re-enable the physics body
      this.body.enable = true;
      this.setPosition(x, y);

      // Adjust the body size to match the current texture dimensions
      this.body.setSize(this.width, this.height);

      const velocityX = isFacingLeft ? -600 : 600;
      this.body.setVelocityX(velocityX);
      this.body.setVelocityY(0);

      // Flip the sprite if the asset is directional
      this.setFlipX(isFacingLeft);
    }

    // Reset lifespan (e.g., live for 2000 milliseconds)
    this.lifespan = 2000;
    this._rotationLocked = false;
  }

  /**
   * Fires the projectile from (x, y) toward an arbitrary target point, rotating
   * the sprite to face its travel direction. Used by top-down modes (Shooter)
   * where motion isn't constrained to left/right, unlike fire().
   * @param {number} x
   * @param {number} y
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} speed
   */
  fireAt(x, y, targetX, targetY, speed = 500) {
    this.setActive(true);
    this.setVisible(true);

    if (this.body) {
      this.body.enable = true;
      this.setPosition(x, y);
      this.body.setSize(this.width, this.height);

      const angle = Phaser.Math.Angle.Between(x, y, targetX, targetY);
      this.body.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
      this.rotation = angle;
    }

    this.lifespan = 2000;
    // preUpdate's texture-based spin logic would otherwise fight this rotation
    // every frame — lock it out for angle-fired projectiles.
    this._rotationLocked = true;
  }

  /**
   * Called automatically by Phaser's update loop if runChildUpdate is true on the group.
   * @param {number} time - The current time.
   * @param {number} delta - The delta time in ms since the last frame.
   */
  preUpdate(time, delta) {
    if (this._rotationLocked) {
      // fireAt() already set the correct travel-facing rotation; leave it alone.
    } else if (this.texture && this.texture.key === 'shuriken') {
      // Shuriken spinning effect
      this.rotation += 0.2;
    } else {
      this.rotation = 0;
    }

    if (this.lifespan > 0) {
      this.lifespan -= delta;

      if (this.lifespan <= 0) {
        this.deactivate();
      }
    }
  }

  /**
   * Deactivates the projectile and hides its physics body, returning it to the pool.
   */
  deactivate() {
    this.setActive(false);
    this.setVisible(false);

    if (this.body) {
      this.body.stop();
      this.body.enable = false;
    }
  }
}
