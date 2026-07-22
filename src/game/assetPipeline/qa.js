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
import { generateJson } from './providers/geminiImage';

const SPRITE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    facingRight: { type: 'BOOLEAN', description: 'Is the character/creature facing to the RIGHT of the image?' },
    backgroundClean: { type: 'BOOLEAN', description: 'Is the area around the subject fully transparent/empty (no leftover backdrop, frame, or color field)?' }
  },
  required: ['facingRight', 'backgroundClean']
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
export async function reviewSprite(dataUrl, { kind = 'sprite', grid = null } = {}) {
  try {
    const result = await generateJson({
      prompt: buildPrompt(kind, grid),
      responseSchema: kind === 'sheet' ? SHEET_SCHEMA : SPRITE_SCHEMA,
      imageDataUrl: dataUrl
    });
    if (typeof result?.facingRight !== 'boolean' || typeof result?.backgroundClean !== 'boolean') {
      return null;
    }
    return result;
  } catch (err) {
    console.warn('[AssetQA] Vision review failed, proceeding unverified:', err.message);
    return null;
  }
}
