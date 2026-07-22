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
    optional: true,
    subjectKey: 'background_far',
    scaffold: (subject, style) =>
      `a flat dark silhouette skyline strip themed after ${subject}, solid silhouette ` +
      `cutout shapes like paper cutouts along the bottom edge of the frame, reaching at ` +
      `most half the frame height, on a plain pure white background, everything above the ` +
      `shapes is empty pure white, no scene, no interior, no sky, ` +
      `seamless horizontally tileable, no text, ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_near: {
    textureKey: 'dyn_bg_near',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', pollinations: { width: 1024, height: 576 } },
    post: { fit: 'cover', keying: 'flood+white', trimBorder: false, crop: false, minAlphaFraction: 0.15, edgeErode: 2, darken: 0.72 },
    optional: true,
    subjectKey: 'background_far',
    scaffold: (subject, style) =>
      `three or four separate standalone decorative props themed after ${subject}, each a ` +
      `distinct isolated object with gaps between them, on a plain pure white background, ` +
      `props stand on the bottom edge of the frame, small, reaching at most one third of ` +
      `the frame height, the rest of the image is empty pure white, no scene, no landscape, ` +
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
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    scaffold: (subject, style) =>
      `a single wide flat rectangular floating platform, ${subject}, side view, centered, ` +
      `isolated on a plain pure white background, no shadow, no reflection, ${style}`,
    fallbackSubject: (d) => d?.platforms
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
    scaffold: (subject, style) =>
      `sprite sheet, a 3x3 grid of nine evenly spaced animation frames of the SAME ` +
      `character: ${subject}. Reading left to right, top to bottom, the first eight ` +
      `cells are the eight phases of one full run cycle, each pose clearly different ` +
      `from the previous cell: ` +
      `cell 1 RIGHT foot planted forward on the ground, left leg trailing far behind; ` +
      `cell 2 body low, pushing off, legs passing close together under the body; ` +
      `cell 3 fully airborne, left knee driving up in front, right leg trailing; ` +
      `cell 4 left foot reaching far forward about to land; ` +
      `cell 5 LEFT foot planted forward on the ground, right leg trailing far behind; ` +
      `cell 6 body low, pushing off, legs passing close together under the body; ` +
      `cell 7 fully airborne, right knee driving up in front, left leg trailing; ` +
      `cell 8 right foot reaching far forward about to land; ` +
      `arms always swinging opposite to the legs. ` +
      `The ninth cell (bottom-right) is a mid-air jumping pose with both knees bent. ` +
      `Character facing right in side profile in every cell, identical character size ` +
      `and vertical position in every cell, each character centered in its own grid ` +
      `cell, completely isolated on a plain pure white background in every cell, ` +
      `absolutely no scenery, no environment, no room, no floor, no shadows, no motion ` +
      `lines, nothing behind the character, no grid lines, no borders, no text, ${style}`,
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
