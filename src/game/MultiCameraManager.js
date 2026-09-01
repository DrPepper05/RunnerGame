import Phaser from 'phaser';
import { getGroundLift } from './uiZones';

/**
 * PlayMint Multi-Camera Manager
 * Supports Top-Down Arena, Fixed, Side-Scrolling and Target-Following viewports dynamically.
 *
 * MOBILE CONTROL GUTTER (2026-08-20, contract corrected 2026-08-21). On touch
 * devices the on-screen buttons float over the bottom corners of the canvas. The
 * guarantee is that nothing that stands ON the floor renders under them — the
 * floor band itself is scenery and may sit under the buttons. So the camera
 * lifts the ground only as far as needed for the floor's TOP edge to clear the
 * tallest control (`getGroundLift`), which with today's 47/55px buttons and a
 * 100px floor is 0 on every phone layout: framing is unchanged, and this is a
 * safety net for taller layouts or themes with a short floor. (The first
 * version pinned the floor's BOTTOM above the buttons, lifting the whole floor
 * band and exposing a tall under-floor strip — reverted the same day.)
 *
 * Purely a camera-scroll change: world coordinates, physics bounds,
 * LOGICAL_FLOOR_Y and every spawn position are untouched. The parallax strips
 * re-pin themselves every frame from `LOGICAL_FLOOR_Y - camera.scrollY`.
 */
export default class MultiCameraManager {
  constructor(scene) {
    this.scene = scene;
    this.mode = 'follow-target'; // 'side-scrolling' | 'follow-target' | 'fixed-arena'
    this.target = null;
    this.zoom = 1;
  }

  /**
   * Set active camera mode and targets
   */
  setMode(mode, target = null) {
    this.mode = mode;
    this.target = target;
    const camera = this.scene.cameras.main;

    if (!camera) return;

    // Reset camera state
    camera.stopFollow();
    if (camera.removeBounds) {
      camera.removeBounds();
    }
    camera.setZoom(1);

    switch (mode) {
      case 'side-scrolling':
        this.configureSideScrolling();
        break;
      case 'fixed-arena':
        this.configureFixedArena();
        break;
      case 'follow-target':
      default:
        this.configureFollowTarget();
        break;
    }
  }

  /**
   * Runner scroll offset: floor line pinned to the bottom edge, then lifted by
   * the control gutter. Single source of truth — setMode and handleResize both
   * call this, and they used to carry verbatim copies that could drift apart.
   */
  sideScrollScrollY(height) {
    const floorHeight = this.scene.gameConfig.floorHeight || 100;
    return (this.scene.LOGICAL_FLOOR_Y + floorHeight) - height + getGroundLift(height, floorHeight);
  }

  /**
   * Platformer camera bounds height. Extending the bottom bound by the gutter
   * lets the bottom-clamped camera sit lower, which raises the ground line on
   * screen by exactly that much.
   */
  followBoundsHeight(height) {
    const minHeight = this.scene.LOGICAL_FLOOR_Y + 100;
    const floorHeight = this.scene.gameConfig.floorHeight || 100;
    return Math.max(minHeight, height) + getGroundLift(height, floorHeight);
  }

  configureSideScrolling() {
    const camera = this.scene.cameras.main;
    const height = this.scene.scale.height;

    camera.scrollX = 0;
    camera.scrollY = this.sideScrollScrollY(height);
  }

  configureFollowTarget() {
    if (!this.target) return;
    const camera = this.scene.cameras.main;
    const gameSize = this.scene.scale;
    const boundsHeight = this.followBoundsHeight(gameSize.height);
    const theme = this.scene.activeTheme || {};
    const worldWidth = this.scene.gameConfig.worldWidth || theme.worldWidth || 4000;

    camera.setBounds(0, 0, worldWidth, boundsHeight);
    camera.startFollow(this.target, true, 0.08, 0.08);
    camera.centerOn(this.target.x, this.target.y);
  }

  configureFixedArena() {
    const camera = this.scene.cameras.main;
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;
    
    // Top-down arena dimensions, mapped via config or theme variables
    const worldWidth = this.scene.gameConfig.worldWidth || 2000;
    const worldHeight = this.scene.gameConfig.worldHeight || 1500;

    camera.setBounds(0, 0, worldWidth, worldHeight);

    if (this.target) {
      camera.startFollow(this.target, true, 0.1, 0.1);
      camera.centerOn(this.target.x, this.target.y);
    } else {
      camera.centerOn(worldWidth / 2, worldHeight / 2);
    }

    // COVER zoom (max of the two ratios), never fit: a fit zoom displays a
    // region wider/taller than the arena, and Phaser's bounds clamp then shows
    // raw background beyond the world edge. The 0.5 floor keeps huge arenas
    // readable on small screens (the camera follows the player instead).
    const zoomX = width / worldWidth;
    const zoomY = height / worldHeight;
    const zoomRatio = Math.max(zoomX, zoomY, 0.5);
    camera.setZoom(zoomRatio);
  }

  /**
   * Handle layout sizing adjustments dynamically (e.g. mobile rotation or window scale)
   */
  handleResize(gameSize) {
    const camera = this.scene.cameras.main;
    if (!camera) return;

    const width = Math.max(1, gameSize.width);
    const height = Math.max(1, gameSize.height);

    // Force viewport layout boundary update
    camera.setViewport(0, 0, width, height);

    if (this.mode === 'side-scrolling') {
      camera.scrollX = 0;
      camera.scrollY = this.sideScrollScrollY(height);
    } else if (this.mode === 'follow-target') {
      const boundsHeight = this.followBoundsHeight(height);
      const theme = this.scene.activeTheme || {};
      const worldWidth = this.scene.gameConfig.worldWidth || theme.worldWidth || 4000;
      
      camera.setBounds(0, 0, worldWidth, boundsHeight);
      if (this.target) {
        camera.centerOn(this.target.x, this.target.y);
      }
    } else if (this.mode === 'fixed-arena') {
      const worldWidth = this.scene.gameConfig.worldWidth || 2000;
      const worldHeight = this.scene.gameConfig.worldHeight || 1500;
      camera.setBounds(0, 0, worldWidth, worldHeight);
      
      // Cover zoom — must match configureFixedArena (see comment there).
      const zoomX = width / worldWidth;
      const zoomY = height / worldHeight;
      const zoomRatio = Math.max(zoomX, zoomY, 0.5);
      camera.setZoom(zoomRatio);

      if (this.target) {
        camera.centerOn(this.target.x, this.target.y);
      } else {
        camera.centerOn(worldWidth / 2, worldHeight / 2);
      }
    }
  }

  update(time, delta) {
    // Perform any camera tweening or shake routines here if needed
  }
}
