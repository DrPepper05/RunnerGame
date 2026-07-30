/**
 * Single source of truth for AI-generated asset slots.
 *
 * Every stage of the pipeline (prompt design, provider request, post-processing,
 * Phaser texture registration) reads from these specs. Do not hardcode slot
 * dimensions or texture keys anywhere else.
 */

export const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
// Rolling alias on purpose: fixed text-model IDs get sunset for new projects
// (gemini-2.5-flash 404s with "no longer available to new users")
export const GEMINI_TEXT_MODEL = 'gemini-flash-latest';

/**
 * Slot spec shape:
 *  - textureKey        Phaser texture key GameManagerScene registers the image under
 *  - canvas            final post-processed pixel size handed to the game
 *  - gen.aspectRatio   Gemini imageConfig aspect ratio (no 2:1 available; post 'cover' fixes it)
 *  - gen.pollinations  width/height query params for the Pollinations fallback URL
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
export const SLOT_SPECS = {
  background_far: {
    textureKey: 'dyn_bg_far',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', pollinations: { width: 1024, height: 576 } },
    post: { fit: 'cover', keying: null, trimBorder: false, crop: false },
    scaffold: (subject, style) =>
      `wide side-scrolling video game background, ${subject}, distant landscape scenery, ` +
      `no characters, no text, no logo, scene fills the entire frame, ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_mid: {
    textureKey: 'dyn_bg_mid',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', pollinations: { width: 1024, height: 576 } },
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
    gen: { aspectRatio: '16:9', pollinations: { width: 1024, height: 576 } },
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
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 128 } },
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
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 64 } },
    // fillAfterCrop: the game tiles this texture into a fixed 64×32 physics box —
    // cropped-to-content textures of arbitrary size leave the visible art misaligned
    // with the hitbox. Crop to content, then stretch back to exactly fill the canvas,
    // so the visual and the body rectangle are always the same shape.
    // solidify: stretch each column's art to the full frame height so the texture edge
    // IS the collision edge (rounded pill shapes read as floating off their hitbox)
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, fillAfterCrop: true, solidify: true, outline: true },
    scaffold: (subject, style) =>
      `a single wide flat rectangular floating platform, ${subject}, side view, the ` +
      `platform spans the full width of the frame from the left edge to the right edge, ` +
      `flat level top surface, isolated on a plain pure white background, no shadow, ` +
      `no reflection, ${style}`,
    fallbackSubject: (d) => d?.platforms
  },
  // Ranged-attack projectile — generated only for platformer games (runner never
  // shoots). Optional: on failure the game keeps its static SVG bolt.
  projectile: {
    textureKey: 'dyn_projectile',
    canvas: { width: 128, height: 64 },
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 64 } },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    optional: true,
    scaffold: (subject, style) =>
      `a single small 2d video game projectile sprite, ${subject}, flying to the right, ` +
      `elongated horizontal shape, side view, centered, isolated on a plain pure white ` +
      `background, no shadow, no motion trail, no text, ${style}`,
    fallbackSubject: (d) => d?.projectile
  },
  player: {
    textureKey: 'dyn_player',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 128 } },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    qa: { facing: true },
    // Pose language matters most on the free model (sana): without "mid-run stride"
    // it produces stiff standing poses; "no ground, no motion lines" suppresses the
    // baked-in floor streaks it loves to add under runners.
    scaffold: (subject, style) =>
      `2d video game character sprite, ${subject}, running to the right in a dynamic ` +
      `mid-run stride, full body in side profile facing right, single character ` +
      `filling most of the frame, isolated on a plain pure white background, sharp ` +
      `clean outline, no shadow, no ground, no motion lines, no text, ${style}`,
    fallbackSubject: (d) => d?.player
  },
  enemy: {
    textureKey: 'dyn_enemy',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 128 } },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    qa: { facing: true },
    scaffold: (subject, style) =>
      `2d video game enemy sprite, ${subject}, prowling to the right, full body in ` +
      `side profile facing right, single creature filling most of the frame, isolated ` +
      `on a plain pure white background, sharp clean outline, no shadow, no ground, ` +
      `no motion lines, no text, ${style}`,
    fallbackSubject: (d) => d?.enemy
  },
  // Animated player run cycle. Gemini is the reliable producer; the free fallback
  // (sana) gets ONE bonus attempt — its sheets keep a consistent character often
  // enough to try, and the local geometry gate + transparency gate reject misaligned
  // grids before they can reach the game. Output is stored under the 'player' slot /
  // dyn_player texture; the game switches to spritesheet registration when meta
  // carries `frames`.
  player_sheet: {
    textureKey: 'dyn_player',
    outputKey: 'player',
    canvas: { width: 384, height: 384 },
    gen: { aspectRatio: '1:1', pollinations: { width: 384, height: 384 } },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: false, minAlphaFraction: 0.3, outline: true },
    // Cells 0-7 (row-major) = full run cycle with alternating legs; cell 8 = jump pose
    frames: { cols: 3, rows: 3, runFrameCount: 8, jumpFrameIndex: 8 },
    fallbackSlot: 'player',
    subjectKey: 'player',
    qa: { facing: true, grid: true },
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
    scaffold: (subject, style) =>
      `sprite sheet, a 3x3 grid of nine animation frames of the EXACT SAME video game ` +
      `character: ${subject}. IDENTICAL character in every cell — same face, same hair, ` +
      `same outfit, same colors, same proportions, same held items — as if one drawing ` +
      `was copied nine times and ONLY the arm and leg poses were redrawn. ` +
      `Reading left to right, top to bottom, cells 1 to 8 are the eight phases of one ` +
      `full running stride: ` +
      `cell 1: right foot planted on the ground ahead, left leg trailing behind, left arm swung forward, right arm swung back; ` +
      `cell 2: legs passing close together under the crouched body, arms pumping at the sides; ` +
      `cell 3: airborne, left knee lifted in front, right leg trailing behind, right arm swung forward; ` +
      `cell 4: left foot reaching forward about to land, arms passing level; ` +
      `cell 5: left foot planted on the ground ahead, right leg trailing behind, right arm swung forward, left arm swung back — the same stride as cell 1 with the legs swapped; ` +
      `cell 6: legs passing close together under the crouched body, arms pumping at the sides; ` +
      `cell 7: airborne, right knee lifted in front, left leg trailing behind, left arm swung forward; ` +
      `cell 8: right foot reaching forward about to land, arms passing level; ` +
      `cell 9 (bottom-right): mid-air jump pose with both knees tucked up and arms out for balance. ` +
      `Any weapon or held item stays gripped in the same hand in every cell and tilts ` +
      `with that arm as it swings. ` +
      `Character faces right in side profile in every cell, same character size and same ` +
      `ground line in every cell, each character centered in its own grid cell, isolated ` +
      `on a plain pure white background in every cell, no scenery, no floor, no shadows, ` +
      `no motion lines, no grid lines, no cell borders, no text, ${style}`,
    fallbackSubject: (d) => d?.player
  },
  obstacle: {
    textureKey: 'dyn_obstacle',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', pollinations: { width: 128, height: 128 } },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    scaffold: (subject, style) =>
      `a single hazard object, ${subject}, roughly square proportions, side view, centered, ` +
      `isolated on a plain pure white background, no shadow, no text, ${style}`,
    fallbackSubject: (d) => d?.hazards
  }
};

export const BASELINE_SLOTS = ['background_far', 'floor', 'platform', 'player', 'enemy', 'obstacle'];

// Full generation set: baseline + optional parallax layers. Path B raw-URL fallbacks
// (compileFallbackUrls / share links) intentionally stay on BASELINE_SLOTS — that path
// has no keying, so mid/near would render as opaque rectangles covering the far layer.
export const GENERATED_SLOTS = [...BASELINE_SLOTS, 'background_mid', 'background_near'];
