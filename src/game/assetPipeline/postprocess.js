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

  if (fit === 'cover') {
    const scale = Math.max(width / img.width, height / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  } else {
    ctx.drawImage(img, 0, 0, width, height);
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
 */
export function contentBoundsOf(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
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
 * Fraction of the canvas's outer band occupied by OPAQUE near-white pixels.
 * A keyed + content-cropped sprite hugs its bounding box, so near-white pixels
 * sitting along the frame edge are leftover backdrop the flood fill failed to
 * reach — a deterministic "keying failed" signal that needs no vision model.
 */
export function borderResidueFraction(canvas, { band = 0.12, threshold = 228 } = {}) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const bx = Math.max(1, Math.round(w * band));
  const by = Math.max(1, Math.round(h * band));
  let ring = 0;
  let residue = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bx && x < w - bx && y >= by && y < h - by) continue;
      ring++;
      const i = (y * w + x) * 4;
      if (data[i + 3] > 0 && data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
        residue++;
      }
    }
  }
  return ring === 0 ? 0 : residue / ring;
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
  maxRemovedFraction = 0.95
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
    // Something pathological (e.g. sprite same color as backdrop) — fall back to the
    // conservative white keyer rather than erasing the whole image
    return removeWhiteBackground(canvas);
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
export function unionContentBounds(frames) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const frame of frames) {
    const w = frame.width, h = frame.height;
    const data = frame.getContext('2d').getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
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

function insetCanvas(canvas, inset) {
  const w = canvas.width - inset * 2;
  const h = canvas.height - inset * 2;
  if (w <= 0 || h <= 0) return canvas;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, inset, inset, w, h, 0, 0, w, h);
  return out;
}

/**
 * Draw a raw sheet at spec size, slice it, and flood-key EACH CELL independently.
 *
 * Keying the whole sheet from its outer border fails structurally on grids with
 * interior cells (a 3×3 center cell never touches the sheet border, so its backdrop
 * is unreachable by the flood). Per-cell keying gives every cell its own reachable
 * border; the small inset also discards any grid lines the model drew at cell edges.
 * Returns { previewImg (keyed sheet for QA/gating), cells }.
 */
export async function processSheet(rawSrc, spec, { inset = 3 } = {}) {
  const img = await loadImage(rawSrc);
  const canvas = drawToCanvas(img, { ...spec.canvas, fit: spec.post.fit });
  const cells = sliceGrid(canvas, spec.frames)
    .map((cell) => insetCanvas(cell, inset))
    .map((cell) => removeBorderBackground(cell))
    .map((cell) => cleanKeyedEdges(cell, { erode: 1, outline: !!spec.post.outline }));
  const preview = assembleSheet(cells, spec.frames);
  const previewImg = await loadImage(preview.canvas.toDataURL('image/png'), { crossOrigin: null });
  return { previewImg, cells };
}

/**
 * Turn keyed cells into the final uniform spritesheet:
 * mirror per-frame if requested (mirroring the whole sheet would swap the cell order)
 * → crop all frames to the union bbox (per-frame crop would make animation jitter)
 * → reassemble → decoded image. Returns null when the cells have no content.
 */
export async function finalizeSheetFrames(cells, spec, { mirror = false } = {}) {
  let frames = mirror ? cells.map(mirrorCanvas) : cells;
  const bounds = unionContentBounds(frames);
  if (!bounds) return null;
  const cw = bounds.maxX - bounds.minX + 1;
  const ch = bounds.maxY - bounds.minY + 1;
  const cropped = frames.map((frame) => {
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d').putImageData(frame.getContext('2d').getImageData(bounds.minX, bounds.minY, cw, ch), 0, 0);
    return out;
  });
  const { canvas, frameWidth, frameHeight } = assembleSheet(cropped, spec.frames);
  const sheetImg = await loadImage(canvas.toDataURL('image/png'), { crossOrigin: null });
  return { img: sheetImg, frames: { ...spec.frames, frameWidth, frameHeight } };
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
 * The post-keying edge chain, in the only order that works:
 * erode (kill the white-blend AA ring) → outline (stamp dark ring under the sprite)
 * → bleed (fill transparent RGB so bilinear filtering can't sample white).
 */
export function cleanKeyedEdges(canvas, { erode = 1, outline = false, outlineThickness = 2 } = {}) {
  if (erode > 0) erodeAlphaEdge(canvas, erode);
  if (outline) addOutline(canvas, { thickness: outlineThickness });
  bleedEdgeColors(canvas);
  return canvas;
}

function applyKeying(canvas, keying, keyOverrides) {
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
    removeWhiteBackground(canvas, { threshold: 236, hardCut: 248 });
    const removedByWhite = keptBefore - (1 - alphaFraction(canvas));
    // Dissolve guard: a pocket-clearing pass should nibble, not devour. If it removed
    // more than 20% of what the flood had kept, it was eating content — revert it.
    if (keptBefore > 0 && removedByWhite / keptBefore > 0.2) {
      ctx.putImageData(beforeWhite, 0, 0);
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
  canvas = applyKeying(canvas, spec.post.keying, opts.keyOverrides);
  if (spec.post.keying) {
    cleanKeyedEdges(canvas, {
      erode: spec.post.edgeErode ?? 1,
      outline: !!spec.post.outline
    });
  }
  if (spec.post.darken) darkenCanvas(canvas, spec.post.darken);
  if (spec.post.crop) canvas = cropCanvasToContent(canvas);
  // Re-fill the spec canvas after cropping: consumers that tile the texture into a
  // fixed-size physics box (platforms) need the art to exactly fill the frame, or the
  // visible shape and the hitbox drift apart.
  if (spec.post.fillAfterCrop) canvas = drawToCanvas(canvas, { ...spec.canvas, fit: 'stretch' });
  if (spec.post.solidify) solidifyColumns(canvas);
  return loadImage(canvas.toDataURL('image/png'), { crossOrigin: null });
}
