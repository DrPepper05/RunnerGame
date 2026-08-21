/**
 * Pure canvas post-processing for generated assets.
 *
 * No provider honors exact pixel dimensions or outputs alpha, so this stage is what
 * guarantees the contract the game relies on: exact canvas size, keyed-out white
 * generation background, and tight cropping (collision bodies are full-texture, so
 * transparent margins would inflate hitboxes).
 */

/**
 * Load an image element and resolve once it is decoded.
 */
export function loadImage(src, { crossOrigin = 'anonymous' } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image data.'));
    img.src = src;
  });
}

/**
 * Progressive pre-shrink for large downscales. A single drawImage from e.g. a 2K
 * render down to a 128px cell resamples through at most a 2×2 tap and aliases badly;
 * halving repeatedly until within ~1.5× of the target keeps every step inside the
 * filter kernel — the standard canvas supersampling recipe.
 */
function preshrink(src, targetW, targetH) {
  let w = src.width, h = src.height;
  while (w / 2 >= targetW * 1.5 && h / 2 >= targetH * 1.5) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.round(w / 2));
    half.height = Math.max(1, Math.round(h / 2));
    const hctx = half.getContext('2d');
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(src, 0, 0, half.width, half.height);
    src = half;
    w = half.width;
    h = half.height;
  }
  return src;
}

/**
 * Draw an image onto a fresh canvas at the target size.
 * 'cover' scales to fill and center-crops (used to force ~2:1 backgrounds from 16:9 sources);
 * 'stretch' fills the canvas exactly.
 */
export function drawToCanvas(img, { width, height, fit = 'stretch' }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // AI output is not true pixel art; bilinear downscaling looks better than nearest
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const src = preshrink(img, width, height);
  if (fit === 'cover') {
    const scale = Math.max(width / src.width, height / src.height);
    const drawW = src.width * scale;
    const drawH = src.height * scale;
    ctx.drawImage(src, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  } else {
    ctx.drawImage(src, 0, 0, width, height);
  }
  return canvas;
}

/**
 * Fraction of pixels that are fully transparent. Used to accept/reject keyed layers.
 */
export function alphaFraction(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++;
  }
  return transparent / (data.length / 4);
}

/**
 * Bounding box of non-transparent pixels in a single canvas, or null when empty.
 * `alphaMin` raises the opacity bar — alignment passes use ≥16 so a single stray
 * semi-transparent pixel can't skew the box.
 */
export function contentBoundsOf(canvas, { alphaMin = 1 } = {}) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

/**
 * Fraction of the canvas's outer band occupied by OPAQUE backdrop-colored pixels.
 * A keyed + content-cropped sprite hugs its bounding box, so backdrop-colored pixels
 * sitting along the frame edge are leftovers the flood fill failed to reach — a
 * deterministic "keying failed" signal that needs no vision model. Near-white is
 * ALWAYS checked (the legacy backdrop and the free path); pass `chroma` to also
 * count leftover green/magenta screen — providers don't always honor the chroma
 * ask, so the check covers both compliance outcomes.
 */
export function borderResidueFraction(canvas, { band = 0.12, threshold = 228, chroma = null } = {}) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const bx = Math.max(1, Math.round(w * band));
  const by = Math.max(1, Math.round(h * band));
  const isResidue = (r, g, b) => {
    if (r >= threshold && g >= threshold && b >= threshold) return true;
    if (chroma === 'green') return g >= 140 && g >= r + 50 && g >= b + 50;
    if (chroma === 'magenta') return r >= 140 && b >= 140 && r >= g + 50 && b >= g + 50;
    return false;
  };
  let ring = 0;
  let residue = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bx && x < w - bx && y >= by && y < h - by) continue;
      ring++;
      const i = (y * w + x) * 4;
      if (data[i + 3] > 0 && isResidue(data[i], data[i + 1], data[i + 2])) residue++;
    }
  }
  return ring === 0 ? 0 : residue / ring;
}

/**
 * Clear backdrop pockets ENCLOSED inside a keyed sprite (the gap between an arm
 * and the torso): border-flood keying structurally can't reach them, and they
 * render as solid patches "inside" the character. ONLY leftover CHROMA-colored
 * regions are cleared — the prompt bans chroma on the subject, so they are
 * unambiguously backdrop. White pockets are deliberately NOT touched: a
 * white-clearing variant shipped 2026-08-16 and shredded white-heavy characters
 * (mummy bandages) differently per sheet cell, blowing up the per-cell identity
 * scorer and killing every sheet attempt. White gaps are handled on the prompt
 * side (GAPS_CLAUSE asks for backdrop color inside limb gaps — which makes them
 * chroma-colored and therefore clearable here).
 * Guards: only interior components (border-touching ones are the flood's job),
 * each ≤ maxAreaFrac of the opaque area, and the whole pass reverts when it
 * would remove >30% of the sprite.
 */
/**
 * Backdrop "card" handling (2026-08-21). Live failure: the model drew the character
 * on a WHITE CARD/PANEL sitting on the requested chroma screen (or on a white field
 * inside a dark frame). The border flood keys the screen and stops dead at the
 * card's edge; every downstream gate measures the cell's OUTER band, which is clean
 * by then; removeEnclosedPockets is chroma-only; vision QA's "dirty background" can
 * only trigger a looser re-key, which still cannot cross from green into white. So
 * the card shipped — a white rectangle hugging the sprite — and because the sprite
 * sheet is an image-EDIT of that static sprite, every animation frame inherited it.
 *
 * A card candidate is: an opaque near-white connected component within 2px of the
 * transparent (keyed) region or the canvas edge, whose outline is rectangle-like
 * (its bbox perimeter is mostly covered by the component itself), and which
 * encloses most of the content's bbox. The 2px reach matters: downscaling and the
 * model's own anti-aliasing leave a 1px rim of white/screen blend around a card,
 * so its interior never touches the void DIRECTLY. A white-bodied character (the
 * mummy lesson of 2026-08-16) fails the rectangle test, and is usually sealed
 * from the backdrop by its outline anyway.
 */
const PALE = (r, g, b) => {
  const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
  return mn >= 200 && mx - mn <= 52;
};

function findCardCandidates(d, w, h) {
  const n = w * h;
  const opaque = (i) => d[i * 4 + 3] >= 128;
  let cx0 = Infinity, cy0 = Infinity, cx1 = -1, cy1 = -1;
  for (let i = 0; i < n; i++) {
    if (!opaque(i)) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
  }
  if (cx1 < 0) return [];
  const contentW = cx1 - cx0 + 1, contentH = cy1 - cy0 + 1;

  const touchesVoid = (i) => {
    const x = i % w, y = (i / w) | 0;
    if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) return true;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if ((dx || dy) && !opaque(i + dy * w + dx)) return true;
      }
    }
    return false;
  };
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const candidates = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (visited[s0] || !opaque(s0) || !PALE(d[s0 * 4], d[s0 * 4 + 1], d[s0 * 4 + 2]) || !touchesVoid(s0)) continue;
    let head = 0, tail = 0;
    visited[s0] = 1; queue[tail++] = s0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
    const members = [];
    while (head < tail) {
      const i = queue[head++];
      members.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < w - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - w);
      if (y < h - 1) nb.push(i + w);
      for (const j of nb) {
        if (visited[j]) continue;
        if (opaque(j) && PALE(d[j * 4], d[j * 4 + 1], d[j * 4 + 2])) { visited[j] = 1; queue[tail++] = j; }
      }
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < 8 || bh < 8) continue;
    // Rectangle-likeness: how much of the component's bbox perimeter is pale —
    // by ANY pale pixel, not just this component's: a limb crossing the card's
    // edge splits a sliver off into its own component, and counting only the main
    // body's pixels made that edge read as missing. A card's straight edges are
    // fully present (a limb may cross one edge); a humanoid/blob white shape
    // covers little of its bbox perimeter either way.
    const edgeCov = (pts) => pts.reduce((a, i) => a + (opaque(i) && PALE(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 1 : 0), 0) / pts.length;
    const top = [], bottom = [], left = [], right = [];
    for (let x = bx0; x <= bx1; x++) { top.push(by0 * w + x); bottom.push(by1 * w + x); }
    for (let y = by0; y <= by1; y++) { left.push(y * w + bx0); right.push(y * w + bx1); }
    const covs = [edgeCov(top), edgeCov(bottom), edgeCov(left), edgeCov(right)].sort((a, b) => b - a);
    const rectangular = covs[0] >= 0.85 && covs[1] >= 0.85 && covs[2] >= 0.7 && covs[3] >= 0.35;
    // Enclosure: the card sits behind most of the content.
    const encloses = bw >= contentW * 0.6 && bh >= contentH * 0.6;
    if (rectangular && encloses) candidates.push({ members, bx0, by0, bx1, by1 });
  }
  return candidates;
}

/** True when a rectangle-like pale panel still sits behind the content. */
export function hasBackdropCard(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  return findCardCandidates(d, w, h).length > 0;
}

/**
 * Strip backdrop cards. Only runs when the prompt asked for a CHROMA screen (white
 * is then never a legitimate backdrop). Each removal must leave a character that
 * sits ON the card — and not be the body OF a white character: geometric test, the
 * card extends beyond the surviving content on at least 3 of 4 sides (a leg may
 * cross the bottom edge); a white robot body has its head above, legs below and
 * arms beyond it, and a white crate's surviving outline surrounds its interior —
 * both fail and are reverted. Plus a minimum: the survivor must be a real sprite
 * (≥1% of the canvas, ≥20% of its height), not a pair of eyes. Returns true when a
 * card was removed.
 */
export function removeBackdropCard(canvas, { chroma = null } = {}) {
  if (!chroma) return false;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const opaque = (i) => d[i * 4 + 3] >= 128;
  const candidates = findCardCandidates(d, w, h);
  if (!candidates.length) return false;

  // Outside void BEFORE any card goes: the rim test must distinguish "next to the
  // hole AND next to the outside" (the card's anti-aliased rim) from "next to the
  // hole only" (the character's own edge where it met the card).
  // The canvas border counts as outside too (a card touching the cell's edge has
  // its rim ON that edge, with no transparent pixel beyond it).
  const nearOutside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0;
    if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) nearOutside[i] = 1;
    if (opaque(i)) continue;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) nearOutside[Y * w + X] = 1;
      }
    }
  }
  const clearRimAround = (members) => {
    // The card's anti-aliased rim — white blended with the screen (or with a dark
    // frame), which the flood could not key and which is NOT pale — survives as a
    // 1-2px frame around the hole. Clear it: within 2px of the removed pixels,
    // within 2px of the original outside void, and not dark (a dark outline that
    // happens to cross the card edge is kept). Without this its bbox wraps the
    // card on all four sides and the survival test would see "content beyond".
    for (const i of members) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (d[j * 4 + 3] < 128 || !nearOutside[j]) continue;
          const r = d[j * 4], g = d[j * 4 + 1], b = d[j * 4 + 2];
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luma >= 90 || isChromaResidue(r, g, b, chroma)) d[j * 4 + 3] = 0;
        }
      }
    }
  };

  let removedAny = false;
  for (const card of candidates) {
    const { members, bx0, by0, bx1, by1 } = card;
    if (!members.every(opaque)) continue; // consumed by an earlier removal
    const backup = new Uint8ClampedArray(d);
    for (const i of members) d[i * 4 + 3] = 0;
    clearRimAround(members);
    let left2 = 0, lx0 = Infinity, ly0 = Infinity, lx1 = -1, ly1 = -1;
    for (let i = 0; i < n; i++) {
      if (!opaque(i)) continue;
      left2++;
      const x = i % w, y = (i / w) | 0;
      if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y;
    }
    const survivedArea = left2 >= Math.max(64, n * 0.01);
    const survivedSize = lx1 >= 0 && (ly1 - ly0 + 1) >= h * 0.2;
    const margin = 3;
    const sidesBeyond = lx1 < 0 ? 0 :
      (lx0 - bx0 >= margin) + (bx1 - lx1 >= margin) + (ly0 - by0 >= margin) + (by1 - ly1 >= margin);
    if (!survivedArea || !survivedSize || sidesBeyond < 3) {
      d.set(backup);
      continue;
    }
    removedAny = true;

    // Remnants: small pale pieces of the SAME card cut off by limbs (the strip
    // between two legs where they cross the card's bottom edge). Pale, inside the
    // card's footprint, touching the void, and small — a white shirt patch is
    // sealed inside the body and never touches the void; a white body is large.
    const cardArea = (bx1 - bx0 + 1) * (by1 - by0 + 1);
    const seen = new Uint8Array(n);
    const q = new Int32Array(n);
    for (let s0 = 0; s0 < n; s0++) {
      const x = s0 % w, y = (s0 / w) | 0;
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
      if (seen[s0] || !opaque(s0) || !PALE(d[s0 * 4], d[s0 * 4 + 1], d[s0 * 4 + 2])) continue;
      let head = 0, tail = 0, touches = false;
      seen[s0] = 1; q[tail++] = s0;
      const comp = [];
      while (head < tail) {
        const i = q[head++];
        comp.push(i);
        const xi = i % w, yi = (i / w) | 0;
        const nb = [];
        if (xi > 0) nb.push(i - 1);
        if (xi < w - 1) nb.push(i + 1);
        if (yi > 0) nb.push(i - w);
        if (yi < h - 1) nb.push(i + w);
        for (const j of nb) {
          if (!opaque(j)) { touches = true; continue; }
          if (!seen[j] && PALE(d[j * 4], d[j * 4 + 1], d[j * 4 + 2])) { seen[j] = 1; q[tail++] = j; }
        }
      }
      if (touches && comp.length <= cardArea * 0.05) {
        for (const i of comp) d[i * 4 + 3] = 0;
        clearRimAround(comp);
      }
    }
  }
  if (removedAny) ctx.putImageData(imgData, 0, 0);
  return removedAny;
}

/**
 * "Boxed sprite" detector (2026-08-21): a keyed character whose opaque pixels fill
 * its own bounding box almost completely, with the bbox perimeter itself almost
 * fully opaque, is not a silhouette — it is a sprite still sitting on its backdrop.
 * Real characters fill ~35-70% of their bbox. Also flags a sprite that still has a
 * rectangle-like pale panel behind it (hasBackdropCard) — a limb protruding past
 * the panel breaks the fill test but not that one. Deterministic, no vision model;
 * used as a "do not ship this" gate for player/enemy and per sheet cell (NOT for
 * obstacles/platforms, which can legitimately be solid rectangles).
 */
export function isBoxedSprite(canvas, { fillMin = 0.86, edgeMin = 0.85 } = {}) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const opaque = (x, y) => d[(y * w + x) * 4 + 3] >= 128;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!opaque(x, y)) continue;
    count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return false;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 12 || bh < 12) return false;
  const fill = count / (bw * bh);
  let edgeHits = 0, edgeTotal = 0;
  for (let x = x0; x <= x1; x++) { edgeTotal += 2; edgeHits += opaque(x, y0) + opaque(x, y1); }
  for (let y = y0 + 1; y < y1; y++) { edgeTotal += 2; edgeHits += opaque(x0, y) + opaque(x1, y); }
  if (fill >= fillMin && edgeHits / edgeTotal >= edgeMin) return true;
  return findCardCandidates(d, w, h).length > 0;
}

export function removeEnclosedPockets(canvas, { chroma = null, maxAreaFrac = 0.25 } = {}) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const isPocketColor = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (chroma === 'green' && g >= 140 && g >= r + 50 && g >= b + 50) return true;
    if (chroma === 'magenta' && r >= 140 && b >= 140 && r >= g + 50 && b >= g + 50) return true;
    return false;
  };
  let opaque = 0;
  const target = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (data[p * 4 + 3] === 0) continue;
    opaque++;
    if (isPocketColor(p * 4)) target[p] = 1;
  }
  if (!opaque) return canvas;
  const seen = new Uint8Array(w * h);
  const stack = [];
  let removedTotal = 0;
  const clearedPixels = [];
  for (let start = 0; start < w * h; start++) {
    if (!target[start] || seen[start]) continue;
    // Flood one connected pocket-colored component.
    const component = [];
    let touchesBorder = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      component.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      const neighbors = [p - 1, p + 1, p - w, p + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h || seen[n] || !target[n]) continue;
        const nx = n % w;
        if (Math.abs(nx - x) > 1) continue; // row wrap
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (touchesBorder || component.length < 6 || component.length > opaque * maxAreaFrac) continue;
    removedTotal += component.length;
    clearedPixels.push(...component);
  }
  if (!removedTotal || removedTotal > opaque * 0.3) return canvas; // nothing, or revert
  for (const p of clearedPixels) data[p * 4 + 3] = 0;
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Stretch each column's opaque span to the full canvas height, alpha forced solid.
 * For platform art: the game shows the texture inside a fixed physics rectangle, so
 * rounded "pill" shapes with transparent corners read as a platform floating off its
 * hitbox. Column-wise stretching keeps the texture while guaranteeing the art edge
 * IS the collision edge. Fully-empty columns stay transparent.
 */
export function solidifyColumns(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const dst = out.data;
  for (let x = 0; x < w; x++) {
    let top = -1, bottom = -1;
    for (let y = 0; y < h; y++) {
      if (src[(y * w + x) * 4 + 3] > 0) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    if (top < 0) continue;
    const span = bottom - top + 1;
    for (let y = 0; y < h; y++) {
      const srcY = top + Math.min(span - 1, Math.floor((y / h) * span));
      const si = (srcY * w + x) * 4;
      const di = (y * w + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * Fraction of the canvas's TOP band occupied by opaque pixels. The parallax layer
 * scaffolds promise "everything above the shapes is empty white", so an opaque top
 * band after keying means the model painted a full scene and the flood couldn't
 * clear it — the deterministic layer counterpart of borderResidueFraction.
 */
export function topBandOpaqueFraction(canvas, { band = 0.45 } = {}) {
  const w = canvas.width, h = canvas.height;
  const bandH = Math.max(1, Math.round(h * band));
  const data = canvas.getContext('2d').getImageData(0, 0, w, bandH).data;
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) opaque++;
  }
  return opaque / (data.length / 4);
}

/**
 * Return a horizontally mirrored copy of the canvas.
 */
export function mirrorCanvas(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Key out the generation background via border-connected flood fill.
 *
 * Unlike the global white threshold, this only removes pixels connected to the frame
 * border, so white details INSIDE the sprite survive, and non-white / gradient backdrops
 * are handled. A neighbor joins the background when it matches the border color, or when
 * it continues a gradient (small step from the current pixel) while staying within a
 * global cap of the border color — the cap stops floods crawling through soft glows into
 * the sprite. Sprites are prompted with dark outlines, which hard-stop the flood.
 */
export function removeBorderBackground(canvas, {
  seedTol = 40,
  stepTol = 14,
  globalCap = 120,
  // Near-total wipes only: a SMALL sprite (projectile) legitimately leaves >95%
  // backdrop, so the old 0.95 guard fired on perfectly good keys. Only a flood that
  // ate essentially everything (sprite same color as backdrop) is pathological.
  maxRemovedFraction = 0.995
} = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const n = w * h;

  // DOMINANT border color (coarse histogram), not the mean: content that sits flush
  // against one edge (e.g. a silhouette strip along the bottom) would drag a mean
  // toward gray and match nothing — the dominant bin ignores the content edge.
  const bins = new Map();
  const addPx = (i) => {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = { count: 0, r: 0, g: 0, b: 0 }; bins.set(key, bin); }
    bin.count++; bin.r += r; bin.g += g; bin.b += b;
  };
  for (let x = 0; x < w; x++) { addPx(x); addPx((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { addPx(y * w); addPx(y * w + w - 1); }
  let dominant = null;
  for (const bin of bins.values()) {
    if (!dominant || bin.count > dominant.count) dominant = bin;
  }
  const br = dominant.r / dominant.count;
  const bg = dominant.g / dominant.count;
  const bb = dominant.b / dominant.count;

  const dist = (i) => {
    const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const stepDist = (i, j) => {
    const dr = data[i * 4] - data[j * 4], dg = data[i * 4 + 1] - data[j * 4 + 1], db = data[i * 4 + 2] - data[j * 4 + 2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const removed = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  const trySeed = (i) => {
    if (!visited[i] && dist(i) <= seedTol) {
      visited[i] = 1; removed[i] = 1; queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) { trySeed(x); trySeed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { trySeed(y * w); trySeed(y * w + w - 1); }

  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    const neighbors = [];
    if (x > 0) neighbors.push(i - 1);
    if (x < w - 1) neighbors.push(i + 1);
    if (y > 0) neighbors.push(i - w);
    if (y < h - 1) neighbors.push(i + w);
    for (const j of neighbors) {
      if (visited[j]) continue;
      const dj = dist(j);
      if (dj <= seedTol || (stepDist(i, j) <= stepTol && dj <= globalCap)) {
        visited[j] = 1; removed[j] = 1; queue[tail++] = j;
      }
    }
  }

  let removedCount = 0;
  for (let i = 0; i < n; i++) if (removed[i]) removedCount++;
  if (removedCount / n > maxRemovedFraction) {
    // Something pathological (e.g. sprite same color as backdrop) — fall back to a
    // conservative global key of the DETECTED backdrop color rather than erasing the
    // whole image. The fallback MUST match the actual backdrop: the old white-only
    // fallback shipped solid green boxes for chroma-keyed sprites (it removed nothing).
    return (br >= 200 && bg >= 200 && bb >= 200)
      ? removeWhiteBackground(canvas)
      : removeFlatColor(canvas, { r: br, g: bg, b: bb });
  }

  for (let i = 0; i < n; i++) if (removed[i]) data[i * 4 + 3] = 0;

  // Feather: kept pixels touching removed ones fade proportionally to how close they
  // are to the border color, avoiding hard fringes
  for (let i = 0; i < n; i++) {
    if (removed[i] || data[i * 4 + 3] === 0) continue;
    const x = i % w, y = (i / w) | 0;
    let touches = false;
    for (let dy = -1; dy <= 1 && !touches; dy++) {
      for (let dx = -1; dx <= 1 && !touches; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && removed[ny * w + nx]) touches = true;
      }
    }
    if (touches) {
      const factor = Math.min(1, Math.max(0, dist(i) / seedTol));
      data[i * 4 + 3] = Math.round(data[i * 4 + 3] * factor);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Crop away uniform-color margin rows/cols around the frame (e.g. a white border the
 * model painted around a floor tile). Must run BEFORE stretching, or the margin gets
 * baked into the texture and shows as seams when tiled.
 */
export function trimUniformBorder(canvas, { tolerance = 12 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  const px = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const rowUniform = (y, ref) => {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      if (Math.abs(r - ref[0]) > tolerance || Math.abs(g - ref[1]) > tolerance || Math.abs(b - ref[2]) > tolerance) return false;
    }
    return true;
  };
  const colUniform = (x, ref) => {
    for (let y = 0; y < h; y++) {
      const [r, g, b] = px(x, y);
      if (Math.abs(r - ref[0]) > tolerance || Math.abs(g - ref[1]) > tolerance || Math.abs(b - ref[2]) > tolerance) return false;
    }
    return true;
  };

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowUniform(top, px(0, top))) top++;
  while (bottom > top && rowUniform(bottom, px(0, bottom))) bottom--;
  while (left < right && colUniform(left, px(left, top))) left++;
  while (right > left && colUniform(right, px(right, top))) right--;

  if (top === 0 && left === 0 && bottom === h - 1 && right === w - 1) return canvas;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw < 8 || ch < 8) return canvas;

  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').putImageData(ctx.getImageData(left, top, cw, ch), 0, 0);
  return out;
}

/**
 * Global distance-threshold key against an arbitrary flat backdrop color — the
 * chroma-capable counterpart of removeWhiteBackground, used as the flood keyer's
 * safety fallback when the backdrop isn't near-white (green/magenta screens).
 * Pixels within `tol` of the color go transparent, with a soft alpha ramp over the
 * next `soft` units to avoid a hard fringe.
 */
export function removeFlatColor(canvas, { r, g, b }, { tol = 48, soft = 40 } = {}) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d <= tol) {
      data[i + 3] = 0;
    } else if (d <= tol + soft) {
      const alpha = Math.round(255 * ((d - tol) / soft));
      data[i + 3] = Math.min(data[i + 3], alpha);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Key out the flat white generation background in place.
 * Pixels with all channels >= threshold fade out; averages above hardCut go fully
 * transparent, with a smooth alpha ramp in between to avoid hard white fringes.
 * Kept as the conservative fallback keyer ('white' mode / flood-fill safety net).
 */
export function removeWhiteBackground(canvas, { threshold = 200, hardCut = 240 } = {}) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r >= threshold && g >= threshold && b >= threshold) {
      const avg = (r + g + b) / 3;
      if (avg > hardCut) {
        data[i + 3] = 0;
      } else {
        const factor = (avg - threshold) / (hardCut - threshold);
        const alpha = Math.round(255 * (1 - factor));
        data[i + 3] = Math.min(data[i + 3], alpha);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Trim fully transparent margins down to the content bounding box.
 * Returns the original canvas when it has no opaque pixels.
 */
export function cropCanvasToContent(canvas) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const data = ctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1 || maxY === -1) {
    return canvas;
  }

  const croppedWidth = maxX - minX + 1;
  const croppedHeight = maxY - minY + 1;

  const croppedCanvas = document.createElement('canvas');
  croppedCanvas.width = croppedWidth;
  croppedCanvas.height = croppedHeight;
  croppedCanvas.getContext('2d').putImageData(
    ctx.getImageData(minX, minY, croppedWidth, croppedHeight), 0, 0
  );
  return croppedCanvas;
}

/**
 * Return a horizontally mirrored copy of a decoded image, as a fresh image element.
 */
export async function mirrorImage(img) {
  const canvas = drawToCanvas(img, {
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    fit: 'stretch'
  });
  return loadImage(mirrorCanvas(canvas).toDataURL('image/png'), { crossOrigin: null });
}

/**
 * Slice a sheet canvas into equal grid cells.
 */
export function sliceGrid(canvas, { cols, rows }) {
  const cellW = Math.floor(canvas.width / cols);
  const cellH = Math.floor(canvas.height / rows);
  const frames = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = document.createElement('canvas');
      cell.width = cellW;
      cell.height = cellH;
      cell.getContext('2d').drawImage(canvas, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
      frames.push(cell);
    }
  }
  return frames;
}

/**
 * Union bounding box of non-transparent content across frames (all frames share cell
 * coordinates). Cropping every frame to the UNION — never per-frame — keeps the
 * character anchored across the cycle; per-frame crops would make the animation jitter.
 * Returns null when every frame is empty.
 */
export function unionContentBounds(frames, { alphaMin = 1 } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const frame of frames) {
    const w = frame.width, h = frame.height;
    const data = frame.getContext('2d').getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] >= alphaMin) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (maxX === -1) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Normalize per-frame drift before the union crop. Image models place and size the
 * character slightly differently in every cell; played back, that drift reads as
 * teleporting/wobbling — the main "animation is not continuous" driver. Each frame is
 * redrawn on a fresh cell canvas with its content bbox centered horizontally and its
 * bottom on a shared baseline, and run-frame heights are pulled toward the median
 * (only when >5% off, clamped to ±20%). The jump frame is aligned but never scaled —
 * a tucked jump pose is legitimately shorter than a stride.
 */
export function alignFrames(frames, { runFrameCount = frames.length, alphaMin = 16 } = {}) {
  const boxes = frames.map((frame) =>
    contentBoundsOf(frame, { alphaMin }) || contentBoundsOf(frame));

  // Alpha-weighted centroid-x per frame: the bbox center jumps when a single arm
  // extends forward, but the mass centroid tracks the torso — anchoring on it
  // (clamped near the bbox center) removes most residual horizontal wobble.
  const centroids = frames.map((frame, i) => {
    const box = boxes[i];
    if (!box) return null;
    const w = frame.width;
    const data = frame.getContext('2d').getImageData(0, 0, w, frame.height).data;
    let sum = 0, weight = 0;
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a >= alphaMin) { sum += x * a; weight += a; }
      }
    }
    if (!weight) return null;
    const cx = sum / weight;
    const boxCenter = (box.minX + box.maxX) / 2;
    const slack = Math.max(4, (box.maxX - box.minX + 1) * 0.12);
    return Math.max(boxCenter - slack, Math.min(boxCenter + slack, cx));
  });

  const runHeights = boxes
    .slice(0, runFrameCount)
    .filter(Boolean)
    .map((b) => b.maxY - b.minY + 1)
    .sort((a, b) => a - b);
  const medianH = runHeights.length
    ? runHeights[Math.floor(runHeights.length / 2)]
    : 0;

  return frames.map((frame, i) => {
    const box = boxes[i];
    if (!box) return frame; // empty frame — the gates deal with it

    const cellW = frame.width, cellH = frame.height;
    const boxW = box.maxX - box.minX + 1;
    const boxH = box.maxY - box.minY + 1;

    let scale = 1;
    if (i < runFrameCount && medianH > 0) {
      const raw = medianH / boxH;
      if (Math.abs(raw - 1) > 0.05) {
        scale = Math.max(0.8, Math.min(1.2, raw));
        // never scale the content out of its cell
        scale = Math.min(scale, cellW / boxW, cellH / boxH);
      }
    }

    const drawW = boxW * scale;
    const drawH = boxH * scale;
    const baseline = cellH - 2;
    // Place so the (clamped) centroid lands at the cell's horizontal center.
    const anchorOffset = centroids[i] != null ? (centroids[i] - box.minX) * scale : drawW / 2;
    let dx = Math.round(cellW / 2 - anchorOffset);
    let dy = Math.round(baseline - drawH);
    dx = Math.max(0, Math.min(dx, Math.floor(cellW - drawW)));
    dy = Math.max(0, Math.min(dy, Math.floor(cellH - drawH)));

    const out = document.createElement('canvas');
    out.width = cellW;
    out.height = cellH;
    out.getContext('2d').drawImage(frame, box.minX, box.minY, boxW, boxH, dx, dy, drawW, drawH);
    return out;
  });
}

/**
 * Intersection-over-union of two frames' alpha masks (same-size, ALIGNED frames).
 * The deterministic continuity signal: consecutive run frames of one character in
 * one stride overlap heavily but never perfectly — near-zero IoU means an identity
 * or pose jump, near-1.0 means a duplicated frame. Both read as broken animation.
 */
export function maskIoU(a, b, { alphaMin = 16 } = {}) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const da = a.getContext('2d').getImageData(0, 0, w, h).data;
  const db = b.getContext('2d').getImageData(0, 0, w, h).data;
  let inter = 0, union = 0;
  for (let i = 3; i < da.length; i += 4) {
    const ia = da[i] >= alphaMin, ib = db[i] >= alphaMin;
    if (ia && ib) inter++;
    if (ia || ib) union++;
  }
  return union === 0 ? 0 : inter / union;
}

/**
 * Compose keyed cells into a single numbered filmstrip on white, for vision QA.
 * Numbering the frames is what lets the reviewer return per-frame verdicts
 * ("frame 4 is a different character") instead of a whole-sheet yes/no.
 */
export function composeFilmstrip(cells) {
  const cellW = Math.max(...cells.map(c => c.width));
  const cellH = Math.max(...cells.map(c => c.height));
  const pad = 4;
  const labelBand = 20;
  const canvas = document.createElement('canvas');
  canvas.width = cells.length * (cellW + pad) + pad;
  canvas.height = cellH + labelBand + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  cells.forEach((cell, i) => {
    const x = pad + i * (cellW + pad);
    ctx.drawImage(cell, x + Math.floor((cellW - cell.width) / 2), pad);
    ctx.fillText(String(i + 1), x + cellW / 2, pad + cellH + 15);
    ctx.strokeStyle = '#888888';
    ctx.strokeRect(x - 0.5, pad - 0.5, cellW + 1, cellH + 1);
  });
  return canvas;
}

/**
 * Quantize every frame's opaque pixels to a shared palette sampled from the static
 * reference sprite (median-cut). Kills the subtle per-frame hue/shading drift that
 * plays back as color flicker. Guarded: when the frames' colors genuinely diverge
 * from the reference (mean per-pixel shift above `maxMeanShift`), the lock would
 * deface the art — return the originals untouched instead.
 */
export function lockPalette(frames, refCanvas, { maxColors = 48, maxMeanShift = 30 } = {}) {
  const refData = refCanvas.getContext('2d').getImageData(0, 0, refCanvas.width, refCanvas.height).data;
  const samples = [];
  for (let i = 0; i < refData.length; i += 8) { // every 2nd pixel
    if (refData[i + 3] > 64) samples.push([refData[i], refData[i + 1], refData[i + 2]]);
  }
  if (samples.length < 32) return frames;

  // Median-cut: split the widest-channel box at its median until maxColors boxes.
  let boxes = [samples];
  while (boxes.length < maxColors) {
    let widest = -1, widestIdx = -1, widestCh = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let min = 255, max = 0;
        for (const p of box) { if (p[ch] < min) min = p[ch]; if (p[ch] > max) max = p[ch]; }
        if (max - min > widest) { widest = max - min; widestIdx = bi; widestCh = ch; }
      }
    });
    if (widestIdx === -1 || widest < 8) break;
    const box = boxes[widestIdx];
    box.sort((a, b) => a[widestCh] - b[widestCh]);
    const mid = Math.floor(box.length / 2);
    boxes.splice(widestIdx, 1, box.slice(0, mid), box.slice(mid));
  }
  const palette = boxes.filter(b => b.length).map((box) => {
    let r = 0, g = 0, b2 = 0;
    for (const p of box) { r += p[0]; g += p[1]; b2 += p[2]; }
    return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b2 / box.length)];
  });
  palette.push([15, 18, 26]); // the addOutline ring color must survive quantization

  const nearestCache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let hit = nearestCache.get(key);
    if (hit) return hit;
    let best = palette[0], bestD = Infinity;
    for (const p of palette) {
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    nearestCache.set(key, best);
    return best;
  };

  const quantized = [];
  let shiftSum = 0, shiftCount = 0;
  for (const frame of frames) {
    const out = cloneCanvas(frame);
    const ctx = out.getContext('2d');
    const imageData = ctx.getImageData(0, 0, out.width, out.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const [r, g, b] = nearest(data[i], data[i + 1], data[i + 2]);
      shiftSum += Math.abs(r - data[i]) + Math.abs(g - data[i + 1]) + Math.abs(b - data[i + 2]);
      shiftCount++;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    ctx.putImageData(imageData, 0, 0);
    quantized.push(out);
  }
  if (shiftCount && shiftSum / shiftCount > maxMeanShift) return frames;
  return quantized;
}

/**
 * Reassemble cropped frames into a uniform sheet.
 */
export function assembleSheet(frames, { cols, rows }) {
  const frameWidth = frames[0].width;
  const frameHeight = frames[0].height;
  const canvas = document.createElement('canvas');
  canvas.width = frameWidth * cols;
  canvas.height = frameHeight * rows;
  const ctx = canvas.getContext('2d');
  frames.forEach((frame, i) => {
    ctx.drawImage(frame, (i % cols) * frameWidth, Math.floor(i / cols) * frameHeight);
  });
  return { canvas, frameWidth, frameHeight };
}

function insetCanvas(canvas, insetX, insetY = insetX) {
  const w = canvas.width - insetX * 2;
  const h = canvas.height - insetY * 2;
  if (w <= 0 || h <= 0) return canvas;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, insetX, insetY, w, h, 0, 0, w, h);
  return out;
}

// Extends a canvas upward with transparent headroom. Sheet cells hold full-body
// characters whose heads sit at (or on) the cell's top edge; without headroom the
// edge chain treats the canvas border as void (erode eats the head's top row and
// addOutline cannot cap it), which reads as a flat guillotined head in-game.
function padCanvasTop(canvas, px) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + px;
  out.getContext('2d').drawImage(canvas, 0, px);
  return out;
}

function cloneCanvas(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

/**
 * Flood-key one sheet cell with the same self-check the single-sprite path gets from
 * enforceKeyQuality: measure coverage + near-white border residue, then ONE conditional
 * re-key from a pristine copy (tighter when the flood shredded the sprite, looser when
 * it left backdrop). Without this, residue appears on some cells and not others and
 * plays back as per-frame background flicker. Cells are uncropped, so the outer band
 * of the cell is exactly where leftover backdrop lives.
 */
export function keyCellWithQuality(cell, { chroma = null } = {}) {
  const pristine = cloneCanvas(cell);
  const keyed = removeBorderBackground(cell);
  const transparent = alphaFraction(keyed);
  const residue = borderResidueFraction(keyed, { chroma });

  if (transparent > 0.92) {
    const retried = removeBorderBackground(cloneCanvas(pristine), { seedTol: 26, stepTol: 10 });
    const after = { transparent: alphaFraction(retried), residue: borderResidueFraction(retried, { chroma }) };
    return after.transparent <= transparent - 0.1 && after.residue <= 0.06 ? retried : keyed;
  }

  if (transparent < 0.05 || residue > 0.06) {
    const retried = removeBorderBackground(cloneCanvas(pristine), { seedTol: 70, stepTol: 24 });
    const after = { transparent: alphaFraction(retried), residue: borderResidueFraction(retried, { chroma }) };
    const spriteSurvived = after.transparent < 0.97;
    const improved = after.residue < residue || (transparent < 0.05 && after.transparent >= 0.05);
    return spriteSurvived && improved ? retried : keyed;
  }

  return keyed;
}

/**
 * Locate the real cell boundaries of a drawn sprite-sheet grid. Image models do NOT
 * space their grids perfectly uniformly — a fixed w/cols cut lands inside a limb a
 * few percent of the time and clips it out of that frame. Projection profiling finds
 * the true background gutters: per column/row, count pixels that differ from the
 * dominant border (backdrop) color, then within a ±6% window around each expected
 * uniform boundary pick the emptiest line. Bounded by the window, so a noisy profile
 * can never do worse than a slightly shifted uniform cut.
 */
export function detectGridCuts(canvas, { cols, rows }) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;

  // Dominant border color — same rationale as removeBorderBackground.
  const bins = new Map();
  const addPx = (x, y) => {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = { count: 0, r: 0, g: 0, b: 0 }; bins.set(key, bin); }
    bin.count++; bin.r += r; bin.g += g; bin.b += b;
  };
  for (let x = 0; x < w; x++) { addPx(x, 0); addPx(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { addPx(0, y); addPx(w - 1, y); }
  let dom = null;
  for (const bin of bins.values()) if (!dom || bin.count > dom.count) dom = bin;
  const br = dom.r / dom.count, bg = dom.g / dom.count, bb = dom.b / dom.count;

  const isContent = (i) => {
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db > 60 * 60;
  };
  const colProfile = new Float32Array(w);
  const rowProfile = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isContent((y * w + x) * 4)) { colProfile[x] += 1 / h; rowProfile[y] += 1 / w; }
    }
  }

  const cutVals = [];
  const cutsFor = (profile, size, parts) => {
    const cuts = [0];
    for (let k = 1; k < parts; k++) {
      const expected = Math.round((size * k) / parts);
      const win = Math.max(3, Math.round(size * 0.06));
      let best = expected, bestVal = Infinity;
      for (let p = expected - win; p <= expected + win; p++) {
        if (p <= cuts[cuts.length - 1] + 8 || p >= size - 8) continue;
        // Tiny distance penalty: among equally empty gutters prefer the uniform cut.
        const v = profile[p] + (Math.abs(p - expected) / size) * 0.02;
        if (v < bestVal) { bestVal = v; best = p; }
      }
      cuts.push(best);
      cutVals.push(profile[best] ?? 1);
    }
    cuts.push(size);
    return cuts;
  };
  const xCuts = cutsFor(colProfile, w, cols);
  const yCuts = cutsFor(rowProfile, h, rows);
  // cutScore: mean content density at the chosen interior gutters — 0 means the
  // grid hypothesis found genuinely empty dividers; high values mean the cuts run
  // through content. Used to pick between candidate sheet layouts.
  const cutScore = cutVals.length ? cutVals.reduce((a, b) => a + b, 0) / cutVals.length : 0;
  return { xCuts, yCuts, cutScore };
}

// Fraction of OPAQUE pixels that are chroma-screen colored — the "a green frame
// shipped" detector (2026-08-16: a slice cut through touching strip frames left a
// cell the border-flood couldn't key; the green backdrop survived every gate). Chroma
// on a finished sprite is ALWAYS illegal (the prompt bans it on the subject), so
// detection is unambiguous.
// Saturated screen color OR its pale washed-out drift (models fade the backdrop
// toward a desaturated tint across long strips — live defect 2026-08-18: pale
// mint cells slipped past the exact-green sweep, poisoned the scorer and nulled
// the idle frame). The pale branch demands high brightness AND chroma-channel
// dominance, so white/gray content and skin tones never match.
function isChromaResidue(r, g, b, chroma) {
  if (chroma === 'green') {
    return (g >= 140 && g >= r + 50 && g >= b + 50) ||
      (g >= 170 && r >= 110 && b >= 110 && g >= r + 12 && g >= b + 12);
  }
  return (r >= 140 && b >= 140 && r >= g + 50 && b >= g + 50) ||
    (r >= 170 && b >= 170 && g >= 110 && r >= g + 12 && b >= g + 12);
}

export function chromaResidueFraction(canvas, chroma) {
  if (!chroma) return 0;
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let opaque = 0, hit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    opaque++;
    if (isChromaResidue(data[i], data[i + 1], data[i + 2], chroma)) hit++;
  }
  return opaque ? hit / opaque : 0;
}

// Clears every pixel matching the (saturated OR pale) chroma predicate. The
// predicate is strict enough that matches are backdrop with high confidence
// REGARDLESS of how much of the cell they cover (a badly-keyed cell is often
// mostly wash — replay-measured 23-43% on the 2026-08-18 capture, which a low
// guard reverted, re-shipping the stain). The guard only catches the
// pathological all-backdrop cell; pickChromaColor already steers
// chroma-adjacent subjects onto the other screen color.
export function removeChromaResidue(canvas, chroma, { guard = 0.85 } = {}) {
  if (!chroma) return canvas;
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  let opaque = 0, removed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    opaque++;
    if (isChromaResidue(data[i], data[i + 1], data[i + 2], chroma)) {
      data[i + 3] = 0;
      removed++;
    }
  }
  if (!removed || (opaque && removed / opaque > guard)) return canvas; // guard: revert by not writing
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Pick the sheet slicing layout whose grid hypothesis fits the served image best:
// draw the image at each candidate's canvas, detect cuts, and take the layout with
// the emptiest gutters. This is how the 1×5 strip request self-heals when a model
// ignores the 4:1 aspect (ratio dropped by the provider fallback, or the 2.5
// fallback model) and renders a grid arrangement instead.
function pickSheetLayout(img, spec) {
  const layouts = spec.sheetLayouts;
  if (!layouts?.length) return { cols: spec.frames.cols, rows: spec.frames.rows, canvas: spec.canvas };
  let best = null;
  for (const layout of layouts) {
    const canvas = drawToCanvas(img, { ...layout.canvas, fit: spec.post.fit });
    const { cutScore } = detectGridCuts(canvas, layout);
    if (!best || cutScore < best.cutScore - 1e-6) best = { ...layout, cutScore };
  }
  return best;
}

/**
 * Slice a RAW (un-keyed) grid image into per-cell PNG data URLs at DETECTED cell
 * boundaries — the combined-props call's slicer. Unlike processSheet this does NO
 * keying and NO re-centering: each cell data URL is handed to that slot's own
 * postProcessAsset run, so the slot's full contract (keying, edge chain,
 * fillAfterCrop/solidify, trim/crop) applies exactly as on an individual call.
 * The inset discards model-drawn grid lines at cell edges. Degenerate cells
 * (cuts collapsed to a sliver) come back as null so the caller can fall back
 * per slot.
 */
export async function sliceRawGrid(rawSrc, { cols, rows, insetFrac = 0.01 } = {}) {
  const img = await loadImage(rawSrc);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = drawToCanvas(img, { width: w, height: h, fit: 'stretch' });
  const { xCuts, yCuts } = detectGridCuts(canvas, { cols, rows });
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = xCuts[c], sw = xCuts[c + 1] - sx;
      const sy = yCuts[r], sh = yCuts[r + 1] - sy;
      const inset = Math.max(2, Math.round(Math.min(sw, sh) * insetFrac));
      const cw = sw - inset * 2, ch = sh - inset * 2;
      if (cw < 16 || ch < 16) { cells.push(null); continue; }
      const cell = document.createElement('canvas');
      cell.width = cw;
      cell.height = ch;
      cell.getContext('2d').drawImage(canvas, sx + inset, sy + inset, cw, ch, 0, 0, cw, ch);
      cells.push(cell.toDataURL('image/png'));
    }
  }
  return cells;
}

/**
 * Draw a raw sheet at spec size, slice it at DETECTED cell boundaries, and flood-key
 * EACH CELL independently.
 *
 * Keying the whole sheet from its outer border fails structurally on grids with
 * interior cells (a 3×3 center cell never touches the sheet border, so its backdrop
 * is unreachable by the flood). Per-cell keying gives every cell its own reachable
 * border; the small inset also discards any grid lines the model drew at cell edges.
 * Detected cells vary by a few pixels, so each is re-centered (never scaled) onto a
 * uniform cell canvas — alignFrames re-anchors precisely later.
 * Returns { previewImg (keyed sheet for QA/gating), cells }.
 */
export async function processSheet(rawSrc, spec, { inset = 3, chroma = null } = {}) {
  const img = await loadImage(rawSrc);
  // Candidate-layout pick (strip vs grid) from the served image itself — see
  // pickSheetLayout. Specs without sheetLayouts keep their fixed frames grid.
  const layout = pickSheetLayout(img, spec);
  const canvas = drawToCanvas(img, { ...(layout.canvas || spec.canvas), fit: spec.post.fit });
  const { cols, rows } = layout;
  const { xCuts, yCuts } = detectGridCuts(canvas, { cols, rows });
  const cellW = Math.floor(canvas.width / cols);
  const cellH = Math.floor(canvas.height / rows);
  const rawCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = xCuts[c], sw = xCuts[c + 1] - sx;
      const sy = yCuts[r], sh = yCuts[r + 1] - sy;
      const cell = document.createElement('canvas');
      cell.width = cellW;
      cell.height = cellH;
      // Detected cuts can exceed the uniform cell size (the ±6% search window);
      // an unclamped draw put the overflow OFF-canvas (negative dest) and clipped
      // heads on multi-row layouts. Scale-to-fit keeps all content; alignFrames'
      // height normalization absorbs the small per-cell size delta.
      const fitScale = Math.min(1, cellW / sw, cellH / sh);
      const dw = Math.round(sw * fitScale);
      const dh = Math.round(sh * fitScale);
      cell.getContext('2d').drawImage(
        canvas, sx, sy, sw, sh,
        Math.floor((cellW - dw) / 2), Math.floor((cellH - dh) / 2), dw, dh
      );
      rawCells.push(cell);
    }
  }
  const boxedFlags = [];
  const cells = rawCells
    // Strip layouts (rows 1) have only VERTICAL gutters/dividers to discard —
    // a full 3px vertical inset was shaving the top of every head flat (a
    // full-body character fills the 128px cell). 1px still drops edge artifacts.
    .map((cell) => insetCanvas(cell, inset, rows > 1 ? inset : 1))
    .map((cell) => keyCellWithQuality(cell, { chroma }))
    // White card/panel behind the character (inherited from a boxed static
    // reference, or drawn fresh) — strip it per cell before pocket/edge work.
    .map((cell) => { if (chroma && spec.post.pocketClean) removeBackdropCard(cell, { chroma }); return cell; })
    // Remember which cells STILL carry a card (judged before the edge chain —
    // outline/bleed blur the geometry); re-attached to the final cells below so
    // the pipeline can cull them without re-deriving it from softened pixels.
    .map((cell, i) => { boxedFlags[i] = !!(chroma && spec.post.pocketClean && hasBackdropCard(cell)); return cell; })
    .map((cell) => (spec.post.pocketClean ? removeEnclosedPockets(cell, { chroma }) : cell))
    // Chroma-residue rescue: when the border-flood failed a cell (content sliced
    // across the boundary → wrong seed color) a swath of screen color survives.
    // A global key of the chroma color is always safe — the prompt bans it on
    // the subject — so sweep it before the edge chain.
    .map((cell) => {
      if (!chroma || chromaResidueFraction(cell, chroma) <= 0.08) return cell;
      const rgb = chroma === 'green' ? { r: 0, g: 255, b: 0 } : { r: 255, g: 0, b: 255 };
      removeFlatColor(cell, rgb, { tol: 110, soft: 60 });
      // Second rung for the PALE drift the exact sweep can't reach (mint/pink
      // wash) — guarded predicate sweep; a rescued cell no longer pre-flags the
      // scorer or nulls the idle frame.
      if (chromaResidueFraction(cell, chroma) > 0.03) removeChromaResidue(cell, chroma);
      return cell;
    })
    // Transparent headroom BEFORE the edge chain (after keying — padding earlier
    // would poison the border-seeded flood) so erode/outline treat the head's top
    // like any other edge. Uniform across cells; the union crop trims it back off.
    .map((cell) => padCanvasTop(cell, 4))
    .map((cell) => cleanKeyedEdges(cell, { erode: 1, outline: !!spec.post.outline, despill: chroma }));
  cells.forEach((cell, i) => { cell.pmBoxed = !!boxedFlags[i]; });
  const preview = assembleSheet(cells, { cols, rows });
  const previewImg = await loadImage(preview.canvas.toDataURL('image/png'), { crossOrigin: null });
  return { previewImg, cells, layout: { cols, rows } };
}

/**
 * Turn keyed cells into the final uniform spritesheet:
 * mirror per-frame if requested (mirroring the whole sheet would swap the cell order)
 * → align frames (center-x + shared bottom baseline + capped height normalization —
 *   removes the model's per-cell drift, the main animation-jitter source)
 * → crop all frames to the union bbox at alpha≥16 (per-frame crop would re-introduce
 *   jitter; the alpha bar keeps one stray pixel from inflating the box)
 * → reassemble → decoded image. Returns null when the cells have no content.
 * `framesMeta` overrides spec.frames for culled or per-frame-generated layouts
 * (e.g. a 1×N strip); the returned meta contract is unchanged.
 */
export async function finalizeSheetFrames(cells, spec, { mirror = false, framesMeta = null } = {}) {
  const layout = framesMeta || spec.frames;
  const mirrored = mirror ? cells.map(mirrorCanvas) : cells;
  const frames = alignFrames(mirrored, { runFrameCount: layout.runFrameCount ?? cells.length });
  const bounds = unionContentBounds(frames, { alphaMin: 16 });
  if (!bounds) return null;
  const pad = 2;
  const minX = Math.max(0, bounds.minX - pad);
  const minY = Math.max(0, bounds.minY - pad);
  const maxX = Math.min(frames[0].width - 1, bounds.maxX + pad);
  const maxY = Math.min(frames[0].height - 1, bounds.maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cropped = frames.map((frame) => {
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d').putImageData(frame.getContext('2d').getImageData(minX, minY, cw, ch), 0, 0);
    return out;
  });
  const { canvas, frameWidth, frameHeight } = assembleSheet(cropped, layout);
  const sheetImg = await loadImage(canvas.toDataURL('image/png'), { crossOrigin: null });
  return { img: sheetImg, frames: { ...layout, frameWidth, frameHeight } };
}

/**
 * Erode the alpha edge: remove opaque/semi pixels that touch transparency
 * (8-neighborhood), `iterations` times. Kills the ring of anti-aliased pixels that
 * are a white-backdrop blend — the flood keyer keeps them ("not white enough") and
 * they read as a bright fringe on dark game backgrounds.
 */
export function erodeAlphaEdge(canvas, iterations = 1) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let it = 0; it < iterations; it++) {
    const toClear = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        let touchesVoid = false;
        for (let dy = -1; dy <= 1 && !touchesVoid; dy++) {
          for (let dx = -1; dx <= 1 && !touchesVoid; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) { touchesVoid = true; break; }
            if (data[(ny * w + nx) * 4 + 3] === 0) touchesVoid = true;
          }
        }
        if (touchesVoid) toClear.push(i);
      }
    }
    for (const i of toClear) data[i + 3] = 0;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Bleed edge colors into transparent pixels (RGB only, alpha stays 0).
 * WebGL bilinear filtering samples the RGB of transparent neighbors when it draws a
 * scaled sprite edge — and keyed pixels keep their original (white) RGB, which paints
 * a halo at render time no matter how good the mask is. Extending real sprite colors
 * outward gives the filter nothing white to sample. Standard sprite-pipeline step.
 */
export function bleedEdgeColors(canvas, iterations = 4) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const filled = new Uint8Array(w * h); // transparent pixels whose RGB is already real
  for (let it = 0; it < iterations; it++) {
    const writes = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (data[p * 4 + 3] !== 0 || filled[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const np = ny * w + nx;
            if (data[np * 4 + 3] > 0 || filled[np]) {
              r += data[np * 4]; g += data[np * 4 + 1]; b += data[np * 4 + 2]; n++;
            }
          }
        }
        if (n > 0) writes.push([p, Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      }
    }
    if (writes.length === 0) break;
    for (const [p, r, g, b] of writes) {
      data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b;
      filled[p] = 1;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Stamp a dark outline UNDER the sprite (dilate the alpha mask into transparency).
 * The classic pixel-art readability guarantee: a character with a dark outline stays
 * legible on any background, whatever palette the model actually painted.
 */
export function addOutline(canvas, { thickness = 2, color = [15, 18, 26] } = {}) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let it = 0; it < thickness; it++) {
    const writes = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (data[p * 4 + 3] !== 0) continue;
        let touchesSprite = false;
        for (let dy = -1; dy <= 1 && !touchesSprite; dy++) {
          for (let dx = -1; dx <= 1 && !touchesSprite; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (data[(ny * w + nx) * 4 + 3] > 0) touchesSprite = true;
          }
        }
        if (touchesSprite) writes.push(p);
      }
    }
    for (const p of writes) {
      data[p * 4] = color[0]; data[p * 4 + 1] = color[1]; data[p * 4 + 2] = color[2];
      data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Multiply the RGB of visible pixels toward black (atmospheric-depth grading for
 * parallax layers: nearer silhouette planes render darker than the far backdrop).
 */
export function darkenCanvas(canvas, factor) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = Math.round(data[i] * factor);
    data[i + 1] = Math.round(data[i + 1] * factor);
    data[i + 2] = Math.round(data[i + 2] * factor);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Chroma spill suppression along the alpha edge. Anti-aliased edge pixels blend the
 * sprite with the screen color; after keying they survive as a green/magenta fringe
 * the erode pass can't fully reach on thin details. Classic despill formulas
 * (green: cap G at max(R,B); magenta: pull R/B toward G), applied ONLY within
 * `range` px of transparency so legitimately green/magenta sprite interiors are
 * never touched.
 */
export function despillEdges(canvas, chroma, { range = 2 } = {}) {
  if (chroma !== 'green' && chroma !== 'magenta') return canvas;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // Distance-to-transparency rings via iterative dilation of the transparent set.
  let frontier = new Uint8Array(w * h);
  const edgeband = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] === 0) frontier[i] = 1;
  for (let ring = 0; ring < range; ring++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (frontier[p] || edgeband[p] || data[p * 4 + 3] === 0) continue;
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          for (let dx = -1; dx <= 1 && !touches; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && frontier[ny * w + nx]) touches = true;
          }
        }
        if (touches) { next[p] = 1; edgeband[p] = 1; }
      }
    }
    frontier = next;
  }

  for (let p = 0; p < w * h; p++) {
    if (!edgeband[p]) continue;
    const i = p * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (chroma === 'green') {
      if (g > r && g > b) data[i + 1] = Math.max(r, b);
    } else {
      if (r > g && b > g) {
        data[i] = Math.round((r + g) / 2);
        data[i + 2] = Math.round((b + g) / 2);
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * The post-keying edge chain, in the only order that works:
 * erode (kill the backdrop-blend AA ring) → despill (neutralize chroma fringe the
 * erode couldn't reach) → outline (stamp dark ring under the sprite) → bleed (fill
 * transparent RGB so bilinear filtering can't sample the backdrop color).
 */
export function cleanKeyedEdges(canvas, { erode = 1, outline = false, outlineThickness = 2, despill = null } = {}) {
  if (erode > 0) erodeAlphaEdge(canvas, erode);
  if (despill) despillEdges(canvas, despill);
  if (outline) addOutline(canvas, { thickness: outlineThickness });
  bleedEdgeColors(canvas);
  return canvas;
}

// Mean luma (0.299r+0.587g+0.114b) over meaningfully-opaque pixels; null when none.
function meanOpaqueLuma(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  return n ? sum / n : null;
}

/**
 * Fraction of the whole canvas that is opaque AND near-white/pale — the layer-slot
 * failure signature (white sky pockets partitioned off from the border by thin shapes
 * crossing the frame, which the border flood can never reach). Whole-canvas on
 * purpose: the existing gates only look at the top band or the border.
 */
export function brightResidueFraction(canvas, { minChannel = 225 } = {}) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let bright = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (data[i] >= minChannel && data[i + 1] >= minChannel && data[i + 2] >= minChannel) bright++;
  }
  return bright / (w * h);
}

function applyKeying(canvas, keying, keyOverrides, post = {}, whiteOverrides = null) {
  if (keying === 'flood') return removeBorderBackground(canvas, keyOverrides);
  if (keying === 'white') return removeWhiteBackground(canvas, keyOverrides);
  if (keying === 'flood+white') {
    // For silhouette/prop layers: flood removes the border-connected backdrop, then the
    // global white pass clears white pockets ENCLOSED between shapes (which flood-fill
    // deliberately keeps for character sprites, but which read as leftovers on layers).
    // The white pass runs strict (near-pure white only) — at the default threshold it
    // also ate light-colored prop details, not just leftover pockets.
    removeBorderBackground(canvas, keyOverrides);
    const ctx = canvas.getContext('2d');
    const beforeWhite = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const keptBefore = 1 - alphaFraction(canvas);
    removeWhiteBackground(canvas, whiteOverrides || { threshold: 236, hardCut: 248 });
    const removedByWhite = keptBefore - (1 - alphaFraction(canvas));
    // Dissolve guard: a pocket-clearing pass should nibble, not devour. If it removed
    // more than 20% of what the flood had kept, it was eating content — revert it.
    // EXCEPT on silhouette slots whose surviving content is near-black (the layer
    // contract): there a big white removal is exactly the enclosed-sky pocket this
    // pass exists for, and the old unconditional revert was what SHIPPED the white
    // patches (the bigger the patch, the more certainly it got reverted).
    if (keptBefore > 0 && removedByWhite / keptBefore > 0.2) {
      const darkContent = post.silhouette && (meanOpaqueLuma(canvas) ?? 255) < 110;
      if (!darkContent) ctx.putImageData(beforeWhite, 0, 0);
    }
    return canvas;
  }
  return canvas;
}

/**
 * Run the full post-process chain for one slot and return a decoded HTMLImageElement.
 * The data-URL round-trip keeps the resulting texture untainted so downstream code
 * (SpriteAlignmentManager) can read its pixels.
 *
 * spec.post: { fit, keying: 'flood'|'white'|null, trimBorder, crop, minAlphaFraction? }
 * opts.keyOverrides — looser tolerances for QA-driven re-key retries; requires rawSrc,
 * so callers keep the raw source around.
 * opts.whiteOverrides — looser white-pass thresholds for the 'flood+white' secondary
 * pass (silhouette-layer re-keys only).
 * opts.chroma — 'green'|'magenta' when the prompt asked for a chroma-key backdrop;
 * enables the edge despill pass (the flood keyer itself is backdrop-color agnostic).
 */
export async function postProcessAsset(rawSrc, spec, opts = {}) {
  const img = await loadImage(rawSrc);
  let canvas;
  if (spec.post.trimBorder) {
    // Trim the model-painted margin at native resolution BEFORE stretching, or the
    // margin gets baked in and shows as seams when tiled
    canvas = drawToCanvas(img, { width: img.width, height: img.height, fit: 'stretch' });
    canvas = trimUniformBorder(canvas);
    canvas = drawToCanvas(canvas, { ...spec.canvas, fit: spec.post.fit });
  } else {
    canvas = drawToCanvas(img, { ...spec.canvas, fit: spec.post.fit });
  }
  canvas = applyKeying(canvas, spec.post.keying, opts.keyOverrides, spec.post, opts.whiteOverrides || null);
  // Character slots on a chroma screen: strip a white card/panel the model put
  // behind the subject (the flood stops at its edge) — see removeBackdropCard.
  let boxed = false;
  if (spec.post.keying && spec.post.pocketClean && opts.chroma) {
    removeBackdropCard(canvas, { chroma: opts.chroma });
    // Judged HERE, before outline/bleed soften the geometry: a card the remover
    // could not safely strip (e.g. a limb protruding past it) must still be
    // reported, so the caller can re-roll instead of shipping a boxed sprite.
    boxed = hasBackdropCard(canvas);
  }
  // Enclosed-gap pockets (arm/torso gaps painted backdrop-color) BEFORE the edge
  // chain, so the cleared gaps get the same outline treatment as real edges.
  if (spec.post.keying && spec.post.pocketClean) {
    removeEnclosedPockets(canvas, { chroma: opts.chroma || null });
  }
  if (spec.post.keying) {
    cleanKeyedEdges(canvas, {
      erode: spec.post.edgeErode ?? 1,
      outline: !!spec.post.outline,
      despill: opts.chroma || null
    });
  }
  if (spec.post.darken) darkenCanvas(canvas, spec.post.darken);
  if (spec.post.crop) canvas = cropCanvasToContent(canvas);
  // Re-fill the spec canvas after cropping: consumers that tile the texture into a
  // fixed-size physics box (platforms) need the art to exactly fill the frame, or the
  // visible shape and the hitbox drift apart.
  if (spec.post.fillAfterCrop) canvas = drawToCanvas(canvas, { ...spec.canvas, fit: 'stretch' });
  if (spec.post.solidify) solidifyColumns(canvas);
  const out = await loadImage(canvas.toDataURL('image/png'), { crossOrigin: null });
  out.pmBoxed = boxed; // read by the pipeline's boxed-sprite gate
  return out;
}
