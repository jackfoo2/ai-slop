// AI Slop Overlay — the see-through page over the screen.
// Each frame: capture the screen, keep boxes glued to pictures as things scroll, and draw a light
// blur over the ones the model thinks are AI. A few times a second: look for new pictures.
import { findRegions, grayDown, Tracker } from './core.js';
import { startOcr, readText, matchAiText } from './ocr.js';
import { readPhrases, cleanAction, describe } from './feedback.js';

const THRESH = { sensitive: 0.5, balanced: 0.65, strict: 0.8 };
const BLUR = { light: [3, 9], medium: [6, 16], strong: [10, 24] }; // CSS px at the line -> at 100%
// CPU budget: the main process measures CPU use and moves between these levels to stay under the limit
const LEVELS = [
  { fps: 30, detect: 150, ocr: 'on', views: 2 },
  { fps: 20, detect: 250, ocr: 'on', views: 2 },
  { fps: 15, detect: 400, ocr: 'idle', views: 2 },
  { fps: 10, detect: 700, ocr: 'idle', views: 1 },
  { fps: 6, detect: 1200, ocr: 'off', views: 1 },
];
let level = 0;
const L = () => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))];
const DETECT_EVERY = 150, MAX_PROC_W = 1280, RESCORE_FLAGGED = 8000, RESCORE_CLEAN = 2500, LEAD_FRAMES = 1;

const slop = window.slop;
const view = document.getElementById('view'), vctx = view.getContext('2d');
const chipsEl = document.getElementById('chips');
const video = document.createElement('video'); video.muted = true;
const frame = document.createElement('canvas'), fctx = frame.getContext('2d', { willReadFrequently: true });
let settings = { paused: false, strength: 'light', sensitivity: 'balanced', video: true, showScores: false, readText: true, ignoreWallpaper: true };
let frameAt = 0, prevFrameAt = 0; // when the latest captured frame was taken (performance.now clock)
let engine = null, tracker = new Tracker({ searchY: 60 }), k = 1; // k = processed pixels per CSS pixel
let f = 1; // processed pixels per captured pixel (big screens are processed at a lighter size)
let lastDetect = 0, frames = 0, fpsT = performance.now(), scoring = 0;
const cache = new Map(); // picture signature -> { p, revealed }
// pictures you've scrolled past, remembered by where they sit on the page, so scrolling back re-blurs at once
let scrollAcc = 0; // total distance the page has moved (screen y minus this = position on the page)
const departed = [], lastSeen = new Map();
function rememberDeparted(now) {
  const alive = new Set(tracker.boxes.map((b) => b.id));
  for (const [id, d] of lastSeen) if (!alive.has(id)) { if (d.p != null) { departed.push({ ...d, at: now }); if (departed.length > 300) departed.shift(); } lastSeen.delete(id); }
  for (const b of tracker.boxes) if (b.p != null) lastSeen.set(b.id, { x: b.x, w: b.w, top: b.y - scrollAcc, h: b.h, p: b.p, revealed: !!b.revealed, history: b.history.slice(), textHit: b.textHit, ocrDone: b.ocrDone, user: b.user });
}
function recall(r) {
  const top = r.y - scrollAcc, bot = top + r.h;
  let best = null, bestOv = 0;
  for (let i = departed.length - 1; i >= 0; i--) {
    const d = departed[i];
    if (Math.abs(d.x - r.x) > 12 || Math.abs(d.w - r.w) > 24) continue;
    const ov = Math.min(bot, d.top + d.h) - Math.max(top, d.top);
    if (ov > 0.5 * Math.min(r.h, d.h) && ov > bestOv) { best = d; bestOv = ov; }
  }
  return best;
}
const chips = new Map(); // box id -> chip element
const thr = () => THRESH[settings.sensitivity] ?? 0.65;
// blur in screen (CSS) pixels: the slider's amount, nudged only slightly by confidence (an indicator, not a wall)
const blurPx = (p) => { const t = thr(), q = Math.min(1, Math.max(0, (p - t) / (1 - t))); return (settings.blurPx || 2) * (0.85 + 0.3 * q); };
let capPerCss = 1; // capture pixels per screen (CSS) pixel

async function start() {
  try {
    settings = await slop.settings();
    level = (await slop.budget()) || 0; slop.onBudget((lv) => { level = lv; });
    slop.onSettings((s) => { settings = s; if (s.paused) clearAll(); });
    const disp = await slop.display();
    slop.status({ model: 'loading' });
    engine = await startEngine(await slop.model(), await slop.wasm());
    slop.status({ model: 'ready', engine: engine.name });
    startOcr((m) => slop.log(m)).catch(() => {});
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    video.srcObject = stream; await video.play();
    f = Math.min(1, MAX_PROC_W / video.videoWidth);
    k = (video.videoWidth * f) / disp.width || 1;
    capPerCss = video.videoWidth / disp.width || 1;
    slop.log('capturing', { video: [video.videoWidth, video.videoHeight], display: disp, k, engine: engine.name });
    loadWallpaper(); setInterval(loadWallpaper, 120000); // after capture starts (needs the screen size); picks up a changed wallpaper
    video.requestVideoFrameCallback(onFrame);
    requestAnimationFrame(renderLoop);
  } catch (e) {
    slop.log('start failed', String(e?.stack || e));
    slop.status({ model: 'error', error: String(e?.message || e) });
  }
}

const perf = { n: 0, ms: 0, parts: {} };
/** The model lives in a worker thread; this is the overlay's handle to it. */
function startEngine(model, wasm) {
  return new Promise((resolve, reject) => {
    const w = new Worker('engine-worker.js'), pending = new Map(); let nid = 0;
    w.onerror = (e) => reject(new Error(e.message || 'engine worker failed to start'));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'log') slop.log(m.text);
      else if (m.type === 'error') reject(new Error(m.error));
      else if (m.type === 'ready') resolve({ name: m.name, score: (bitmap, views = 2) => new Promise((ok, bad) => { const id = ++nid; pending.set(id, [ok, bad]); w.postMessage({ type: 'score', id, bitmap, views }, [bitmap]); }) });
      else if (m.type === 'score') { const [ok, bad] = pending.get(m.id) || []; pending.delete(m.id); if (m.error) bad?.(new Error(m.error)); else ok?.(m.p); }
    };
    w.postMessage({ type: 'init', model, wasm }, [model, wasm]);
  });
}

function onFrame(now, meta) {
  const t0 = performance.now();
  prevFrameAt = frameAt; frameAt = (meta && (meta.captureTime || meta.presentationTime)) || now || t0;
  try { step(); } catch (e) { slop.log('frame error', String(e?.stack || e)); }
  perf.n++; perf.ms += performance.now() - t0;
  video.requestVideoFrameCallback(onFrame);
}

function step() {
  if (!video.videoWidth || !video.videoHeight) return;
  const W = Math.round(video.videoWidth * f), H = Math.round(video.videoHeight * f);
  if (frame.width !== W || frame.height !== H) { frame.width = W; frame.height = H; view.width = video.videoWidth; view.height = video.videoHeight; tracker = new Tracker({ searchY: 60 }); } // blur is drawn at full capture resolution
  if (settings.paused) { clearAll(); return; }
  const t0f = performance.now();
  if (t0f - lastProc < 1000 / L().fps - 2) { skipped++; return; } // frame-rate cap for this CPU level
  lastProc = t0f;
  const changed = screenChanged();
  if (changed) stillSince = t0f;
  const moving = tracker.boxes.some((b) => Math.abs(b.vpm || 0) > 0.01);
  if (!changed && !moving && t0f - lastFull < 2000) { idle++; for (const b of tracker.boxes) b.vpm = 0; return; } // still screen: nothing to do
  lastFull = t0f; processed++;
  let t = performance.now(); const mark = (k) => { const n = performance.now(); perf.parts[k] = (perf.parts[k] || 0) + n - t; t = n; };
  fctx.drawImage(video, 0, 0, W, H); mark('draw');
  const img = fctx.getImageData(0, 0, W, H); mark('read');
  const gc = coarseGray(W, H), gf = grayDown(img, 1); mark('gray');
  tracker.update(gc, gf); scrollAcc += tracker.pageShift || 0; mark('track');
  const now = performance.now();
  checkCovered(img); // first: which pictures has something been put on top of?
  if (now - lastDetect > L().detect) { lastDetect = now; detect(img); mark('detect'); }
  rememberDeparted(now);
  // how fast each box is moving, per millisecond, so drawing can project it forward between captures
  const dt = Math.max(8, Math.min(200, frameAt - prevFrameAt || 33));
  for (const b of tracker.boxes) b.vpm = (b.vy || 0) / dt;
  frames++;
  if (now - (window.__perfLogT || 0) > 10000) { window.__perfLogT = now; const p = window.__slopPerf(); slop.log('perf', { ...p, fps: lastFps, boxes: tracker.boxes.length, engine: engine?.name, procSize: [frame.width, frame.height] }); }
  if (now - fpsT > 2000) {
    const flagged = tracker.boxes.filter(isBlurred).length;
    lastFps = Math.round((frames * 1000) / (now - fpsT));
    slop.status({ fps: lastFps, flagged, tracked: tracker.boxes.length });
    frames = 0; fpsT = now;
  }
}

const iou = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i); };

function detect(img) {
  const ms = settings.minScale || 1;
  const found = findRegions(img, { block: Math.max(8, Math.round(8 * k)), minW: 120 * k * ms, minH: 90 * k * ms, wall: settings.ignoreWallpaper && wall && wall.width === img.width && wall.height === img.height ? wall.data : null });
  const seen = new Set();
  for (const r of found) {
    if (onWallpaper(img, r)) { const old = tracker.boxes.find((b) => iou(b, r) > 0.3); if (old) old.miss = 9; continue; } // it's the desktop
    const inter = (b) => Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x)) * Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
    const hit = tracker.boxes.find((b) => iou(b, r) > 0.3);
    if (hit) {
      const ratio = (r.w * r.h) / (hit.w * hit.h);
      if (ratio > 0.7 && ratio < 1.4) snapTo(hit, r);
      // the picture grew back (a window over part of it closed): take the bigger outline if the extra is more picture,
      // not a flat hover highlight or a file name
      else if (ratio >= 1.4 && inter(hit) > 0.9 * hit.w * hit.h && morePicture(img, r, hit)) { hit.x = r.x; hit.y = r.y; hit.w = r.w; hit.h = r.h; hit.cells = null; hit.covered = false; hit.thumb = thumbOf(img, hit); hit.history = []; hit.nextScore = performance.now(); } // re-score the whole picture now
      const same = !hit.thumb || sameContent(img, hit), match = iou(hit, r);
      const still = Math.abs(hit.vpm || 0) < 0.02;
      if (!same && still && match < 0.9) { hit.miss = 9; } // its outline really changed (covered, or now only partly showing): replace it with what's there now
      else {
      // same outline, different pixels: a video (or the picture was swapped); re-check it soon from fresh scores
      if (!same && still && !hit.dynamic) { hit.dynamic = true; hit.covered = false; hit.cells = null; hit.history = []; hit.nextScore = performance.now(); } // only judged while still: scrolling shifts pixels too
      hit.miss = 0; if (!hit.cells && !hit.covered) hit.thumb = thumbOf(img, hit); seen.add(hit.id);
      if (!hit.user && ratedList.length && (hit.fpChecks = (hit.fpChecks || 0) + 1) <= 20 && !hit.cells && !hit.covered) { hit.fp = fingerprint(img, hit); const v = ratedVerdict(hit.fp); if (v) hit.user = v; }
      continue;
      }
    }
    // a much bigger shape around a known picture (e.g. a hover highlight) only counts as that picture if the
    // picture itself is unchanged; a window opened on top (Task Manager...) is not the picture
    tracker.boxes = tracker.boxes.filter((b) => (b.miss || 0) < 9);
    const around = tracker.boxes.find((b) => inter(b) > 0.8 * b.w * b.h);
    if (around) { if (around.thumb && sameContent(img, around)) { around.miss = 0; seen.add(around.id); } continue; }
    const b = tracker.add({ ...r, p: null, history: [], sig: signature(img, r) });
    b.thumb = thumbOf(img, b);
    b.fp = fingerprint(img, b);
    const mine = ratedVerdict(b.fp); if (mine) b.user = mine;
    const known = cache.get(b.sig);
    seen.add(b.id);
    const back = known ? null : recall(r);
    if (known) { b.p = known.p; b.revealed = known.revealed; b.textHit = known.textHit; b.ocrDone = known.ocrDone; b.nextScore = performance.now() + RESCORE_CLEAN; }
    else if (back) { b.p = back.p; b.revealed = back.revealed; b.history = back.history.slice(); b.textHit = back.textHit; b.ocrDone = back.ocrDone; b.user = b.user || back.user; b.nextScore = performance.now() + 1000; } // scrolled back: blur at once, re-check soon
    else queueScore(b);
  }
  // a picture that two re-scans in a row can't find is gone: drop it (and its blur) right away
  for (const b of tracker.boxes) {
    if (seen.has(b.id)) continue;
    if (b.thumb && sameContent(img, b)) { b.miss = 0; continue; } // still there, just not recognized this time (hover, selection...)
    b.miss = (b.miss || 0) + 1;
  }
  tracker.boxes = tracker.boxes.filter((b) => (b.miss || 0) < 2);
  // pictures that have gone away take their chips with them
  for (const [id, el] of chips) if (!tracker.boxes.some((b) => b.id === id)) { el.remove(); chips.delete(id); }
}

/** Is the part of r outside box b genuinely picture (many colors), rather than flat fill or text? */
function morePicture(img, r, b) {
  const { data, width: W } = img, count = new Map(); let n = 0, top = 0;
  const st = Math.max(2, Math.floor(Math.sqrt((r.w * r.h) / 4000)));
  for (let y = r.y; y < r.y + r.h; y += st) for (let x = r.x; x < r.x + r.w; x += st) {
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) continue;
    const q = (Math.floor(y) * W + Math.floor(x)) * 4; n++;
    const c = ((data[q] >> 4) << 8) | ((data[q + 1] >> 4) << 4) | (data[q + 2] >> 4), v = (count.get(c) || 0) + 1;
    count.set(c, v); if (v > top) top = v;
  }
  // many colors AND no single flat color dominating (a highlight is mostly one color, even with a file name on it)
  return n > 20 && count.size >= 24 && top / n < 0.35;
}

/** For still pictures: which parts now show something else (a window on top), checked as a 16x16 grid. */
function checkCovered(img) {
  for (const b of tracker.boxes) {
    if (Math.abs(b.vpm || 0) > 0.02) { b.cells = null; b.covered = false; continue; } // moving: no partial covering logic
    if (b.dynamic || !b.thumb || b.y < 0 || b.y + b.h > img.height) continue;
    const c = cellsOf(img, b);
    b.covered = c.frac < 0.25;                      // mostly covered: no blur at all
    b.cells = c.frac < 1 ? c.m : null;              // partly covered: blur only the parts still showing the picture
  }
}

/** Correct a tracked box from a fresh detection without making it jump around. */
function snapTo(b, r) {
  if (Math.abs(r.x - b.x) > 2 || Math.abs(r.w - b.w) > 2) { b.x = r.x; b.w = r.w; }
  const dTop = r.y - b.y, dBot = (r.y + r.h) - (b.y + b.h);
  if (Math.abs(dBot) <= 6 && dTop > 8) { b.clipTop = r.y; b.clipBot = null; if (Math.abs(dBot) > 2) b.y += dBot; }            // covered at the top
  else if (Math.abs(dTop) <= 6 && dBot < -8) { b.clipBot = r.y + r.h; b.clipTop = null; if (Math.abs(dTop) > 2) b.y += dTop; } // covered at the bottom
  else { b.clipTop = b.clipBot = null; if (Math.abs(dTop) > 2 || Math.abs(dBot) > 2) { b.y = r.y; b.h = r.h; } }
}

// ---- the desktop wallpaper: drawn the way Windows lays it out, so it can be recognized wherever it shows
let wall = null, wallStamp = '';
async function loadWallpaper() {
  try {
    const w = await slop.wallpaper();
    if (!w) { wall = null; wallStamp = ''; return; }
    if (w.stamp === wallStamp && wall) return;
    const bmp = await createImageBitmap(new Blob([w.bytes]));
    const W = Math.round(video.videoWidth * f), H = Math.round(video.videoHeight * f);
    if (!W || !H) return;
    const c = new OffscreenCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high';
    const iw = bmp.width * f, ih = bmp.height * f; // image pixels map 1:1 to screen pixels before fitting
    if (w.style === '2') g.drawImage(bmp, 0, 0, W, H);                                                      // stretch
    else if (w.style === '10' || w.style === '22') { const s = Math.max(W / bmp.width, H / bmp.height); g.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s); } // fill / span
    else if (w.style === '6') { const s = Math.min(W / bmp.width, H / bmp.height); g.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s); }  // fit
    else if (w.tile === '1') { for (let y = 0; y < H; y += ih) for (let x = 0; x < W; x += iw) g.drawImage(bmp, x, y, iw, ih); }        // tile
    else g.drawImage(bmp, (W - iw) / 2, (H - ih) / 2, iw, ih);                                               // center
    bmp.close();
    wall = g.getImageData(0, 0, W, H); wallStamp = w.stamp;
    slop.log('wallpaper loaded', { style: w.style, tile: w.tile, size: [W, H] });
  } catch (e) { slop.log('wallpaper load failed', String(e?.message || e)); }
}
/** True when most of this region matches the wallpaper at the same spot on screen (desktop icons and
 *  small differences allowed). Pictures that just look like the wallpaper elsewhere won't line up. */
function onWallpaper(img, r) {
  if (!settings.ignoreWallpaper || !wall || wall.width !== img.width || wall.height !== img.height) return false;
  const a = img.data, w = wall.data, W = img.width; let match = 0, n = 0;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
    const x = Math.floor(r.x + ((i + 0.5) * r.w) / 12), y = Math.floor(r.y + ((j + 0.5) * r.h) / 12), q = (y * W + x) * 4;
    n++; if (Math.abs(a[q] - w[q]) + Math.abs(a[q + 1] - w[q + 1]) + Math.abs(a[q + 2] - w[q + 2]) < 45) match++;
  }
  return match / n >= 0.65;
}

/** An 8x8 gray thumbnail of what's inside a box right now, to tell "same picture" from "something else". */
const G = 32; // a picture is checked as a 32x32 grid of cells
function thumbOf(img, b) { // color samples: R, G, B per cell
  const { data, width: W, height: H } = img, t = new Uint8Array(G * G * 3);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(b.x + ((i + 0.5) * b.w) / G))), y = Math.min(H - 1, Math.max(0, Math.floor(b.y + ((j + 0.5) * b.h) / G))), q = (y * W + x) * 4, o = (j * G + i) * 3;
    t[o] = data[q]; t[o + 1] = data[q + 1]; t[o + 2] = data[q + 2];
  }
  return t;
}
const cellDiff = (a, b, c) => Math.abs(a[c * 3] - b[c * 3]) + Math.abs(a[c * 3 + 1] - b[c * 3 + 1]) + Math.abs(a[c * 3 + 2] - b[c * 3 + 2]);
function sameContent(img, b) {
  if (b.y < 0 || b.y + b.h > img.height) return false; // partly off screen: let the normal rules decide
  const now = thumbOf(img, b); let d = 0;
  for (let i = 0; i < G * G; i++) d += cellDiff(now, b.thumb, i);
  return d / (G * G) < 36;
}
/** Which cells of a picture still show the picture (1) and which are covered by something else (0). */
function cellsOf(img, b) {
  const now = thumbOf(img, b), m = new Uint8Array(G * G); let n = 0;
  for (let i = 0; i < G * G; i++) { m[i] = cellDiff(now, b.thumb, i) < 45 ? 1 : 0; n += m[i]; }
  return { m, frac: n / (G * G) };
}

/** A tiny fingerprint of a picture's content, so scrolling away and back doesn't rescore it. */
function signature(img, r) {
  const { data, width: W } = img; let s = '';
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
    const x = Math.floor(r.x + ((i + 0.5) * r.w) / 6), y = Math.floor(r.y + ((j + 0.5) * r.h) / 6), q = (y * W + x) * 4;
    s += ((data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 13).toString(16);
  }
  return `${Math.round(r.w / 16)}x${Math.round(r.h / 16)}:${s}`;
}
/** For ratings: averaged brightness on a 6x6 grid plus the picture's shape, compared with a tolerance
 *  (survives a pixel of drift and resizing, but different pictures don't match). */
function fingerprint(img, r) {
  const { data, width: W, height: H } = img, v = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
    const cx = Math.floor(r.x + ((i + 0.5) * r.w) / 6), cy = Math.floor(r.y + ((j + 0.5) * r.h) / 6); let t = 0, c = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(H - 1, Math.max(0, cy + dy)), q = (y * W + x) * 4;
      t += (data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 8; c += data[q] - data[q + 2]; n++;
    }
    v.push(Math.round(t / n), Math.round(c / n / 2 + 128)); // brightness and a red-blue color value per cell
  }
  return { a: +(r.w / r.h).toFixed(3), v };
}
function ratedVerdict(fp) {
  let best = null, bestD = Infinity; // each rating has a match distance: 2.5 for 'this picture', wider for 'pictures like this'
  for (const e of ratedList) {
    if (Math.abs(e.a - fp.a) > (e.tol ? 0.25 : 0.06) || !e.v || e.v.length !== fp.v.length) continue;
    let d = 0; for (let i = 0; i < fp.v.length; i++) d += Math.abs(e.v[i] - fp.v[i]); d /= fp.v.length;
    if (d < (e.tol || 2.5) && d < bestD) { bestD = d; best = e; }
  }
  return best ? best.verdict : null;
}

let ocrBusy = false, ocrMs = 0, ocrN = 0;
let lastProc = 0, lastFull = 0, stillSince = performance.now(), processed = 0, idle = 0, skipped = 0;
// a 64x36 copy, scaled on the graphics card: has anything on screen changed since last frame?
const tiny = document.createElement('canvas'); tiny.width = 64; tiny.height = 36;
const tctx = tiny.getContext('2d', { willReadFrequently: true }); let prevTiny = null;
function screenChanged() {
  tctx.drawImage(video, 0, 0, 64, 36);
  const d = tctx.getImageData(0, 0, 64, 36).data; let diff = 0;
  if (prevTiny) for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i] - prevTiny[i]) + Math.abs(d[i + 1] - prevTiny[i + 1]) + Math.abs(d[i + 2] - prevTiny[i + 2]);
  const changed = !prevTiny || diff / (64 * 36) > 1.5; // tiny changes (the mouse pointer) don't count
  prevTiny = d;
  return changed;
}
// the quarter-size gray copy for coarse tracking, scaled on the graphics card instead of in JavaScript
const coarse = document.createElement('canvas'), cgctx = coarse.getContext('2d', { willReadFrequently: true });
function coarseGray(W, H) {
  const w = Math.floor(W / 4), h = Math.floor(H / 4);
  if (coarse.width !== w || coarse.height !== h) { coarse.width = w; coarse.height = h; }
  cgctx.drawImage(frame, 0, 0, w, h); // from the same frame as the full-detail copy, never a newer one
  const d = cgctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return { g, w, h, s: 4 };
}
// scoring and text reading: their own steady timer, independent of how often frames are processed
setInterval(() => {
  if (!engine || settings.paused) return;
  const now = performance.now();
  // never score a picture while something covers it (all or part): that would score the window on top
  const ready = (b) => !b.covered && !b.cells;
  const fresh = tracker.boxes.filter((b) => ready(b) && b.p == null && !b.scoring);
  if (fresh.length) for (const b of fresh) queueScore(b);                                // first looks before second looks
  else for (const b of tracker.boxes) if (ready(b) && b.p != null && b.nextScore && now > b.nextScore) queueScore(b);
  const mode = L().ocr;
  if (!settings.readText || ocrBusy || mode === 'off' || (mode === 'idle' && now - stillSince < 2000)) return;
  const b = tracker.boxes.find((x) => !x.ocrDone && Math.abs(x.vpm || 0) < 0.02 && x.y >= 0 && x.y + x.h <= frame.height);
  if (b) queueOcr(b);
}, 200);
/** Read the text inside a picture (top and bottom strips: watermarks) and around it (name row, caption,
 *  strip below: site labels and hashtags), from the full-quality capture, then decide. */
async function queueOcr(b) {
  ocrBusy = true;
  try {
    const VW = video.videoWidth, VH = video.videoHeight, X = (v) => Math.round(v / f);
    const sx = X(b.x), sy = X(b.y), sw = X(b.w), sh = X(b.h);
    // the area around a picture belongs to its own post: stop at any neighboring picture above or below
    let ceil = sy - Math.min(170, Math.max(70, sh * 0.45)), floor = sy + sh + 60;
    for (const o of tracker.boxes) {
      if (o === b || X(o.x) > sx + sw || X(o.x + o.w) < sx - 90) continue;
      const ob = X(o.y + o.h), ot = X(o.y);
      if (ob <= sy && ob > ceil) ceil = ob + 4;
      if (ot >= sy + sh && ot < floor) floor = ot - 4;
    }
    const parts = [
      ['in', sx, sy + sh - Math.max(34, sh * 0.16), sw, Math.max(34, sh * 0.16)],
      ['in', sx, sy, sw, Math.max(30, sh * 0.14)],
      ['around', sx - 90, ceil, sw + 90, sy - ceil],
      ['around', sx, sy + sh, sw, floor - (sy + sh)],
    ];
    let inside = '', around = '';
    for (const [kind, x0, y0, w0, h0] of parts) {
      const x = Math.max(0, Math.round(x0)), y = Math.max(0, Math.round(y0));
      const w = Math.min(VW - x, Math.round(w0 - (x - x0))), h = Math.min(VH - y, Math.round(h0 - (y - y0)));
      if (w < 24 || h < 12) continue;
      const tr0 = performance.now();
      const s = h < 60 ? 1.8 : 1.4, c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
      const t = await readText(c);
      if (kind === 'in') inside += ' ' + t; else around += ' ' + t;
      ocrMs += performance.now() - tr0; ocrN++;
    }
    b.textHit = matchAiText(inside, around);
    b.ocrDone = true;
    cache.set(b.sig, { ...(cache.get(b.sig) || {}), textHit: b.textHit, ocrDone: true });
    if (b.textHit) slop.log('text hit', b.textHit);
  } catch (e) {
    b.ocrDone = true;
    slop.log('text reading error', String(e?.message || e));
  } finally { ocrBusy = false; }
}

function queueScore(b) {
  if (b.scoring || scoring >= 4) return;
  if (!settings.video && b.history.length) return;
  b.scoring = true; scoring++;
  const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
  const w = Math.min(frame.width - x, Math.round(b.w)), h = Math.min(frame.height - y, Math.round(b.h));
  if (w < 32 || h < 32) { b.scoring = false; scoring--; return; }
  createImageBitmap(video, Math.round(x / f), Math.round(y / f), Math.round(w / f), Math.round(h / f))
    .then((bmp) => engine.score(bmp, L().views))
    .then((p) => {
      b.history.push(p); if (b.history.length > 3) b.history.shift();
      b.p = b.history.reduce((a, c) => a + c, 0) / b.history.length;
      // videos keep getting re-checked; a still picture is settled after two agreeing looks (saves CPU and graphics card)
      b.nextScore = b.dynamic ? performance.now() + (b.p >= thr() ? RESCORE_FLAGGED : RESCORE_CLEAN) : b.history.length >= 2 ? Infinity : performance.now() + 1500;
      cache.set(b.sig, { ...(cache.get(b.sig) || {}), p: b.p, revealed: !!b.revealed });
    })
    .catch((e) => slop.log('score error', String(e?.message || e)))
    .finally(() => { b.scoring = false; scoring--; });
}

const textP = (b) => (b.textHit ? (b.textHit.kind === 'watermark' ? 0.97 : 0.9) : 0);
const effP = (b) => Math.max(b.p ?? 0, textP(b));
const isBlurred = (b) => {
  if (b.user === 'real') return false;                  // you said it's real
  const showing = !b.revealed && !b.covered && (b.lost || 0) < 2;
  if (b.user === 'ai') return showing;                  // you said it's AI
  return (b.p != null || b.textHit) && effP(b) >= thr() && showing;
};

// ---- drawing: its own loop at the screen's refresh rate, projecting each box forward by how fast it
// moves and how old the latest capture is, so the blur keeps up with scrolling between captures
const xs = new Map(); // box id -> its ✕ button
function uiEl(map, id, make, kind = '') { let el = map.get(id); if (el && el.dataset.kind !== kind) { el.remove(); el = null; } if (!el) { el = make(); el.dataset.kind = kind; chipsEl.appendChild(el); map.set(id, el); } return el; }
function clickableEl(el) { el.addEventListener('mouseenter', () => slop.clickable(true)); el.addEventListener('mouseleave', () => slop.clickable(false)); return el; }
function reveal(b) { b.revealed = true; const c = cache.get(b.sig); if (c) c.revealed = true; slop.clickable(false); }

// ---- ratings: + (it got it right) and − (it got it wrong) on every tag
let ratedList = []; // { a: shape, v: 36 brightness values, verdict } from your ratings (kept across restarts)
slop.rated().then((list) => { ratedList = list || []; }).catch(() => {});
function setChipText(chip, t) { const l = chip.querySelector('.lbl'); if (chip.dataset.flash && performance.now() < +chip.dataset.flash) return; if (l.textContent !== t) l.textContent = t; }
function makeChip(b, blurChip) {
  const el = document.createElement('div'); el.className = 'chip';
  const lbl = document.createElement('span'); lbl.className = 'lbl'; el.appendChild(lbl);
  if (blurChip) { clickableEl(lbl); lbl.addEventListener('click', () => reveal(b)); }
  for (const [sym, right, tip] of [['+', true, 'It got this right'], ['−', false, 'It got this wrong']]) {
    const btn = clickableEl(document.createElement('button'));
    btn.className = `rate ${right ? 'up' : 'down'}`; btn.textContent = sym; btn.title = tip;
    btn.addEventListener('click', (e) => { e.stopPropagation(); rate(b, right, el); });
    el.appendChild(btn);
  }
  const more = clickableEl(document.createElement('button'));
  more.className = 'rate more'; more.textContent = '…'; more.title = 'Tell it something';
  more.addEventListener('click', (e) => { e.stopPropagation(); openFeedback(b, el); });
  el.appendChild(more);
  return el;
}
function rate(b, right, chip) {
  try { b.fp = fingerprint(fctx.getImageData(0, 0, frame.width, frame.height), b); } catch { /* keep the earlier one */ }
  const predictedAI = isBlurred(b) || (b.user !== 'real' && b.p != null && effP(b) >= thr());
  const isAI = right ? predictedAI : !predictedAI;
  b.user = isAI ? 'ai' : 'real'; if (isAI) b.revealed = false;
  if (b.fp) { ratedList = ratedList.filter((e) => !(Math.abs(e.a - b.fp.a) <= 0.06 && e.v.every((x, i) => Math.abs(x - b.fp.v[i]) < 6))); ratedList.push({ ...b.fp, verdict: b.user }); }
  chip.querySelector('.lbl').textContent = right ? 'Thanks · noted' : isAI ? 'Got it · marked AI, blurred' : 'Got it · marked real, unblurred';
  chip.dataset.flash = String(performance.now() + 1800);
  slop.clickable(false);
  // a small copy of the picture and its scores, saved on this PC only
  const VW = video.videoWidth, VH = video.videoHeight, X = (v) => Math.round(v / f);
  const x = Math.max(0, X(b.x)), y = Math.max(0, X(b.y)), w = Math.min(VW - x, X(b.w)), h = Math.min(VH - y, X(b.h));
  const s = Math.min(1, 512 / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  c.toBlob(async (blob) => {
    const meta = { verdict: b.user, detectorSaid: predictedAI ? 'ai' : 'real', right, score: b.p == null ? null : +b.p.toFixed(4), scores: (b.history || []).map((v) => +v.toFixed(4)), text: b.textHit || null, size: [w, h], fp: b.fp || null, level, sensitivity: settings.sensitivity };
    slop.rate(meta, blob ? await blob.arrayBuffer() : null);
  }, 'image/jpeg', 0.85);
}
let lastRender = 0, drawn = []; // drawn: the blurred rectangles of the last frame (for tests)
function renderLoop() { render(); requestAnimationFrame(renderLoop); }
// backup: if the screen-refresh loop ever stalls, keep drawing anyway
setInterval(() => { if (performance.now() - lastRender > 120) render(); }, 60);
function render() {
  lastRender = performance.now();
  if (settings.paused || !engine) return;
  vctx.clearRect(0, 0, view.width, view.height);
  const now = performance.now(), ahead = Math.min(150, Math.max(0, now - frameAt + 8)); // ms the screen is ahead of our capture
  const live = new Set(); drawn = [];
  for (const b of tracker.boxes) {
    const y = b.y + (b.vpm || 0) * ahead;
    const top = Math.max(y, b.clipTop ?? -1e9), bottom = Math.min(y + b.h, b.clipBot ?? 1e9);
    if (bottom - top < 8) continue;
    if (isBlurred(b)) {
      live.add(b.id);
      const moving = Math.abs(b.vpm || 0) > 0.05, m = moving ? Math.min(14, Math.abs(b.vpm) * 25) : 0; // a little extra cover while scrolling
      const pxCap = blurPx(effP(b)) * capPerCss, pad = Math.ceil(pxCap * f * 2); // blur in capture pixels; pad in processing units
      vctx.save();
      vctx.setTransform(1 / f, 0, 0, 1 / f, 0, 0); // shapes in processing units, drawn at full capture resolution
      vctx.beginPath();
      if (b.cells) {
        const cw = b.w / G, ch = b.h / G;
        for (let j = 0; j < G; j++) { let i = 0; while (i < G) { if (!b.cells[j * G + i]) { i++; continue; } let e = i; while (e < G && b.cells[j * G + e]) e++; vctx.rect(b.x + i * cw, y + j * ch, (e - i) * cw, ch); drawn.push([b.x + i * cw, y + j * ch, (e - i) * cw, ch]); i = e; } }
      } else { vctx.rect(b.x, top - m, b.w, bottom - top + 2 * m); drawn.push([b.x, top - m, b.w, bottom - top + 2 * m]); }
      vctx.clip();
      vctx.filter = `blur(${pxCap.toFixed(2)}px) saturate(0.85)`;
      // straight from the live, full-quality capture, at where the picture is now
      const sx = (b.x - pad) / f, sy = (y - pad - m) / f, sw = (b.w + 2 * pad) / f, sh = (b.h + 2 * pad + 2 * m) / f;
      vctx.drawImage(video, sx, sy, sw, sh, b.x - pad, y - pad - m, b.w + 2 * pad, b.h + 2 * pad + 2 * m);
      vctx.restore();
      const chip = uiEl(chips, b.id, () => makeChip(b, true), 'blur');
      chip.className = 'chip';
      setChipText(chip, b.user === 'ai' ? 'You marked AI · show' : b.textHit ? `${b.textHit.kind === 'watermark' ? 'Watermark' : 'Label'} · ${b.textHit.word} · show` : `Likely AI · ${Math.round(b.p * 100)}% · show`);
      chip.style.transform = `translate(${(b.x / k + 8).toFixed(1)}px, ${(top / k + 8).toFixed(1)}px)`;
      const x = uiEl(xs, b.id, () => { const el = clickableEl(document.createElement('div')); el.className = 'x'; el.textContent = '✕'; el.title = 'Remove the blur'; el.addEventListener('click', () => reveal(b)); return el; });
      x.style.transform = `translate(${((b.x + b.w) / k - 34).toFixed(1)}px, ${(top / k + 6).toFixed(1)}px)`;
    } else if (settings.showScores) {
      // diagnostic: a small grey score on every picture it found, blurred or not
      live.add(b.id);
      const chip = uiEl(chips, b.id, () => makeChip(b, false), 'score');
      chip.className = 'chip score';
      setChipText(chip, b.user === 'real' ? 'You marked real' : (b.p == null ? 'checking…' : `AI ${Math.round(b.p * 100)}%`) + (b.textHit ? ` · ${b.textHit.word}` : '') + (b.revealed ? ' (shown)' : ''));
      chip.style.transform = `translate(${(b.x / k + 8).toFixed(1)}px, ${(top / k + 8).toFixed(1)}px)`;
    }
  }
  for (const [id, el] of chips) if (!live.has(id)) { el.remove(); chips.delete(id); }
  for (const [id, el] of xs) if (!live.has(id) || !tracker.boxes.some((b) => b.id === id && isBlurred(b))) { el.remove(); xs.delete(id); }
}

function clearAll() {
  paintBar();
  vctx.clearRect(0, 0, view.width, view.height);
  for (const el of chips.values()) el.remove();
  chips.clear();
  for (const el of xs.values()) el.remove();
  xs.clear();
}

// test hook: lets the test harness read what the overlay is doing
let lastFps = 0;
window.__slopPerf = () => { const o = { frames: perf.n, avgMs: +(perf.ms / Math.max(1, perf.n)).toFixed(1) }; for (const [k2, v] of Object.entries(perf.parts)) o[k2] = +(v / Math.max(1, perf.n)).toFixed(1); perf.n = 0; perf.ms = 0; perf.parts = {}; return o; };
window.__wallCheck = () => {
  if (!wall) return 'no wallpaper loaded';
  const img = fctx.getImageData(0, 0, frame.width, frame.height), a = img.data, w = wall.data;
  return tracker.boxes.map((b) => { let m = 0, n = 0, d = 0; for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) { const x = Math.floor(b.x + ((i + 0.5) * b.w) / 12), y = Math.floor(b.y + ((j + 0.5) * b.h) / 12), q = (y * img.width + x) * 4; const e = Math.abs(a[q] - w[q]) + Math.abs(a[q + 1] - w[q + 1]) + Math.abs(a[q + 2] - w[q + 2]); d += e; n++; if (e < 45) m++; }
    return { box: [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)], match: +(m / n).toFixed(2), avgDiff: Math.round(d / n), blurred: isBlurred(b) }; });
};
window.__slopDrawn = () => drawn.map((r) => r.map((v) => +(v / k).toFixed(1)));
window.__ratedDebug = () => { const img = fctx.getImageData(0, 0, frame.width, frame.height); return tracker.boxes.map((b) => { const fp = fingerprint(img, b); return { x: Math.round(b.x), y: Math.round(b.y), user: b.user || null, a: fp.a, d: ratedList.map((e) => (e.v && e.v.length === fp.v.length ? +(e.v.reduce((t, x, i) => t + Math.abs(x - fp.v[i]), 0) / fp.v.length).toFixed(2) : 'len' + (e.v ? e.v.length : 0)) + '/' + e.verdict + '/a' + e.a) }; }); };
window.__slopUI = () => ({ ocrAvgMs: ocrN ? Math.round(ocrMs / ocrN) : null, texts: tracker.boxes.map((b) => ({ y: Math.round(b.y / k), done: !!b.ocrDone, hit: b.textHit, blurred: isBlurred(b) })), chips: [...chipsEl.querySelectorAll('.chip')].map((c) => c.textContent), xs: chipsEl.querySelectorAll('.x').length });
window.__slopState = () => ({ scoringNow: scoring, level, processed, idle, skipped, scrollAcc, departed: departed.length, paused: settings.paused, k, fps: lastFps, engine: engine?.name, boxes: tracker.boxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), p: b.p, blurred: isBlurred(b), covered: !!b.covered, cellsOn: b.cells ? b.cells.reduce((a, c) => a + c, 0) : null, dynamic: !!b.dynamic, miss: b.miss || 0, lost: b.lost || 0, isScoring: !!b.scoring, nextIn: b.nextScore ? Math.round(b.nextScore - performance.now()) : null, hist: (b.history || []).map((v) => +v.toFixed(2)) })) });
// ---- the control bar (top-left): on/off and close
const bar = document.getElementById('bar');
function paintBar() {
  const on = !settings.paused;
  bar.querySelector('#onoff').textContent = on ? 'On' : 'Off';
  bar.classList.toggle('off', !on);
}
bar.addEventListener('mouseenter', () => slop.clickable(true));
bar.addEventListener('mouseleave', () => slop.clickable(false));
bar.querySelector('#onoff').addEventListener('click', () => { slop.setPaused(!settings.paused); });
bar.querySelector('#close').addEventListener('click', () => slop.quit());
slop.onSettings((s) => { settings = s; paintBar(); if (!menuEl.hidden && !menuEl.contains(document.activeElement)) paintMenu(); });

// ---- the gear menu: everything you can switch, in one place
const menuEl = document.getElementById('menu'), gear = bar.querySelector('#gear');
const TOGGLES = [['video', 'Check videos'], ['readText', 'Read labels and watermarks'], ['ignoreWallpaper', 'Ignore my desktop wallpaper'], ['gameGuard', 'Turn off during games'], ['showScores', 'Show scores on every picture']];
const CHOICES = [
  ['sensitivity', 'Sensitivity', [['sensitive', 'Sensitive'], ['balanced', 'Balanced'], ['strict', 'Strict']]],
  ['cpuLimit', 'CPU limit', [[10, '10%'], [20, '20%'], [35, '35%'], [0, 'None']]],
];
function paintMenu() {
  const s = settings, h = [];
  h.push('<h3>Switches</h3>');
  for (const [k, label] of TOGGLES) h.push(`<label><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`);
  const bp = s.blurPx || 2;
  h.push(`<h3>Blur amount</h3><label class="slider"><input type="range" min="0.5" max="10" step="0.5" value="${bp}" data-slider="blurPx"><span class="val">${bp} px</span></label>`);
  for (const [k, label, opts] of CHOICES) {
    h.push(`<h3>${label}</h3><div class="seg">`);
    for (const [v, l] of opts) h.push(`<button type="button" data-k="${k}" data-v='${JSON.stringify(v)}' class="${s[k] === v ? 'on' : ''}">${l}</button>`);
    h.push('</div>');
  }
  h.push('<h3>Turned off in</h3>');
  const apps = s.offIn || [];
  if (!apps.length) h.push('<div class="none">No apps. Use the … box: "stop in this app".</div>');
  for (const a of apps) h.push(`<div class="app"><span>${a.replace(/[<>&]/g, '')}</span><button type="button" data-remove="${a.replace(/"/g, '')}">Turn back on</button></div>`);
  h.push('<h3>Tools</h3><div class="acts"><button class="act" type="button" data-act="check-files">Check picture files…</button><button class="act" type="button" data-act="open-ratings">Ratings folder</button><button class="act" type="button" data-act="open-log">Log folder</button></div>');
  menuEl.innerHTML = h.join('');
}
menuEl.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k) slop.setSetting(k, e.target.checked); });
menuEl.addEventListener('input', (e) => { const k = e.target.dataset.slider; if (!k) return; const v = Number(e.target.value); e.target.parentElement.querySelector('.val').textContent = `${v} px`; settings[k] = v; slop.setSetting(k, v); });
menuEl.addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.k) slop.setSetting(t.dataset.k, JSON.parse(t.dataset.v));
  else if (t.dataset.remove) slop.setSetting('offIn', (settings.offIn || []).filter((a) => a !== t.dataset.remove));
  else if (t.dataset.act) { slop.action(t.dataset.act); closeMenu(); }
});
function closeMenu() { menuEl.hidden = true; gear.classList.remove('open'); slop.clickable(false); }
gear.addEventListener('click', () => { if (menuEl.hidden) { paintMenu(); menuEl.hidden = false; gear.classList.add('open'); } else closeMenu(); });
menuEl.addEventListener('mouseenter', () => slop.clickable(true));
menuEl.addEventListener('mouseleave', () => slop.clickable(false));

// ---- tray "Check picture files…": each file scored at full size and shrunk to a typical feed size
slop.onCheckFiles(async (files) => {
  const out = [];
  for (const f of files) {
    try {
      const blob = new Blob([f.bytes]), probe = await createImageBitmap(blob), w = probe.width, h = probe.height; probe.close();
      const s = Math.min(1, 500 / w, 750 / h), sw = Math.round(w * s), sh = Math.round(h * s);
      const full = await engine.score(await createImageBitmap(blob), 2);
      const small = await engine.score(await createImageBitmap(blob, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' }), 2);
      out.push({ name: f.name, w, h, sw, sh, full: +full.toFixed(4), small: +small.toFixed(4) });
    } catch (e) { out.push({ name: f.name, error: String(e?.message || e) }); }
  }
  slop.checkFilesDone(out);
});

// ---- feedback box: a sentence about this picture; saved, then acted on
const fb = document.getElementById('fb'), fbIn = document.getElementById('fbIn'), toast = document.getElementById('toast');
let fbBox = null;
function openFeedback(b, chip) {
  fbBox = b;
  const r = chip.getBoundingClientRect();
  fb.style.left = `${Math.min(window.innerWidth - 380, Math.max(6, r.left))}px`; fb.style.top = `${Math.min(window.innerHeight - 90, r.bottom + 6)}px`;
  fb.hidden = false; fbIn.value = '';
  slop.feedbackMode(true); // the overlay can take typing while the box is open
  setTimeout(() => fbIn.focus(), 60);
}
function closeFeedback() { fb.hidden = true; fbBox = null; slop.feedbackMode(false); }
document.getElementById('fbCancel').addEventListener('click', closeFeedback);
fbIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFeedback(); if (e.key === 'Enter') sendFeedback(); });
document.getElementById('fbSend').addEventListener('click', sendFeedback);
async function sendFeedback() {
  const text = fbIn.value.trim(), b = fbBox;
  closeFeedback();
  if (!text || !b) return;
  // 1) save it, with the picture and its scores
  const VW = video.videoWidth, VH = video.videoHeight, X = (v) => Math.round(v / f);
  const x = Math.max(0, X(b.x)), y = Math.max(0, X(b.y)), w = Math.min(VW - x, X(b.w)), h = Math.min(VH - y, X(b.h));
  const s = Math.min(1, 512 / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  try { b.fp = fingerprint(fctx.getImageData(0, 0, frame.width, frame.height), b); } catch { /* keep the earlier one */ }
  const bytes = await new Promise((res) => c.toBlob(async (bl) => res(bl ? await bl.arrayBuffer() : null), 'image/jpeg', 0.85));
  // 2) work out what it means: the phrase reader first, then the small language model for anything else
  let action = readPhrases(text), how = 'phrases';
  if (!action) { showToast('Reading your feedback…', null, 600000); try { action = await llmRead(text); how = 'model'; } catch (e) { how = 'model unavailable'; slop.log('feedback model error', String(e?.message || e)); } }
  action = cleanAction(action);
  const app = await slop.foregroundApp().catch(() => null);
  slop.feedback({ text, action, how, verdictBefore: isBlurred(b) ? 'blurred' : 'not blurred', score: b.p == null ? null : +b.p.toFixed(4), text_hit: b.textHit || null, fp: b.fp || null, app }, bytes);
  // 3) do it, and offer an undo
  const undo = await applyFeedback(action, b, app);
  showToast(`Got it: ${describe(action, app)}`, undo);
}
async function applyFeedback(a, b, app) {
  const prevUser = b.user, prevRevealed = b.revealed;
  if (a.action === 'mark' || a.action === 'similar') {
    b.user = a.verdict; if (a.verdict === 'ai') b.revealed = false;
    const entry = { ...(b.fp || {}), verdict: a.verdict, tol: a.action === 'similar' ? 8 : undefined };
    if (b.fp) ratedList.push(entry);
    slop.rate({ verdict: a.verdict, detectorSaid: null, right: null, score: b.p, fp: b.fp || null, tol: entry.tol, fromFeedback: true }, null);
    return () => { b.user = prevUser; b.revealed = prevRevealed; ratedList = ratedList.filter((e) => e !== entry); slop.unrate(); };
  }
  if (a.action === 'note') return null;
  const token = await slop.applySetting(a.action, a.direction, app); // settings changes live in the main process
  return token ? () => slop.undoSetting(token) : null;
}
// the small language model, on its own thread, started the first time a sentence needs it
let llm = null, llmN = 0; const llmWait = new Map();
function llmRead(text) {
  if (!llm) {
    llm = new Worker('llm-worker.js');
    llm.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') showToast(`Getting the feedback reader ready (one-time download, about 480 MB): ${m.pct}%`, null, 600000);
      else if (m.type === 'ready') { slop.log('feedback reader ready', m.device); showToast('Reading your feedback…', null, 60000); }
      else if (m.type === 'result') { const w = llmWait.get(m.id); llmWait.delete(m.id); if (!w) return; if (m.error) w[1](new Error(m.error)); else { slop.log('feedback reader said', m.raw); w[0](m.action); } }
    };
    llm.onerror = (e) => { slop.log('feedback reader failed to start', e.message || ''); for (const [, w] of llmWait) w[1](new Error('reader failed')); llmWait.clear(); llm = null; };
  }
  return new Promise((ok, bad) => { const id = ++llmN; llmWait.set(id, [ok, bad]); llm.postMessage({ id, text }); setTimeout(() => { if (llmWait.has(id)) { llmWait.delete(id); bad(new Error('reader timed out')); } }, 900000); });
}
let toastTimer = 0;
function showToast(msg, undo, ms = 8000) {
  toast.querySelector('.msg').textContent = msg;
  const u = toast.querySelector('.undo'); u.hidden = !undo;
  u.onclick = () => { if (undo) undo(); toast.querySelector('.msg').textContent = 'Undone'; u.hidden = true; slop.clickable(false); clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.hidden = true), 2500); };
  toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; slop.clickable(false); }, ms);
}
clickableEl(toast);

start().then(paintBar);
