import RunnerMode from './modes/RunnerMode';
import PlatformerMode from './modes/PlatformerMode';
import ShooterMode from './modes/ShooterMode';
// import DodgeMode from './modes/DodgeMode'; // For later

export default class GameModeManager {
  constructor(scene) {
    this.scene = scene;
    this.activeMode = null;
  }

  setMode(gameType) {
    if (this.activeMode) {
      this.activeMode.cleanup();
    }

    switch (gameType) {
      case 'platformer':
        this.activeMode = new PlatformerMode(this.scene);
        break;
      case 'shooter':
        this.activeMode = new ShooterMode(this.scene);
        break;
      case 'dodge': // placeholder
        this.activeMode = new RunnerMode(this.scene); // fallback for now
        break;
      case 'runner':
      default:
        this.activeMode = new RunnerMode(this.scene);
        break;
    }

    this.activeMode.init();
  }

  create() {
    if (this.activeMode) this.activeMode.create();
  }

  update(time, delta) {
    if (this.activeMode) this.activeMode.update(time, delta);
  }

  handleResize(gameSize) {
    if (this.activeMode && this.activeMode.handleResize) {
      this.activeMode.handleResize(gameSize);
    }
  }

  jump() {
    if (this.activeMode) this.activeMode.jump();
  }

  onConfigUpdate(newConfig, oldConfig) {
    if (this.activeMode) {
       this.activeMode.onConfigUpdate(newConfig, oldConfig);
    }
  }

  cleanup() {
    if (this.activeMode) {
      this.activeMode.cleanup();
      this.activeMode = null;
    }
  }
}
