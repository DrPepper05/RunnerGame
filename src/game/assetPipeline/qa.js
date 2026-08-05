/**
 * Vision QA for generated sprites.
 *
 * A cheap gemini-flash-latest multimodal call inspects the FINAL post-processed sprite
 * and reports facing + background cleanliness (and grid consistency for sprite sheets).
 * The pipeline uses the verdict to mirror client-side or re-key/regenerate.
 *
 * Contract: NEVER throws and never fails a slot — any error returns null and the
 * pipeline proceeds unverified (the in-game pixel heuristic keeps working as before).
 */
import { generateJson, isGeminiConfigured } from './providers/geminiImage';

const SPRITE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    facingRight: { type: 'BOOLEAN', description: 'Is the character/creature facing to the RIGHT of the image?' },
    backgroundClean: { type: 'BOOLEAN', description: 'Is the area around the subject fully transparent/empty (no leftover backdrop, frame, or color field)?' }
  },
  required: ['facingRight', 'backgroundClean']
};

// Parallax layers fail differently than sprites: the model paints "props" as framed
// rectangular vignettes (mini landscape paintings), which keep enough transparency
// between them to pass the deterministic gates but read as ugly floating rectangles
// in-game. Only vision can tell a cutout object from a picture-of-an-object.
const LAYER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    backgroundClean: { type: 'BOOLEAN', description: 'Is everything outside the shapes fully transparent/empty (no leftover backdrop or color field)?' },
    cutoutShapes: { type: 'BOOLEAN', description: 'Do the opaque areas consist ONLY of irregular cutout silhouettes/objects? Answer false if any opaque area is a rectangular panel, framed picture, painted sky patch, or full scene.' }
  },
  required: ['backgroundClean', 'cutoutShapes']
};

// Numbered-filmstrip review: the frames are laid out side by side with painted frame
// numbers, so the model can name WHICH frames break the animation instead of failing
// the whole strip — per-frame verdicts feed the culling/repair loop.
const STRIP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    facingRight: { type: 'BOOLEAN', description: 'Does the character face the RIGHT side of the image in the frames?' },
    sameCharacter: { type: 'BOOLEAN', description: 'Is every numbered frame clearly the SAME character (same design, colors, outfit)?' },
    legsAlternate: { type: 'BOOLEAN', description: 'Across the run frames, do some frames show the LEFT leg leading and others the RIGHT leg leading?' },
    badFrames: {
      type: 'ARRAY',
      items: { type: 'INTEGER' },
      description: 'Frame numbers (1-based) that break the animation: a different-looking character, corrupted/incomplete drawing, wrong pose family, or leftover backdrop. Empty when all frames are fine.'
    }
  },
  required: ['facingRight', 'sameCharacter', 'legsAlternate']
};

const SHEET_SCHEMA = {
  type: 'OBJECT',
  properties: {
    facingRight: { type: 'BOOLEAN' },
    backgroundClean: { type: 'BOOLEAN' },
    gridConsistent: { type: 'BOOLEAN', description: 'Does the image contain a grid of frames showing the SAME character at similar size and position in every cell?' },
    legsAlternate: { type: 'BOOLEAN', description: 'Across the run frames, do some frames show the LEFT leg leading and others the RIGHT leg leading (a real alternating run cycle, not the same pose repeated)?' }
  },
  required: ['facingRight', 'backgroundClean', 'gridConsistent', 'legsAlternate']
};

function buildPrompt(kind, grid) {
  if (kind === 'strip') {
    const count = grid?.frameCount || 0;
    const runCount = grid?.runFrameCount || count;
    const jumpNote = count > runCount
      ? ` Frame ${count} is a separate JUMP pose (knees tucked) — different from the run frames by design, only flag it if it shows a different character or corrupted art.`
      : '';
    return (
      `This image is a numbered filmstrip of ${count} animation frames (numbers painted under each ` +
      `frame) of ONE game character's run cycle, frames 1 to ${runCount} in stride order.${jumpNote} ` +
      'Answer strictly:\n' +
      '- facingRight: does the character face the RIGHT side of the image?\n' +
      '- sameCharacter: is every frame clearly the same character — same face, colors, outfit, held items?\n' +
      '- legsAlternate: across the run frames, do some frames show the LEFT leg leading and others the RIGHT?\n' +
      '- badFrames: list the frame NUMBERS that break the animation (different-looking character, ' +
      'corrupted or incomplete drawing, leftover backdrop patch). Use an empty list when all frames are fine — ' +
      'normal pose differences between stride phases are NOT bad frames.'
    );
  }
  if (kind === 'sheet') {
    const cols = grid?.cols || 2;
    const rows = grid?.rows || 2;
    const cells = cols * rows;
    return (
      `This image should be a ${cols}x${rows} sprite sheet: ${cells} animation frames of the SAME game ` +
      'character on a transparent background (shown as checkerboard or empty). Answer strictly:\n' +
      '- facingRight: is the character facing the RIGHT side of the image in the frames?\n' +
      '- backgroundClean: is everything outside the character transparent/empty, with no ' +
      'leftover backdrop color, border, or grid lines?\n' +
      `- gridConsistent: are there ${cells} cells with the same character at similar ` +
      'scale and vertical position in each?\n' +
      '- legsAlternate: looking at the run frames, do some frames clearly show the LEFT ' +
      'leg leading while others show the RIGHT leg leading? Answer false if the same ' +
      'pose repeats or the legs never swap.'
    );
  }
  if (kind === 'layer') {
    return (
      'This image should be a decorative parallax strip for a side-scrolling game: only ' +
      'isolated cutout shapes (silhouettes, props, objects) on a transparent background ' +
      '(shown as checkerboard or empty). Answer strictly:\n' +
      '- backgroundClean: is everything outside the shapes transparent/empty, with no ' +
      'leftover backdrop color or color field?\n' +
      '- cutoutShapes: are ALL opaque areas irregular object/silhouette cutouts? Answer ' +
      'false if ANY opaque area is a rectangular panel, a framed picture, a painted sky ' +
      'or gradient patch, or a full miniature scene.'
    );
  }
  return (
    'This image should be a single game sprite on a transparent background. Answer strictly:\n' +
    '- facingRight: is the subject facing the RIGHT side of the image? (profile/side view; ' +
    'if there is no clear facing, answer true)\n' +
    '- backgroundClean: is everything outside the subject transparent/empty, with no ' +
    'leftover backdrop color, frame, or color field?'
  );
}

/**
 * Review a post-processed sprite (PNG data URL).
 * @returns {{facingRight: boolean, backgroundClean: boolean, gridConsistent?: boolean} | null}
 */
export async function reviewSprite(dataUrl, { kind = 'sprite', grid = null, label = null } = {}) {
  // Single provider gate: when the free path is forced, NO Gemini call may fire —
  // a null review just means "proceed unverified", exactly like a failed call.
  if (!isGeminiConfigured()) return null;
  try {
    const schema = kind === 'sheet' ? SHEET_SCHEMA
      : kind === 'strip' ? STRIP_SCHEMA
      : kind === 'layer' ? LAYER_SCHEMA
      : SPRITE_SCHEMA;
    const result = await generateJson({
      prompt: buildPrompt(kind, grid),
      responseSchema: schema,
      imageDataUrl: dataUrl,
      label: label || `qa:${kind}` // cost-report attribution
    });
    if (kind === 'strip') {
      if (typeof result?.facingRight !== 'boolean' || typeof result?.sameCharacter !== 'boolean') return null;
      return result;
    }
    if (typeof result?.backgroundClean !== 'boolean') return null;
    if (kind !== 'layer' && typeof result?.facingRight !== 'boolean') return null;
    return result;
  } catch (err) {
    console.warn('[AssetQA] Vision review failed, proceeding unverified:', err.message);
    return null;
  }
}
