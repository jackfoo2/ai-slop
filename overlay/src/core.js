// AI Slop Overlay — vision core (platform-independent, pure JS on RGBA pixel buffers).
// 1) findRegions: where are the pictures on this screen? (pixels only, no web page access)
// 2) Tracker: keep every picture's box glued to it while the page scrolls.

const lumOf = (d, i) => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;

/** The page's background colors: neutral (white/gray/black) colors that cover a lot of the screen. */
export function backgroundColors(img) {
  const { data, width: W, height: H } = img;
  const hist = new Map(); let n = 0;
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    const q = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    hist.set(q, (hist.get(q) || 0) + 1); n++;
  }
  const bg = [];
  for (const [q, c] of hist) {
    if (c / n < 0.04) continue;
    const r = (q >> 10) << 3, g = ((q >> 5) & 31) << 3, b = (q & 31) << 3;
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 24) bg.push([r + 4, g + 4, b + 4]);
  }
  return bg.length ? bg : [[255, 255, 255]];
}

/**
 * Find pictures: big, solid, varied rectangles that aren't page background.
 * Blocks with almost no background pixels are "content"; text blocks are mostly background
 * with thin strokes, so they drop out. Content blocks are grouped, and a group counts as a
 * picture when it's big, boxy, and varied inside (not a flat button or panel).
 */
export function findRegions(img, opt = {}) {
  const { data, width: W, height: H } = img;
  const B = opt.block || 8;
  const minW = opt.minW || 100, minH = opt.minH || 80;
  const bg = opt.bg || backgroundColors(img);
  const wd = opt.wall || null; // the desktop wallpaper as laid out on screen: pixels matching it count as background
  const isBg = (i) => {
    if (wd && Math.abs(data[i] - wd[i]) + Math.abs(data[i + 1] - wd[i + 1]) + Math.abs(data[i + 2] - wd[i + 2]) <= 30) return true;
    for (const c of bg) if (Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]) <= 18) return true;
    return false;
  };
  const bw = Math.floor(W / B), bh = Math.floor(H / B);
  const mask = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let nb = 0, n = 0;
    for (let y = 0; y < B; y += 2) { let i = ((by * B + y) * W + bx * B) * 4; for (let x = 0; x < B; x += 2, i += 8) { n++; if (isBg(i)) nb++; } }
    mask[by * bw + bx] = nb / n < 0.2 ? 1 : 0;
  }
  const m = erode(dilate(mask, bw, bh, 1), bw, bh, 1);  // close pinholes (white bits inside photos)
  const boxes = [];
  for (const c of components(m, bw, bh)) {
    const whole = { x: c.x0 * B, y: c.y0 * B, w: (c.x1 - c.x0 + 1) * B, h: (c.y1 - c.y0 + 1) * B };
    const before = boxes.length;
    if (whole.w < minW || whole.h < minH) { cutout(); continue; }
    // pictures packed close together (galleries, folders of thumbnails) can blur into one blob:
    // cut it apart wherever a clean strip of background runs all the way through
    for (const part of xyCut(img, whole, isBg, 0)) {
      if (part.w < minW || part.h < minH) continue;
      if (blockFill(m, bw, part, B) < 0.7) continue;
      const b = refineEdges(img, part, B, isBg);
      if (b.w < minW || b.h < minH) continue;
      if (!varied(img, b)) continue; // flat panels and buttons aren't pictures
      boxes.push(b);
    }
    cutout();
    // A picture whose own background matches the page (white on white, black on black) shows up only as
    // its subject: an odd-shaped blob instead of a rectangle. Accept it if it's big enough and genuinely
    // colorful (big text and logos are two-tone, so they don't qualify).
    function cutout() {
      if (boxes.length > before) return;
      const area = whole.w * whole.h, short = Math.min(whole.w, whole.h), aspect = whole.w / whole.h;
      if (area < 0.8 * minW * minH || short < 0.35 * minW || aspect < 0.25 || aspect > 4) return;
      if (c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) < 0.3) return;
      if (!colorful(img, whole, isBg)) return;
      boxes.push({ ...whole, cutout: true });
    }
  }
  return boxes;
}

/** Split a box at full-height or full-width strips of background (at least 3 px), recursively. */
function xyCut(img, b, isBg, depth) {
  if (depth > 8) return [b];
  const W = img.width;
  const colFrac = (x) => { let nb = 0, n = 0; for (let y = b.y; y < b.y + b.h; y += 3) { n++; if (isBg((y * W + x) * 4)) nb++; } return nb / n; };
  const rowFrac = (y) => { let nb = 0, n = 0; for (let x = b.x; x < b.x + b.w; x += 3) { n++; if (isBg((y * W + x) * 4)) nb++; } return nb / n; };
  const v = findGap(b.x, b.x + b.w, colFrac);
  if (v) return [...xyCut(img, { x: b.x, y: b.y, w: v.start - b.x, h: b.h }, isBg, depth + 1), ...xyCut(img, { x: v.end, y: b.y, w: b.x + b.w - v.end, h: b.h }, isBg, depth + 1)];
  const h = findGap(b.y, b.y + b.h, rowFrac);
  if (h) return [...xyCut(img, { x: b.x, y: b.y, w: b.w, h: h.start - b.y }, isBg, depth + 1), ...xyCut(img, { x: b.x, y: h.end, w: b.w, h: b.y + b.h - h.end }, isBg, depth + 1)];
  return [b];
}
function findGap(lo, hi, frac, margin = 40) {
  let run = -1;
  for (let v = lo + margin; v < hi - margin; v++) {
    if (frac(v) >= 0.85) { if (run < 0) run = v; }
    else { if (run >= 0 && v - run >= 3) return { start: run, end: v }; run = -1; }
  }
  return null;
}
function blockFill(m, bw, b, B) {
  const x0 = Math.floor(b.x / B), x1 = Math.ceil((b.x + b.w) / B), y0 = Math.floor(b.y / B), y1 = Math.ceil((b.y + b.h) / B);
  let n = 0, t = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { t++; if (m[y * bw + x]) n++; }
  return t ? n / t : 0;
}

/** Many distinct colors among the non-background pixels (a picture), not a few (text, logos, icons). */
function colorful(img, b, isBg) {
  const { data, width: W } = img, seen = new Set();
  let n = 0, fg = 0;
  const st = Math.max(2, Math.floor(Math.sqrt((b.w * b.h) / 3000)));
  for (let y = b.y; y < b.y + b.h; y += st) for (let x = b.x; x < b.x + b.w; x += st) {
    const i = (y * W + x) * 4; n++;
    if (isBg(i)) continue;
    fg++; seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
  }
  return fg / n >= 0.2 && seen.size >= 24;
}

function varied(img, b) {
  const { data, width: W } = img;
  let s = 0, s2 = 0, n = 0;
  const st = Math.max(2, Math.floor(Math.sqrt((b.w * b.h) / 2500)));
  for (let y = b.y; y < b.y + b.h; y += st) for (let x = b.x; x < b.x + b.w; x += st) { const l = lumOf(data, (y * W + x) * 4); s += l; s2 += l * l; n++; }
  const mean = s / n; return Math.sqrt(Math.max(0, s2 / n - mean * mean)) >= 10;
}

/** Move each edge to the exact row/column where the picture meets the page background. */
function refineEdges(img, b, B, isBg) {
  const { width: W, height: H } = img;
  const rowBgFrac = (y, x0, x1) => { let nb = 0, n = 0; for (let x = x0; x < x1; x += 2) { n++; if (isBg((y * W + x) * 4)) nb++; } return nb / n; };
  const colBgFrac = (x, y0, y1) => { let nb = 0, n = 0; for (let y = y0; y < y1; y += 2) { n++; if (isBg((y * W + x) * 4)) nb++; } return nb / n; };
  const ix0 = b.x + B, ix1 = Math.min(W - 1, b.x + b.w - B), iy0 = b.y + B, iy1 = Math.min(H - 1, b.y + b.h - B);
  if (ix1 - ix0 < 8 || iy1 - iy0 < 8) return b;
  // a picture row is almost all non-background (text rows, even smudged, stay well above 25% background)
  const scan = (from, to, step, frac) => { let v = from; for (let k = from; step > 0 ? k <= to : k >= to; k += step) { if (frac(k) < 0.25) return k; v = k; } return v; };
  const y0 = scan(Math.max(0, b.y - B), b.y + 3 * B, 1, (y) => rowBgFrac(y, ix0, ix1));
  const y1 = scan(Math.min(H - 1, b.y + b.h + B), b.y + b.h - 3 * B, -1, (y) => rowBgFrac(y, ix0, ix1));
  const x0 = scan(Math.max(0, b.x - B), b.x + 3 * B, 1, (x) => colBgFrac(x, iy0, iy1));
  const x1 = scan(Math.min(W - 1, b.x + b.w + B), b.x + b.w - 3 * B, -1, (x) => colBgFrac(x, iy0, iy1));
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function dilate(m, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) o[yy * w + xx] = 1; }
  }
  return o;
}
function erode(m, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ok = 1;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w || !m[yy * w + xx]) { ok = 0; break; } }
    o[y * w + x] = ok;
  }
  return o;
}
function components(m, w, h) {
  const seen = new Uint8Array(w * h), out = [], stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = (j / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < w - 1 && m[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && m[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w); }
      if (y < h - 1 && m[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w); }
    }
    out.push({ x0, y0, x1, y1, n });
  }
  return out;
}

/** Grayscale copy at 1/s size (s = 1 gives full resolution). */
export function grayDown(img, s) {
  const { data, width: W, height: H } = img;
  const w = Math.floor(W / s), h = Math.floor(H / s), g = new Uint8Array(w * h);
  if (s === 1) { for (let i = 0, j = 0; j < w * h; i += 4, j++) g[j] = lumOf(data, i); return { g, w, h, s }; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let t = 0;
    for (let yy = 0; yy < s; yy++) { let i = ((y * s + yy) * W + x * s) * 4; for (let xx = 0; xx < s; xx++, i += 4) t += lumOf(data, i); }
    g[y * w + x] = t / (s * s);
  }
  return { g, w, h, s };
}

/**
 * Tracker. Boxes that share a column (a feed) scroll together, so for each column we measure
 * how far its page content moved, using the page around the pictures (captions, text, edges)
 * and never the inside of the pictures (videos change every frame). Coarse search on a 1/4-size
 * copy, then an exact pixel fix at full size, so no drift builds up.
 */
export class Tracker {
  constructor(opt = {}) { this.prevC = null; this.prevF = null; this.boxes = []; this.searchY = opt.searchY || 60; this.nextId = 1; }
  add(box) { const b = { ...box, id: this.nextId++, lost: 0 }; this.boxes.push(b); return b; }
  /** coarse = grayDown(frame, 4), fine = grayDown(frame, 1). Returns the shifts applied, per column. */
  update(coarse, fine) {
    const pc = this.prevC, pf = this.prevF; this.prevC = coarse; this.prevF = fine;
    this.pageShift = 0;
    if (!pc || pc.w !== coarse.w || pc.h !== coarse.h) return [];
    // how far the page moved, from a band down the middle of the screen (works even between pictures)
    const band = { x0: fine.w * 0.25, x1: fine.w * 0.75, boxes: [] };
    this.pageShift = measureColumn(pc, coarse, pf, fine, band, this.boxes, this.searchY, this.pageVy || 0) ?? 0;
    this.pageVy = this.pageShift;
    if (!this.boxes.length) return [];
    const shifts = [];
    for (const col of columns(this.boxes)) {
      // sample the page around the pictures once per frame, at both sizes
      const ptsC = samplePoints(pc, col, this.boxes, 4, 1), ptsF = samplePoints(pf, col, this.boxes, 1, 6);
      // coarse: a few best guesses (feeds repeat the same layout, so the single best can be a lookalike)
      const cands = scoreShifts(coarse, ptsC, -this.searchY, this.searchY, 5).filter((c) => c.err < 40).map((c) => c.dy);
      const last = col.boxes.reduce((a, b) => a + (b.vy || 0), 0) / col.boxes.length;
      // exact check at full size around each guess, around "same speed as last frame", and around "not moving"
      const windows = [...cands.map((c) => [c * 4 - 5, c * 4 + 5]), [Math.round(last) - 4, Math.round(last) + 4], [-2, 2]];
      let best = null;
      for (const [lo, hi] of windows) {
        const r = scoreShifts(fine, ptsF, lo, hi, 1)[0];
        if (r && (!best || r.err < best.err)) best = r;
      }
      if (!best || best.err >= 25) { for (const b of col.boxes) b.lost++; continue; }
      for (const b of col.boxes) { b.y += best.dy; b.vy = best.dy; b.lost = 0; }
      shifts.push(best.dy);
    }
    const H = fine.h, W = fine.w;
    this.boxes = this.boxes.filter((b) => b.lost < 3 && b.y + b.h > 0 && b.y < H && b.x + b.w > 0 && b.x < W);
    return shifts;
  }
}

/** The vertical shift of one column between two frames, or null if it can't tell. */
function measureColumn(pc, coarse, pf, fine, col, boxes, searchY, last) {
  const ptsC = samplePoints(pc, col, boxes, 4, 1), ptsF = samplePoints(pf, col, boxes, 1, 6);
  const cands = scoreShifts(coarse, ptsC, -searchY, searchY, 5).filter((c) => c.err < 40).map((c) => c.dy);
  const windows = [...cands.map((c) => [c * 4 - 5, c * 4 + 5]), [Math.round(last) - 4, Math.round(last) + 4], [-2, 2]];
  let best = null;
  for (const [lo, hi] of windows) { const r = scoreShifts(fine, ptsF, lo, hi, 1)[0]; if (r && (!best || r.err < best.err)) best = r; }
  return best && best.err < 25 ? best.dy : null;
}

/** Group boxes whose x-ranges overlap: each group is one scrolling column. */
function columns(boxes) {
  const sorted = [...boxes].sort((a, b) => a.x - b.x), cols = [];
  for (const b of sorted) {
    const c = cols.find((c) => b.x < c.x1 && b.x + b.w > c.x0);
    if (c) { c.x0 = Math.min(c.x0, b.x); c.x1 = Math.max(c.x1, b.x + b.w); c.boxes.push(b); }
    else cols.push({ x0: b.x, x1: b.x + b.w, boxes: [b] });
  }
  return cols;
}

/** Points of page content around (never inside) the pictures in a column, from the previous frame. */
function samplePoints(prev, col, allBoxes, s, step) {
  const W = prev.w, H = prev.h;
  const x0 = Math.max(0, Math.floor((col.x0 - 24) / s)), x1 = Math.min(W, Math.ceil((col.x1 + 24) / s));
  const holes = allBoxes.map((b) => [(b.x + 2) / s, (b.y + 2) / s, (b.x + b.w - 2) / s, (b.y + b.h - 2) / s]);
  const pts = [];
  for (let y = 0; y < H; y += step) {
    const rowHoles = holes.filter((h) => y >= h[1] && y < h[3]);
    for (let x = x0; x < x1; x += step) {
      let inside = false; for (const h of rowHoles) if (x >= h[0] && x < h[2]) { inside = true; break; }
      if (inside) continue;
      const v = prev.g[y * W + x];
      // only points with some local detail; flat background says nothing about motion
      const vx = x + 1 < W ? prev.g[y * W + x + 1] : v, vy = y + 1 < H ? prev.g[(y + 1) * W + x] : v;
      if (Math.abs(v - vx) + Math.abs(v - vy) < 12) continue;
      pts.push(x, y, v);
    }
  }
  const MAXP = 2500;   // keep it fast: at most ~2,500 points, spread evenly
  if (pts.length / 3 <= MAXP) return pts;
  const every = (pts.length / 3) / MAXP, thin = [];
  for (let j = 0; j < MAXP; j++) { const k = Math.floor(j * every) * 3; thin.push(pts[k], pts[k + 1], pts[k + 2]); }
  return thin;
}

/** Score vertical shifts lo..hi with a capped error, so outlier points (sticky headers, changes) can't dominate.
 *  Returns the best k distinct shifts as {dy, err}. */
function scoreShifts(cur, pts, lo, hi, k) {
  const W = cur.w, H = cur.h;
  if (pts.length < 90) return [];
  const scored = [];
  for (let dy = Math.round(lo); dy <= Math.round(hi); dy++) {
    let n = 0, t = 0;
    for (let q = 0; q < pts.length; q += 3) {
      const y = pts[q + 1] + dy;
      if (y < 0 || y >= H) continue;
      const e = Math.abs(cur.g[y * W + pts[q]] - pts[q + 2]);
      t += e < 30 ? e : 30; n++;   // capped: a sticky header or a changed patch can't dominate
    }
    if (n < pts.length / 3 * 0.5) continue;
    scored.push({ dy, err: t / n });
  }
  scored.sort((a, b) => a.err - b.err);
  const picked = [];
  for (const c of scored) { if (picked.length >= k) break; if (picked.every((p) => Math.abs(p.dy - c.dy) >= 3)) picked.push(c); }
  return picked;
}

/**
 * Panels inside one picture (collages: a grid of mugshots made into one image). Collages are almost always a regular
 * grid, so this only accepts dividing lines at even spacing (halves, thirds, quarters, fifths) running all the way
 * across: a thin divider strip (flat, with picture on both sides) or a sharp straight edge (panels butted together).
 * Returns the grid cells as absolute rects, or [] for a single picture.
 */
export function findPanels(img, b, opt = {}) {
  const { data, width: W } = img;
  const L = (x, y) => { const q = (y * W + x) * 4; return (data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 8; };
  const B = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
  // per line across rect r: how flat it is, how often it's a sharp jump, and how much it differs from the next line
  function profile(r, vertical) {
    const span = vertical ? r.w : r.h, len = vertical ? r.h : r.w, st = Math.max(1, Math.floor(len / 150));
    const flat = new Float32Array(span).fill(99), edge = new Float32Array(span), diff = new Float32Array(span);
    for (let i = 1; i < span - 1; i++) {
      let s1 = 0, s2 = 0, n = 0, j = 0, ds = 0;
      for (let t = 0; t < len; t += st) {
        const x = vertical ? r.x + i : r.x + t, y = vertical ? r.y + t : r.y + i, v = L(x, y);
        s1 += v; s2 += v * v; n++;
        const a = vertical ? L(x - 1, y) : L(x, y - 1), c = vertical ? L(x + 1, y) : L(x, y + 1);
        if (Math.abs(c - a) > 30) j++;
        ds += Math.abs(c - v);
      }
      const m = s1 / n; flat[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); edge[i] = j / n; diff[i] = ds / n;
    }
    return { flat, edge, diff, span };
  }
  // a dividing line at i: a thin flat strip with picture on both sides, or (picture on both sides) a sharp edge
  function isLine(pr, i, strict) {
    if (pr.flat[i] < 6) {
      let a = i, z = i; while (a > 1 && pr.flat[a - 1] < 6) a--; while (z < pr.span - 2 && pr.flat[z + 1] < 6) z++;
      if (z - a <= 14 && a > 2 && z < pr.span - 3 && pr.flat[a - 2] > 14 && pr.flat[z + 2] > 14) return true;
    }
    const busy = i > 7 && i < pr.span - 8 && pr.flat[i - 6] > 12 && pr.flat[i + 6] > 12;
    if (!busy) return false;
    if (pr.edge[i] >= (strict ? 0.75 : 0.6)) return true;
    const around = []; for (let k = Math.max(1, i - 12); k <= Math.min(pr.span - 2, i + 12); k++) if (Math.abs(k - i) > 1) around.push(pr.diff[k]);
    around.sort((p, q) => p - q);
    const typical = around[Math.floor(around.length / 2)] || 0;
    return pr.diff[i] >= (strict ? 10 : 8) && pr.diff[i] >= (strict ? 5 : 4) * Math.max(1, typical);
  }
  // evenly spaced lines (halves to fifths) all the way across: the test for "is this a collage at all"
  function evenCount(pr) {
    for (const n of [5, 4, 3, 2]) {
      if (pr.span / n < (opt.minPart || 48)) continue;
      const tol = Math.max(4, Math.round(pr.span * 0.025));
      let ok = true;
      for (let k = 1; k < n && ok; k++) { const p = Math.round((k * pr.span) / n); ok = false; for (let i = Math.max(2, p - tol); i <= Math.min(pr.span - 3, p + tol) && !ok; i++) ok = isLine(pr, i, false); }
      if (ok) return n;
    }
    return 1;
  }
  // inside a known collage row or column: clear lines anywhere (panels can be uneven widths)
  function freeCuts(pr, minPart) {
    const cuts = []; let last = 0;
    for (let i = minPart; i < pr.span - minPart; i++) if (i - last >= minPart && isLine(pr, i, true)) { cuts.push(i); last = i; i += 8; }
    return cuts;
  }
  const pad = 3, cells = [];
  const rows = evenCount(profile(B, false)), cols = evenCount(profile(B, true));
  if (rows < 2 && cols < 2) return [];
  // a regular grid only if every row splits at the same columns (a top row of 3 over rows of 4 is not one)
  const regular = rows >= 2 && cols >= 2 && Array.from({ length: rows }, (_, r) => ({ x: B.x, y: B.y + Math.round((r * B.h) / rows), w: B.w, h: Math.round(((r + 1) * B.h) / rows) - Math.round((r * B.h) / rows) }))
    .every((band) => evenCount(profile(band, true)) === cols);
  if (regular) { // the exact cells
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = B.x + Math.round((c * B.w) / cols) + pad, x1 = B.x + Math.round(((c + 1) * B.w) / cols) - pad;
      const y0 = B.y + Math.round((r * B.h) / rows) + pad, y1 = B.y + Math.round(((r + 1) * B.h) / rows) - pad;
      cells.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  } else { // rows (or columns) only, panels of uneven size: overlapping squares along each row (or column)
    const alongRows = rows >= 2, n = alongRows ? rows : cols;
    for (let k = 0; k < n; k++) {
      const a0 = Math.round((k * (alongRows ? B.h : B.w)) / n), a1 = Math.round(((k + 1) * (alongRows ? B.h : B.w)) / n);
      const side = a1 - a0 - 2 * pad, len = alongRows ? B.w : B.h, step = Math.max(16, Math.round(side / 2));
      for (let t = 0; t + side <= len + step / 2; t += step) {
        const u = Math.min(t, len - side);
        cells.push(alongRows ? { x: B.x + u, y: B.y + a0 + pad, w: side, h: side } : { x: B.x + a0 + pad, y: B.y + u, w: side, h: side });
        if (u !== t) break;
      }
    }
  }
  return cells.length >= 2 ? cells.filter((c) => c.w >= 32 && c.h >= 32) : [];
}
