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
  green: { label: 'chroma key green', hex: '#00FF00', rgb: '0, 255, 0', ban: 'green' },
  magenta: { label: 'chroma key magenta', hex: '#FF00FF', rgb: '255, 0, 255', ban: 'magenta or pink' }
};
// v2 (2026-08-16 prompt overhaul, research-grounded): positive constraint first
// ("one perfectly uniform flat field… covering every pixel"), hex AND RGB anchors
// (the best-evidenced chroma phrasing per practitioner postmortems), the caps
// NO-list kept as belt-and-braces. The `EXACT hex #XXXXXX` token is LOAD-BEARING —
// chromaFromPrompt regexes it to recover the keying color from the prompt text.
export const BG_CLAUSE = (chroma) => {
  const c = CHROMA_KEYS[chroma];
  if (!c) {
    return 'The entire background is one perfectly uniform field of plain pure white, ' +
      'covering every pixel that is not the subject';
  }
  return `The entire background is one perfectly uniform flat field of ${c.label}, ` +
    `EXACT hex ${c.hex} (RGB ${c.rgb}), covering every pixel that is not the subject — ` +
    `NO gradients, NO noise, NO texture, NO shadows, NO vignette, and absolutely no ` +
    `${c.ban} anywhere on the subject itself. The ${c.label} touches the subject's ` +
    `outline directly on every side: NO card, panel, frame, box, label or white ` +
    `rectangle behind or around the subject`;
};
// Character-slot addition to BG_CLAUSE: models routinely paint the ENCLOSED gaps
// (between an arm and the torso, between the legs) white instead of the backdrop
// color — border-flood keying can't reach them, so they ship as white patches
// "inside" the sprite. Ask for the backdrop there explicitly; removeEnclosedPockets
// in postprocess is the deterministic backstop.
export const GAPS_CLAUSE =
  'The background color also completely fills every gap and enclosed space between ' +
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
// The four canonical run-cycle phases (contact-right / pass / contact-left / pass) —
// the single source for the sheet scaffold, the repair rung and the per-frame
// escalation prompts. Reduced from 8 phases on 2026-08-16: eight subtle stride
// phases made image models collapse the poses (no leg swap) and drift the
// character identity across nine cells; four STARKLY contrasted poses is the
// classic retro cycle and a far easier ask. Poses 2 and 4 are the same passing
// pose ON PURPOSE (a real cycle repeats it; they are never IoU-adjacent so the
// duplicate cull — consecutive pairs only — cannot fire on them).
// Eight-phase cycle (restored 2026-08-16 per client direction — the 4-frame
// retro cycle read as too harsh; smoothness comes from PHASE variety at 12fps).
// ARMS FIRST in each pose text (the sheet is an EDIT of the reference sprite,
// and identity pressure makes models copy the reference's arms verbatim unless
// the arm instruction leads the sentence). Live-measured caveat: these models
// draw right-lead strides regardless of mirror instructions (leadingLeg labels
// came back all-'right' on BOTH tiers repeatedly) — leg-lead is judged
// advisory, never escalated; the eight distinct phases carry the motion.
export const RUN_CYCLE_POSES = [
  'LEFT arm swinging forward with a bent elbow and the fist at chest height, RIGHT arm swinging back behind the hip — natural relaxed running arm pump, NOT a punch — RIGHT foot planted on the ground ahead, LEFT leg trailing far behind, a wide running stride',
  'both elbows bent at the sides mid-pump, the body dropping slightly, legs bending as the back foot lifts',
  'both arms pumping close to the body, legs passing directly under the crouched body, knees close together',
  'RIGHT arm swinging forward with a bent elbow, LEFT arm swinging back — the arms mid-swap — airborne with the LEFT knee lifting in front and the RIGHT leg pushing off behind',
  'RIGHT arm swung fully forward with a bent elbow and the fist at chest height, LEFT arm swung back behind the hip — natural relaxed running arm pump, NOT a punch — LEFT foot planted on the ground ahead, RIGHT leg trailing far behind, the stride with the other leg leading',
  'both elbows bent at the sides mid-pump, the body dropping slightly, legs bending as the back foot lifts',
  'both arms pumping close to the body, legs passing directly under the crouched body, knees close together',
  'LEFT arm swinging forward with a bent elbow, RIGHT arm swinging back — the arms mid-swap — airborne with the RIGHT knee lifting in front and the LEFT leg pushing off behind'
];

export const IDLE_POSE =
  'relaxed standing idle stance, both feet planted shoulder-width on the same ground line, ' +
  'arms hanging naturally at the sides with slightly bent elbows, head up, chest out';

export const JUMP_POSE = 'mid-air jump pose with both knees tucked up and arms out for balance';

// Shared sheet-prompt clauses (identity first — see the design note on player_sheet).
const SHEET_IDENTITY_CLAUSE = (count) =>
  `Keep every feature completely unchanged in every frame — same face, same hair, ` +
  `same outfit, same colors, same proportions, same held items — as if one drawing ` +
  `was copied ${count} times and ONLY the arm and leg poses were redrawn.`;
const SHEET_HELD_ITEM_CLAUSE =
  `Any weapon or held item stays gripped in the same hand in every frame and tilts ` +
  `with that arm as it swings.`;
const SHEET_FRAMING_CLAUSE = (chroma) =>
  `The character faces right in side profile in every frame, at the same character ` +
  `size and on the same ground line in every frame, each frame centered in its own ` +
  `equal section with a clear band of empty backdrop separating neighboring frames ` +
  `and a thin margin of backdrop above the character's head in every frame — ` +
  `the characters never touch or overlap each other or the image edges. ` +
  `${BG_CLAUSE(chroma)}, in every single frame. ${GAPS_CLAUSE}. ` +
  `No scenery, no floor, no shadows, no motion lines, no frame borders, no dividers, no text`;

export const SLOT_SPECS = {
  background_far: {
    textureKey: 'dyn_bg_far',
    // 2048×1024 (POT) + imageSize '2K': billing is FLAT per image, so the 2K
    // request is a $0 resolution lever — the ~2688×1512 serve supersamples down
    // instead of the old ~1344×768 serve upscaling ~2× in-game under NEAREST
    // (the "blocky background" complaint). If the model rejects/drops the size
    // field the smaller serve just gets a smooth upscale — no worse than before.
    canvas: { width: 2048, height: 1024 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL, imageSize: '2K' },
    post: { fit: 'cover', keying: null, trimBorder: false, crop: false },
    scaffold: (subject, style) =>
      `Paint a wide side-scrolling video game background: ${subject}. Distant landscape ` +
      `scenery fills the entire frame — no characters, no text, no logo. ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_mid: {
    textureKey: 'dyn_bg_mid',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL },
    // silhouette: content is near-black BY CONTRACT — lets the white-pass
    // dissolve guard trust big white removals (enclosed sky pockets) safely.
    post: { fit: 'cover', keying: 'flood+white', trimBorder: false, crop: false, minAlphaFraction: 0.15, edgeErode: 2, darken: 0.85, silhouette: true },
    qa: { clean: true },
    optional: true,
    subjectKey: 'background_far',
    // Narrative framing, but the contract clauses (blank upper half, "NOT a
    // landscape painting", cutout language) survive VERBATIM — they are the
    // battle-tested defense against the painted-sky failure mode.
    scaffold: (subject, style) =>
      `Draw a flat dark silhouette skyline strip themed after ${subject}. Solid ` +
      `silhouette cutout shapes, like paper cutouts, run along the bottom edge of the ` +
      `frame, reaching at most half the frame height, on a plain pure white background. ` +
      `The entire upper half of the image is completely blank solid white with nothing ` +
      `in it. This is NOT a landscape painting: no scene, no interior, no sky, no ` +
      `clouds, no aurora, no stars, no gradient backdrop of any kind. Seamlessly ` +
      `horizontally tileable, no text. ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  background_near: {
    textureKey: 'dyn_bg_near',
    canvas: { width: 1024, height: 512 },
    gen: { aspectRatio: '16:9', model: GEMINI_SLOT_MODEL },
    // edgeErode 1 (not 2): near props are detailed decor, 2px erosion shreds thin
    // details; bleedEdgeColors still covers the halo
    post: { fit: 'cover', keying: 'flood+white', trimBorder: false, crop: false, minAlphaFraction: 0.15, edgeErode: 1, darken: 0.72, silhouette: true },
    qa: { clean: true },
    optional: true,
    subjectKey: 'background_far',
    scaffold: (subject, style) =>
      `Draw three or four separate standalone decorative props themed after ${subject}, ` +
      `each a distinct isolated object with gaps between them, on a plain pure white ` +
      `background. The props stand on the bottom edge of the frame and stay small, ` +
      `reaching at most one third of the frame height; everything else in the image is ` +
      `completely blank solid white. This is NOT a landscape painting: no scene, no ` +
      `landscape, no sky, no clouds, no aurora, no gradient backdrop of any kind — only ` +
      `the isolated objects themselves. Seamlessly horizontally tileable, no text. ${style}`,
    fallbackSubject: (d) => d?.backgrounds
  },
  floor: {
    textureKey: 'dyn_floor',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: null, trimBorder: true, crop: false },
    scaffold: (subject, style) =>
      `Create a seamless horizontally tileable ground texture: ${subject}, seen from ` +
      `the side as a game terrain block. The left and right edges match perfectly, and ` +
      `the texture fills the whole frame edge to edge — no border, no vignette. ${style}`,
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
      `Draw a single wide flat rectangular floating platform for a 2d video game: ` +
      `${subject}. Seen from the side, the platform spans the full width of the frame ` +
      `from the left edge to the right edge, with a perfectly flat level top surface. ` +
      `${BG_CLAUSE(chroma)}. No shadow, no reflection. ${style}`,
    // Grid-cell variant of the scaffold: same invariants, minus the BG/isolation
    // clause (the combined-props prompt states the backdrop once for all cells).
    cellEssence: (subject, style) =>
      `a single wide flat rectangular floating platform: ${subject}, seen from the ` +
      `side, stretching almost the full width of its cell with a flat level top ` +
      `surface, no shadow, no reflection, ${style}`,
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
      `Draw a single small projectile sprite for a 2d video game: ${subject}, flying ` +
      `to the right as an elongated horizontal shape, side view, centered in the frame. ` +
      `${BG_CLAUSE(chroma)}. No shadow, no motion trail, no text. ${style}`,
    cellEssence: (subject, style) =>
      `a single small projectile sprite: ${subject}, flying to the right as an ` +
      `elongated horizontal shape, side view, centered in its cell, no shadow, ` +
      `no motion trail, ${style}`,
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
      `Draw a single small collectible pickup sprite for a 2d video game: ${subject}. ` +
      `One single object with a simple bold shape that stays readable at tiny size, ` +
      `centered in the frame. ${BG_CLAUSE(chroma)}. No shadow, no sparkle trail, ` +
      `no text. ${style}`,
    cellEssence: (subject, style) =>
      `a single small collectible pickup sprite: ${subject}, one single object with ` +
      `a simple bold shape readable at tiny size, centered in its cell, no shadow, ` +
      `no sparkle trail, ${style}`,
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
      `Draw a 2d video game hero sprite: ${subject}. The character is caught mid-run ` +
      `in a dynamic stride, full body in crisp side profile facing right, a single ` +
      `character filling most of the frame with a sharp clean outline. ` +
      `${BG_CLAUSE(chroma)}. ${GAPS_CLAUSE}. No shadow, no ground, no motion lines, ` +
      `no text. ${style}`,
    fallbackSubject: (d) => d?.player
  },
  enemy: {
    textureKey: 'dyn_enemy',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true, pocketClean: true },
    qa: { facing: true },
    scaffold: (subject, style, { chroma } = {}) =>
      `Draw a 2d video game enemy sprite: ${subject}, prowling to the right, full ` +
      `body in side profile facing right, a single creature filling most of the frame ` +
      `with a sharp clean outline. ${BG_CLAUSE(chroma)}. ${GAPS_CLAUSE}. No shadow, ` +
      `no ground, no motion lines, no text. ${style}`,
    cellEssence: (subject, style) =>
      `a 2d video game enemy sprite: ${subject}, prowling to the right, full body in ` +
      `side profile facing right, a single creature filling most of its cell with a ` +
      `sharp clean outline, no shadow, no ground, no motion lines, ${style}`,
    fallbackSubject: (d) => d?.enemy
  },
  // Animated player run cycle. The local geometry gate + transparency gate reject
  // misaligned grids before they can reach the game. Output is stored under the
  // 'player' slot / dyn_player texture; the game switches to spritesheet
  // registration when meta carries `frames`.
  player_sheet: {
    textureKey: 'dyn_player',
    outputKey: 'player',
    canvas: { width: 1280, height: 128 },
    // All-lite sheet rungs (2026-08-18, client direction "not go to flash"):
    // 3.1-flash-lite bills the same $30/M as 2.5 but is the 3.x family whose
    // character consistency the sheet path depends on. BOTH normal attempts
    // re-roll on this model (the old attempt-2 escalation to 3.1-flash cost
    // ~2× per rung); the pale-chroma rescue + free stain-cull are what make
    // lite rolls survivable. Restore always-premium with localStorage
    // PM_MODEL_SHEET='gemini-3.1-flash-image'.
    // Layout is a HORIZONTAL 1×10 STRIP at 8:1 (2026-08-16, 8-frame cycle
    // restored + idle stance): frames 1-8 run phases, frame 9 idle, frame 10
    // jump. Strips are the community's most reliable sheet layout (no interior
    // cells) and the 3.x family supports extreme ratios natively. sheetLayouts
    // are the slicing CANDIDATES — processSheet picks the one whose detected
    // gutters are emptiest, so a model that ignores 8:1 (the 2.5 fallback, an
    // unsupported ratio → provider drops the field) degrades to grid slicing
    // automatically. usedCells trims trailing extras before scoring; the
    // pipeline always ships a rebuilt 1×N strip. idleFrameIndex is validated
    // deterministically and DROPPED (never fatal) when its cell is bad — the
    // scene falls back to frame 0 for idle.
    gen: { aspectRatio: '8:1', model: GEMINI_SLOT_MODEL, imageSize: '1K' },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: false, minAlphaFraction: 0.3, outline: true, pocketClean: true },
    frames: { cols: 10, rows: 1, runFrameCount: 8, idleFrameIndex: 8, jumpFrameIndex: 9, usedCells: 10 },
    sheetLayouts: [
      { cols: 10, rows: 1, canvas: { width: 1280, height: 128 } },
      // Fallback for an ignored 8:1 request (API default serve is ~1:1): a 5×2
      // grid on a square-ish canvas (cells 128×192 — tall cells are fine,
      // slicing re-centers and the union-crop normalizes).
      { cols: 5, rows: 2, canvas: { width: 640, height: 384 } }
    ],
    fallbackSlot: 'player',
    subjectKey: 'player',
    qa: { facing: true, grid: true },
    // Shared pose descriptors: the sheet scaffold, the repair rung and the
    // per-frame escalation all draw from this single source.
    poses: { run: RUN_CYCLE_POSES, jump: JUMP_POSE },
    // Identity FIRST, choreography second: the failure mode that ships is not
    // "poses too subtle" but "a different-looking character in every cell" — so
    // the prompt leads with copied-five-times identity language, then names the
    // four starkly contrasted stride phases cell by cell. Do NOT demand every
    // cell differ from every OTHER cell: the cycle legitimately repeats its
    // passing pose (cells 2/4), and "dramatically different" pressure makes
    // models redesign the character per cell (regression observed 2026-07-30).
    scaffold: (subject, style, { chroma } = {}) =>
      `Draw one horizontal sprite-sheet strip of ten animation frames, reading left ` +
      `to right, of the EXACT SAME video game character: ${subject}. ` +
      `${SHEET_IDENTITY_CLAUSE('ten')} ` +
      `Frames 1 to 8 are the eight phases of one full running stride cycle: ` +
      RUN_CYCLE_POSES.map((pose, i) => `Frame ${i + 1}: ${pose}. `).join('') +
      `Frame 9: ${IDLE_POSE}. ` +
      `Frame 10: ${JUMP_POSE}. ` +
      `The arms swing opposite to the legs and visibly change position between the ` +
      `stride frames. All ten frames keep consistent proportions and lighting. ` +
      `${SHEET_HELD_ITEM_CLAUSE} ` +
      `${SHEET_FRAMING_CLAUSE(chroma)}. ${style}`,
    fallbackSubject: (d) => d?.player
  },
  obstacle: {
    textureKey: 'dyn_obstacle',
    canvas: { width: 128, height: 128 },
    gen: { aspectRatio: '1:1', model: GEMINI_SLOT_MODEL },
    post: { fit: 'stretch', keying: 'flood', trimBorder: false, crop: true, outline: true },
    scaffold: (subject, style, { chroma } = {}) =>
      `Draw a single hazard object for a 2d video game: ${subject}. It has roughly ` +
      `square proportions, shown from the side, centered in the frame. ` +
      `${BG_CLAUSE(chroma)}. No shadow, no text. ${style}`,
    cellEssence: (subject, style) =>
      `a single hazard object: ${subject}, roughly square proportions, side view, ` +
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
