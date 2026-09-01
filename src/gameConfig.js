export const DEFAULT_CONFIG = {
  gameType: 'runner', // 'runner', 'platformer', 'shooter', 'dodge'
  themeKey: 'ice',
  difficulty: 5,
  runSpeed: 350,
  jumpForce: 750,
  gravity: 1800,
  obstacleDelay: 1200,
  speedIncrement: 0.05,
  playerScale: 1.5,
  obstacleScaleMin: 0.8,
  obstacleScaleMax: 1.2,
  floorHeight: 100,
  floorTileScale: 0.15,
  scoreTimerDelay: 100,
  coinValue: 25, // score awarded per collected coin (both modes)

  // Action Quest (Platformer) specific defaults
  actionJumpHeight: 600,
  actionGravity: 1500,
  actionEnemyCount: 5,
  actionProjectileEnabled: false,

  // Shooter Arena specific defaults. worldWidth/worldHeight are also read by
  // MultiCameraManager.configureFixedArena for the top-down camera bounds.
  shooterMoveSpeed: 260,
  shooterFireRate: 500,
  shooterProjectileSpeed: 500,
  shooterFireRange: 400,
  shooterEnemySpeed: 100,
  shooterWaveCount: 5,
  shooterEnemiesPerWave: 4,
  worldWidth: 2000,
  worldHeight: 1500
};

export const GAME_PRESETS = {
  standard: {
    name: 'Runner',
    gameType: 'runner',
    themeKey: 'ice',
    difficulty: 5,
    runSpeed: 350,
    jumpForce: 750,
    gravity: 1800,
    obstacleDelay: 1200,
  },
  action_quest: {
    name: 'Action Quest',
    gameType: 'platformer',
    themeKey: 'ice',
    difficulty: 5,
    actionJumpHeight: 600,
    actionGravity: 1500,
    actionEnemyCount: 3,
    actionProjectileEnabled: true // Enable by default for action quest now
  },
  shooter_arena: {
    name: 'Shooter Arena',
    gameType: 'shooter',
    themeKey: 'ice',
    difficulty: 5,
    shooterMoveSpeed: 260,
    shooterFireRate: 500,
    shooterProjectileSpeed: 500,
    shooterFireRange: 400,
    shooterEnemySpeed: 100,
    shooterWaveCount: 5,
    shooterEnemiesPerWave: 4,
    worldWidth: 2000,
    worldHeight: 1500
  }
};
