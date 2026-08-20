/**
 * Where the on-screen touch controls actually are, in game-canvas coordinates
 * (added 2026-08-20).
 *
 * The controls are React DOM floating over the Phaser canvas, so the scene has
 * no way to know how much of the play area they cover — and the answer changes
 * with device, orientation and game mode. Rather than duplicate the CSS sizes
 * as a constant in the scene (which would silently drift the first time the
 * buttons are restyled), MobileControls measures its own clusters and publishes
 * them here; the camera reads `getBottomInset()` to keep the ground line above
 * them.
 *
 * Deliberately a plain module, not a window global: the previous attempt at
 * this (`window.__pmSafeArea*` in App.jsx) had zero consumers for months
 * because nothing in the game layer could discover it.
 *
 * The published value SURVIVES the controls unmounting (they hide on game
 * over). A device's control footprint is a property of the device, not of the
 * moment — clearing it would make the camera jump the instant the player dies.
 */

// Breathing room between the tallest button and anything gameplay-relevant, so
// sprites clear the controls visibly rather than just barely.
const CLEARANCE_PX = 8;
// Never surrender more than this share of the viewport, however large the
// controls measure — a wrong measurement must degrade to "slightly odd
// framing", never to "no visible play area".
const MAX_INSET_FRACTION = 0.28;

let zones = { bottomInset: 0, left: null, right: null, measuredAt: 0 };

const shift = (rect, base) => ({
  ...rect,
  top: rect.top - (base?.top ?? 0),
  bottom: rect.bottom - (base?.top ?? 0),
  left: rect.left - (base?.left ?? 0),
  right: rect.right - (base?.left ?? 0)
});

const plainRect = (rect) => (rect && rect.width > 0 && rect.height > 0
  ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
  : null);

/**
 * Publish measured cluster rects. `base` is the overlay's own rect, used as the
 * reference frame so the numbers stay right regardless of where the app sits in
 * the viewport (fullscreen, embedded, notch offsets).
 */
export function setControlZones({ base, left, right }) {
  try {
    const l = plainRect(left);
    const r = plainRect(right);
    const tops = [l?.top, r?.top].filter((t) => typeof t === 'number');
    const bottom = base?.bottom ?? 0;
    const raw = tops.length ? Math.max(0, bottom - Math.min(...tops) + CLEARANCE_PX) : 0;
    const previousInset = zones.bottomInset;
    zones = {
      bottomInset: Math.round(raw),
      viewportHeight: base?.height ?? 0,
      // Normalised into the canvas's own frame on BOTH axes, so callers can
      // compare them against scene coordinates without knowing where the app
      // sits in the viewport.
      left: l ? shift(l, base) : null,
      right: r ? shift(r, base) : null,
      measuredAt: Date.now()
    };
    // The controls can mount AFTER the game has booted (the generator screen
    // holds them back until its reveal finishes), so the camera has to be told
    // when the gutter appears — otherwise the very first game of a session
    // renders without it.
    if (zones.bottomInset !== previousInset && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pm-control-zones', { detail: { bottomInset: zones.bottomInset } }));
    }
  } catch {
    /* measurement is an optimisation — never let it break the UI */
  }
}

export function getControlZones() {
  return zones;
}

/**
 * How far to lift the visible ground line, for a viewport of `height`.
 * Returns 0 when no controls have ever been measured (desktop/keyboard play),
 * which makes every camera call site a no-op change on those devices.
 */
/**
 * Horizontal no-spawn margins for the two bottom corners, in canvas pixels.
 *
 * Only meaningful where a corner is a FIXED screen region — in the platformer
 * the camera clamps at world x=0 (level start) and x=worldWidth-width (level
 * end), so those two corners really are the same pixels every time. Everywhere
 * else the camera moves and the vertical gutter is the guarantee.
 */
export function getCornerMargins(width) {
  const z = zones;
  const clearance = 16;
  const left = z.left ? Math.ceil(z.left.right) + clearance : 0;
  const right = z.right && width ? Math.ceil(width - z.right.left) + clearance : 0;
  // A margin that swallows the level is worse than no margin at all.
  const cap = width ? width * 0.3 : 0;
  return {
    left: Math.max(0, Math.min(left, cap)),
    right: Math.max(0, Math.min(right, cap))
  };
}

export function getBottomInset(height) {
  const inset = zones.bottomInset || 0;
  if (!inset || !height) return 0;
  return Math.round(Math.min(inset, height * MAX_INSET_FRACTION));
}

// Room between the floor's top edge (where feet stand) and the tallest control.
const SPRITE_CLEARANCE_PX = 12;

/**
 * How far to lift the visible ground so the floor's TOP edge clears the touch
 * controls. The floor itself is scenery; only what stands ON it is gameplay,
 * so the contract is "floor top above the buttons", not "floor bottom above
 * them" — the first version pinned the bottom, lifted the whole 100px floor band
 * above the controls, and exposed a large ugly under-floor strip (2026-08-21).
 *
 * With the current 47/55px buttons and a 100px floor this is 0 on every phone
 * layout in both orientations: the ground sits exactly where it always did, and
 * this stays purely a safety net for taller control layouts or themes with a
 * short floor.
 */
export function getGroundLift(height, floorHeight) {
  const controls = getBottomInset(height);
  if (!controls) return 0;
  return Math.max(0, Math.round(controls + SPRITE_CLEARANCE_PX - (floorHeight || 0)));
}
