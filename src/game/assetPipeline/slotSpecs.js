/**
 * Single source of truth for AI-generated asset slots.
 *
 * Every stage of the pipeline (prompt design, provider request, post-processing,
 * Phaser texture registration) reads from these specs. Do not hardcode slot
 * dimensions or texture keys anywhere else.
 */

// Image model tiers (verified against the live docs 2026-08-04). The Gemini 3.x
// image family has far stronger character consistency than legacy 2.5 — the sheet
// path depends on it. providers/geminiImage.js transparently retries on the
// fallback model when a key/region lacks 3.x access (404/not-supported), so these
// IDs are safe to ship without per-key feature detection.
export const GEMINI_SLOT_MODEL = 'gemini-3.1-flash-lite-image'; // static scenery/props — cheaper than legacy 2.5
export const GEMINI_SHEET_MODEL = 'gemini-3.1-flash-image';     // player + sheet + per-frame: the consistency workhorse
export const GEMINI_PRO_SHEET_MODEL = 'gemini-3-pro-image';     // ONE rescue attempt on sheet failure — QUALITY MODE (PM_QUALITY_MODE='1') only
export const GEMINI_IMAGE_FALLBACK_MODEL = 'gemini-2.5-flash-image';
// Rolling alias on purpose: fixed text-model IDs get sunset for new projects
// (gemini-2.5-flash 404s with "no longer available to new users")
export const GEMINI_TEXT_MODEL = 'gemini-flash-latest';

// Chroma-key backgrounds for keyed sprite slots. Green/magenta
// never collide with a sprite palette the way white does (white teeth, eyes,
// highlights sit inside every sprite), and the ALL-CAPS exact-hex phrasing is the
// field-tested way to get a flat keyable field out of image models. promptDesigner
// picks the color per slot so a green subject gets a magenta screen and vice versa.
export const CHROMA_KEYS = {
  green: { label: 'chroma key green', hex: '#00FF00', ban: 'green' },
  magenta: { label: 'chroma key magenta', hex: '#FF00FF', ban: 'magenta or pink' }
};
export const BG_CLAUSE = (chroma) => {
  const c = CHROMA_KEYS[chroma];
  if (!c) return 'isolated on a plain pure white background';
  return `isolated on a solid flat ${c.label} background, EXACT hex ${c.hex}, the entire ` +
    `background one uniform flat color with NO gradients, NO noise, NO texture, NO shadows, ` +
    `and absolutely no ${c.ban} anywhere on the subject itself`;
};
// Character-slot addition to BG_CLAUSE: models routinely paint the ENCLOSED gaps
// (between an arm and the torso, between the legs) white instead of the backdrop
// color — border-flood keying can't reach them, so they ship as white patches
// "inside" the sprite. Ask for the backdrop there explicitly; removeEnclosedPockets
// in postprocess is the deterministic backstop.
export const GAPS_CLAUSE =
  'the background color also completely fills every gap and enclosed space between ' +
  'the limbs and the body';

/**
 * Slot spec shape:
 *  - textureKey        Phaser texture key GameManagerScene registers the image under
 *  - canvas            final post-processed pixel size handed to the game
 *  - gen.aspectRatio   Gemini imageConfig aspect ratio (no 2:1 available; post 'cover' fixes it)
 *  - gen.model         Gemini image model for this slot (falls back per geminiImage.js ladder)
 *  - gen.imageSize     optional Gemini imageConfig size ('0.5K'|'1K'|'2K'|'4K', 3.x only) —
 *                      right-sized to the target canvas to keep cost down (sheet 1K→384px,
 *                      player 0.5K→128px are both still supersampled); a size a model
 *                      rejects is dropped + remembered by providers/geminiImage.js.
 *                      Quality mode (PM_QUALITY_MODE='1') bumps the sheet back to 2K.
 *  - post.fit          'cover' (center-crop to fill) | 'stretch' (fill exactly)
 *  - post.keying       'flood' (border-connected flood fill — handles any backdrop color,
 *                      keeps white pixels inside sprites) | 'white' (legacy threshold) | null.
 *                      No provider outputs alpha, so keying is what creates transparency.
 *  - post.trimBorder   crop model-painted uniform margins at native size before stretching
 *  - post.crop         trim transparent margins after keying (keeps full-texture hitboxes fair)
 *  - post.minAlphaFraction  optional acceptance check for keyed overlay layers
 *  - qa                vision-QA flags, e.g. { facing: true } — checked post-keying
 *  - optional          slot may be dropped on failure instead of failing the run
 *  - subjectKey        reuse another slot's designed subject instead of its own
 *  - scaffold          builds the final prompt: code owns the invariant constraints,
 *                      the designer (LLM or local) only supplies the subject descriptor
 *  - fallbackSubject   picks the subject out of assetDesignDirections when no designer ran
 */
// The eight canonical run-cycle phases (contact/pass/airborne/reach, right lead then
// left lead) — the single source for the 3×3 sheet scaffold and the Gemini
// per-frame escalation prompts.
export const RUN_CYCLE_POSES = [
  'right foot planted on the ground ahead, left leg trailing behind, left arm swung forward, right arm swung back',
  'legs passing close together under the crouched body, arms pumping at the sides',
  'airborne, left knee lifted in front, right leg trailing behind, right arm swung forward',
  'left foot reaching forward about to land, arms passing level',
  'left foot planted on the ground ahead, right leg trailing behind, right arm swung forward, left arm swung back — the same stride as the first contact pose with the legs swapped',
  'legs passing close together under the crouched body, arms pumping at the sides',
  'airborne, right knee lifted in front, left leg trailing behind, left arm swung forward',
  'right foot reaching forward about to land, arms passing level'
];

export const JUMP_POSE = 'mid-air jump pose with both knees tucked up and arms out for balance';

// Shared sheet-prompt clauses (identity first — see the design note on player_sheet).
const SHEET_IDENTITY_CLAUSE = (count) =>
  `IDENTICAL character in every cell — same face, same hair, same outfit, same colors, ` +
  `same proportions, same held items — as if one drawing was copied ${count} times and ` +
  `ONLY the arm and leg poses were redrawn.`;
const SHEET_HELD_ITEM_CLAUSE =
  `Any weapon or held item stays gripped in the same hand in every cell and tilts ` +
  `with that arm as it swings.`;
const SHEET_FRAMING_CLAUSE = (chroma) =>
  `Character faces right in side profile in every cell, same character size and same ` +
  `ground line in every cell, each character centered in its own grid cell, ` +
  `${BG_CLAUSE(chroma)} in every cell, ${GAPS_CLAUSE}, no scenery, no floor, no shadows, ` +
  `no motion lines, no grid lines, no cell borders, no text`;

export const SLOT_SPECS = {
  background_far: {
    textureKey: 'dyn_bg_far',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL },
    post: { fit: 'cover', keying: null, trimBorder: false, crop: false },
    scaffold: (subject, style) =>
      `wide side-scrolling video game background, ${subject}, distant landscape scenery, ` +
      `no characters, no text, no logo, scene fills the entire frame, ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_mid: {
    textureKey: 'dyn_bg_mid',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL },
    post: { fit: 'cover', keying: 'flood+white', trimBorder: false, crop: false, minAlphaFraction: 0.15, edgeErode: 2, darken: 0.85 },
    qa: { clean: true },
    optional: true,
    subjectKey: 'background_far',
    scaffold: (subject, style) =>
      `a flat dark silhouette skyline strip themed after ${subject}, solid silhouette ` +
      `cutout shapes like paper cutouts along the bottom edge of the frame, reaching at ` +
      `most half the frame height, on a plain pure white background, the entire upper ` +
      `half of the image is completely blank solid white with nothing in it, this is NOT ` +
      `a landscape painting: no scene, no interior, no sky, no clouds, no aurora, no ` +
      `stars, no gradient backdrop of any kind, ` +
      `seamless horizontally tileable, no text, ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_near: {
    textureKey: 'dyn_bg_near',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL },
    // edgeErode 1 (not 2): near props are detailed decor, 2px erosion shreds thin
    // details; bleedEdgeColors still covers the halo
    post: { fit: 'cover', keying: 'flood+white', trimBorder: false, crop: false, minAlphaFraction: 0.15, edgeErode: 1, darken: 0.72 },
    qa: { clean: true },
    optional: true,
    subjectKey: 'background_far',
    scaffold: (subject, style) =>
      `three or four separate standalone decorative props themed after ${subject}, each a ` +
      `distinct isolated object with gaps between them, on a plain pure white background, ` +
      `props stand on the bottom edge of the frame, small, reaching at most one third of ` +
      `the frame height, everything else in the image is completely blank solid white, ` +
      `this is NOT a landscape painting: no scene, no landscape, no sky, no clouds, no ` +
      `aurora, no gradient backdrop of any kind, only the isolated objects themselves, ` +
      `seamless horizontally tileable, no text, ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  floor: {
    textureKey: 'dyn_floor',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: null, trimBorder: true, crop: false },
    scaffold: (subject, style) =>
      `seamless horizontally tileable ground texture, ${subject}, side view game terrain block, ` +
      `left and right edges match perfectly, texture fills the whole frame edge to edge, ` +
      `no border, no vignette, ${style}`,
    fallbackSubject: (d) => d?.levelElements
  },
  platform: {
    textureKey: 'dyn_platform',
    canvas: { width: 128, height: 64 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    // fillAfterCrop: the game tiles this texture into a fixed 64×32 physics box —
    // cropped-to-content textures of arbitrary size leave the visible art misaligned
    // with the hitbox. Crop to content, then stretch back to exactly fill the canvas,
    // so the visual and the body rectangle are always the same shape.
    // solidify: stretch each column's art to the full frame height so the texture edge
    // IS the collision edge (rounded pill shapes read as floating off their hitbox)
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, fillAfterCrop: true, solidify: true, outline: true },
    scaffold: (subject, style, { chroma } = {}) =>
      `a single wide flat rectangular floating platform, ${subject}, side view, the ` +
      `platform spans the full width of the frame from the left edge to the right edge, ` +
      `flat level top surface, ${BG_CLAUSE(chroma)}, no shadow, ` +
      `no reflection, ${style}`,
    // Grid-cell variant of the scaffold: same invariants, minus the BG/isolation
    // clause (the combined-props prompt states the backdrop once for all cells).
    cellEssence: (subject, style) =>
      `a single wide flat rectangular floating platform, ${subject}, side view, ` +
      `stretching almost the full width of its cell, flat level top surface, ` +
      `no shadow, no reflection, ${style}`,
    fallbackSubject: (d) => d?.platforms
  },
  // Ranged-attack projectile — generated only for platformer games (runner never
  // shoots). Optional: on failure the game keeps its static SVG bolt.
  projectile: {
    textureKey: 'dyn_projectile',
    canvas: { width: 128, height: 64 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    optional: true,
    scaffold: (subject, style, { chroma } = {}) =>
      `a single small 2d video game projectile sprite, ${subject}, flying to the right, ` +
      `elongated horizontal shape, side view, centered, ${BG_CLAUSE(chroma)}, ` +
      `no shadow, no motion trail, no text, ${style}`,
    cellEssence: (subject, style) =>
      `a single small 2d video game projectile sprite, ${subject}, flying to the ` +
      `right, elongated horizontal shape, side view, centered in its cell, ` +
      `no shadow, no motion trail, ${style}`,
    fallbackSubject: (d) => d?.projectile
  },
  // Score pickup (coins by default, or whatever the player named — "gems", etc.).
  // Both modes spawn collectibles. Optional: on failure the game keeps the static
  // coin.svg, so a dropped slot never blocks a run.
  collectible: {
    textureKey: 'dyn_collectible',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    optional: true,
    scaffold: (subject, style, { chroma } = {}) =>
      `a single small 2d video game collectible pickup sprite, ${subject}, one single ` +
      `object, simple bold shape readable at tiny size, centered, ${BG_CLAUSE(chroma)}, ` +
      `no shadow, no sparkle trail, no text, ${style}`,
    cellEssence: (subject, style) =>
      `a single small 2d video game collectible pickup sprite, ${subject}, one ` +
      `single object, simple bold shape readable at tiny size, centered in its ` +
      `cell, no shadow, no sparkle trail, ${style}`,
    fallbackSubject: (d) => d?.collectibles
  },
  player: {
    textureKey: 'dyn_player',
    canvas: { width: 128, height: 128 },
    // Lite model (2026-08-16 cost flip): billing is flat per image, and the sprite
    // lands on a 128px canvas — the lite render supersamples it fine. The SHEET
    // stays the expensive consistency task; this static base is its identity
    // reference, so if animation quality drops, restore with
    // localStorage PM_MODEL_PLAYER='gemini-3.1-flash-image'.
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL, imageSize: '0.5K' },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true, pocketClean: true },
    qa: { facing: true },
    // Front-loaded pose language ("mid-run stride") avoids stiff standing poses;
    // "no ground, no motion lines" suppresses baked-in floor streaks under runners.
    scaffold: (subject, style, { chroma } = {}) =>
      `2d video game character sprite, ${subject}, running to the right in a dynamic ` +
      `mid-run stride, full body in side profile facing right, single character ` +
      `filling most of the frame, ${BG_CLAUSE(chroma)}, ${GAPS_CLAUSE}, sharp ` +
      `clean outline, no shadow, no ground, no motion lines, no text, ${style}`,
    fallbackSubject: (d) => d?.player
  },
  enemy: {
    textureKey: 'dyn_enemy',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true, pocketClean: true },
    qa: { facing: true },
    scaffold: (subject, style, { chroma } = {}) =>
      `2d video game enemy sprite, ${subject}, prowling to the right, full body in ` +
      `side profile facing right, single creature filling most of the frame, ` +
      `${BG_CLAUSE(chroma)}, ${GAPS_CLAUSE}, sharp clean outline, no shadow, no ground, ` +
      `no motion lines, no text, ${style}`,
    cellEssence: (subject, style) =>
      `2d video game enemy sprite, ${subject}, prowling to the right, full body in ` +
      `side profile facing right, single creature filling most of its cell, sharp ` +
      `clean outline, no shadow, no ground, no motion lines, ${style}`,
    fallbackSubject: (d) => d?.enemy
  },
  // Animated player run cycle. The local geometry gate + transparency gate reject
  // misaligned grids before they can reach the game. Output is stored under the
  // 'player' slot / dyn_player texture; the game switches to spritesheet
  // registration when meta carries `frames`.
  player_sheet: {
    textureKey: 'dyn_player',
    outputKey: 'player',
    canvas: { width: 384, height: 384 },
    // Cheap-first sheet rung (2026-08-16 cost flip, revised same day after 2.5
    // shipped a no-leg-swap cycle): 3.1-flash-lite bills the same $30/M as 2.5
    // but is the 3.x family whose character consistency the sheet path depends
    // on. The pipeline's attempt 2 ESCALATES to GEMINI_SHEET_MODEL (3.1-flash)
    // whenever a gate — including the legsAlternate vision gate — rejects the
    // cheap tier, so premium is paid only on failure. Restore always-premium with
    // localStorage PM_MODEL_SHEET='gemini-3.1-flash-image'.
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL, imageSize: '1K' },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: false, minAlphaFraction: 0.3, outline: true, pocketClean: true },
    // Cells 0-7 (row-major) = full run cycle with alternating legs; cell 8 = jump pose
    frames: { cols: 3, rows: 3, runFrameCount: 8, jumpFrameIndex: 8 },
    fallbackSlot: 'player',
    subjectKey: 'player',
    qa: { facing: true, grid: true },
    // Shared pose descriptors: the 3×3 scaffold and the Gemini per-frame
    // escalation both draw from this single source.
    poses: { run: RUN_CYCLE_POSES, jump: JUMP_POSE },
    // The eight canonical run-cycle phases are named cell by cell — an abstract
    // "alternating legs" instruction produces eight near-identical poses; explicit
    // per-cell choreography (contact/down/passing/up, right lead then left lead)
    // is what actually makes the legs swap.
    // Identity FIRST, choreography second: the failure mode that ships is not "poses
    // too subtle" but "a different-looking character in every cell" — so the prompt
    // leads with copied-nine-times identity language, then gives the eight canonical
    // run phases cell by cell (contact/pass/airborne/reach, right lead then left
    // lead). Do NOT demand every cell differ from every OTHER cell: a run cycle
    // legitimately repeats its passing poses (cells 2/6), and "dramatically
    // different" pressure makes models redesign the character per cell.
    scaffold: (subject, style, { chroma } = {}) =>
      `sprite sheet, a 3x3 grid of nine animation frames of the EXACT SAME video game ` +
      `character: ${subject}. ${SHEET_IDENTITY_CLAUSE('nine')} ` +
      `Reading left to right, top to bottom, cells 1 to 8 are the eight phases of one ` +
      `full running stride: ` +
      RUN_CYCLE_POSES.map((pose, i) => `cell ${i + 1}: ${pose}; `).join('') +
      `cell 9 (bottom-right): ${JUMP_POSE}. ` +
      `${SHEET_HELD_ITEM_CLAUSE} ` +
      `${SHEET_FRAMING_CLAUSE(chroma)}, ${style}`,
    fallbackSubject: (d) => d?.player
  },
  obstacle: {
    textureKey: 'dyn_obstacle',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    scaffold: (subject, style, { chroma } = {}) =>
      `a single hazard object, ${subject}, roughly square proportions, side view, centered, ` +
      `${BG_CLAUSE(chroma)}, no shadow, no text, ${style}`,
    cellEssence: (subject, style) =>
      `a single hazard object, ${subject}, roughly square proportions, side view, ` +
      `centered in its cell, no shadow, ${style}`,
    fallbackSubject: (d) => d?.hazards
  }
};

// Combined-props call (PM_GRID_PROPS): several small chroma-keyed sprites rendered
// as ONE grid image, sliced content-aware, each cell then run through its slot's
// normal single-slot pipeline. Under Gemini's flat-per-image billing this is the
// dominant cost lever (4-5 lite calls → 1). cellOrder is the canonical cell
// sequence — the prompt, the slice loop and the fallback wiring all follow it.
export const PROPS_GRID_SPEC = {
  gen: { model: GEMINI_SLOT_MODEL },
  layouts: {
    3: { cols: 3, rows: 1, aspectRatio: '16:9', emptyCells: 0 },
    4: { cols: 2, rows: 2, aspectRatio: '1:1', emptyCells: 0 },
    5: { cols: 3, rows: 2, aspectRatio: '3:2', emptyCells: 1 }
  },
  cellOrder: ['platform', 'enemy', 'obstacle', 'collectible', 'projectile']
};

export const BASELINE_SLOTS = ['background_far', 'floor', 'platform', 'player', 'enemy', 'obstacle'];

// Full generation set: baseline + optional parallax layers.
export const GENERATED_SLOTS = [...BASELINE_SLOTS, 'background_mid', 'background_near'];
