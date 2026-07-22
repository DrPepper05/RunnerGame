import Phaser from 'phaser';
import GameManagerScene from './GameManagerScene';

const config = {
  type: Phaser.AUTO,
  parent: 'phaser-game-container',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  pixelArt: true,
  roundPixels: true,
  input: {
    activePointers: 4,
    keyboard: true,
    mouse: true,
    touch: true
  },
  physics: {
    default: 'arcade',
    arcade: {
       // Global gravity can be default, but we set it per-object anyway
      gravity: { y: 0 },
      debug: false
    }
  }
};

const startGame = (parent) => {
  const game = new Phaser.Game({ ...config, parent });
  game.scene.add('GameManagerScene', GameManagerScene, true);
  window.__PHASER_GAME = game;
  return game;
};

export default startGame;
