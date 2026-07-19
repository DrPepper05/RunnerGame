import Phaser from 'phaser';

/**
 * PlayMint Multi-Camera Manager
 * Supports Top-Down Arena, Fixed, Side-Scrolling and Target-Following viewports dynamically.
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

  configureSideScrolling() {
    const camera = this.scene.cameras.main;
    const height = this.scene.scale.height;
    const floorHeight = this.scene.gameConfig.floorHeight || 100;
    
    camera.scrollX = 0;
    // Align camera Y scroll so the static floor line sits exactly at the bottom border
    camera.scrollY = (this.scene.LOGICAL_FLOOR_Y + floorHeight) - height;
  }

  configureFollowTarget() {
    if (!this.target) return;
    const camera = this.scene.cameras.main;
    const gameSize = this.scene.scale;
    const minHeight = this.scene.LOGICAL_FLOOR_Y + 100;
    const boundsHeight = Math.max(minHeight, gameSize.height);
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

    // Set scale zoom factor to fully fit the action screen space on smaller displays
    const zoomX = width / worldWidth;
    const zoomY = height / worldHeight;
    const zoomRatio = Math.max(0.5, Math.min(zoomX, zoomY, 1.25));
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
      const floorHeight = this.scene.gameConfig.floorHeight || 100;
      camera.scrollX = 0;
      camera.scrollY = (this.scene.LOGICAL_FLOOR_Y + floorHeight) - height;
    } else if (this.mode === 'follow-target') {
      const minHeight = this.scene.LOGICAL_FLOOR_Y + 100;
      const boundsHeight = Math.max(minHeight, height);
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
      
      const zoomX = width / worldWidth;
      const zoomY = height / worldHeight;
      const zoomRatio = Math.max(0.5, Math.min(zoomX, zoomY, 1.25));
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
