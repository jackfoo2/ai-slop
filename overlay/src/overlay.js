// AI Slop Overlay — the see-through page over the screen.
// Each frame: capture the screen, keep boxes glued to pictures as things scroll, and draw a light
// blur over the ones the model thinks are AI. A few times a second: look for new pictures.
import { findRegions, grayDown, Tracker } from './core.js';

const THRESH = { sensitive: 0.5, balanced: 0.65, strict: 0.8 };
const BLUR = { light: [3, 9], medium: [6, 16], strong: [10, 24] }; // CSS px at the line -> at 100%
const DETECT_EVERY = 150, MAX_PROC_W = 1280, RESCORE_FLAGGED = 8000, RESCORE_CLEAN = 2500, LEAD_FRAMES = 1;

const slop = window.slop;
const view = document.getElementById('view'), vctx = view.getContext('2d');
const chipsEl = document.getElementById('chips');
const video = document.createElement('video'); video.muted = true;
const frame = document.createElement('canvas'), fctx = frame.getContext('2d', { willReadFrequently: true });
let settings = { paused: false, strength: 'light', sensitivity: 'balanced', video: true };
let engine = null, tracker = new Tracker({ searchY: 60 }), k = 1; // k = processed pixels per CSS pixel
let f = 1; // processed pixels per captured pixel (big screens are processed at a lighter size)
let lastDetect = 0, frames = 0, fpsT = performance.now(), scoring = 0;
const cache = new Map(); // picture signature -> { p, revealed }
const chips = new Map(); // box id -> chip element
const thr = () => THRESH[settings.sensitivity] ?? 0.65;
const blurPx = (p) => { const t = thr(), [lo, hi] = BLUR[settings.strength] || BLUR.light; const q = Math.min(1, Math.max(0, (p - t) / (1 - t))); return lo + (hi - lo) * q; };

async function start() {
  try {
    settings = await slop.settings();
    slop.onSettings((s) => { settings = s; if (s.paused) clearAll(); });
    const disp = await slop.display();
    slop.status({ model: 'loading' });
    engine = await startEngine(await slop.model(), await slop.wasm());
    slop.status({ model: 'ready', engine: engine.name });
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    video.srcObject = stream; await video.play();
    f = Math.min(1, MAX_PROC_W / video.videoWidth);
    k = (video.videoWidth * f) / disp.width || 1;
    slop.log('capturing', { video: [video.videoWidth, video.videoHeight], display: disp, k, engine: engine.name });
    video.requestVideoFrameCallback(onFrame);
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
      else if (m.type === 'ready') resolve({ name: m.name, score: (bitmap) => new Promise((ok, bad) => { const id = ++nid; pending.set(id, [ok, bad]); w.postMessage({ type: 'score', id, bitmap }, [bitmap]); }) });
      else if (m.type === 'score') { const [ok, bad] = pending.get(m.id) || []; pending.delete(m.id); if (m.error) bad?.(new Error(m.error)); else ok?.(m.p); }
    };
    w.postMessage({ type: 'init', model, wasm }, [model, wasm]);
  });
}

function onFrame() {
  const t0 = performance.now();
  try { step(); } catch (e) { slop.log('frame error', String(e?.stack || e)); }
  perf.n++; perf.ms += performance.now() - t0;
  video.requestVideoFrameCallback(onFrame);
}

function step() {
  if (!video.videoWidth || !video.videoHeight) return;
  const W = Math.round(video.videoWidth * f), H = Math.round(video.videoHeight * f);
  if (frame.width !== W || frame.height !== H) { frame.width = W; frame.height = H; view.width = W; view.height = H; tracker = new Tracker({ searchY: 60 }); }
  if (settings.paused) { clearAll(); return; }
  let t = performance.now(); const mark = (k) => { const n = performance.now(); perf.parts[k] = (perf.parts[k] || 0) + n - t; t = n; };
  fctx.drawImage(video, 0, 0, W, H); mark('draw');
  const img = fctx.getImageData(0, 0, W, H); mark('read');
  const gc = grayDown(img, 4), gf = grayDown(img, 1); mark('gray');
  tracker.update(gc, gf); mark('track');
  const now = performance.now();
  if (now - lastDetect > DETECT_EVERY) { lastDetect = now; detect(img); mark('detect'); }
  for (const b of tracker.boxes) if (b.nextScore && now > b.nextScore && b.p != null) queueScore(b);
  render(); mark('render');
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
  const found = findRegions(img, { block: Math.max(8, Math.round(8 * k)), minW: 120 * k, minH: 90 * k });
  const seen = new Set();
  for (const r of found) {
    const hit = tracker.boxes.find((b) => iou(b, r) > 0.3);
    if (hit) { hit.x = r.x; hit.y = r.y; hit.w = r.w; hit.h = r.h; hit.miss = 0; seen.add(hit.id); continue; } // snap to the exact edges
    const b = tracker.add({ ...r, p: null, history: [], sig: signature(img, r) });
    const known = cache.get(b.sig);
    seen.add(b.id);
    if (known) { b.p = known.p; b.revealed = known.revealed; b.nextScore = performance.now() + RESCORE_CLEAN; }
    else queueScore(b);
  }
  // a picture that two re-scans in a row can't find is gone: drop it (and its blur) right away
  for (const b of tracker.boxes) if (!seen.has(b.id)) b.miss = (b.miss || 0) + 1;
  tracker.boxes = tracker.boxes.filter((b) => (b.miss || 0) < 2);
  // pictures that have gone away take their chips with them
  for (const [id, el] of chips) if (!tracker.boxes.some((b) => b.id === id)) { el.remove(); chips.delete(id); }
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

function queueScore(b) {
  if (b.scoring || scoring >= 2) return;
  if (!settings.video && b.history.length) return;
  b.scoring = true; scoring++;
  const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
  const w = Math.min(frame.width - x, Math.round(b.w)), h = Math.min(frame.height - y, Math.round(b.h));
  if (w < 32 || h < 32) { b.scoring = false; scoring--; return; }
  createImageBitmap(video, Math.round(x / f), Math.round(y / f), Math.round(w / f), Math.round(h / f))
    .then((bmp) => engine.score(bmp))
    .then((p) => {
      b.history.push(p); if (b.history.length > 3) b.history.shift();
      b.p = b.history.reduce((a, c) => a + c, 0) / b.history.length;
      b.nextScore = performance.now() + (b.p >= thr() ? RESCORE_FLAGGED : RESCORE_CLEAN);
      cache.set(b.sig, { p: b.p, revealed: !!b.revealed });
    })
    .catch((e) => slop.log('score error', String(e?.message || e)))
    .finally(() => { b.scoring = false; scoring--; });
}

const isBlurred = (b) => b.p != null && b.p >= thr() && !b.revealed && !b.lost;

function render() {
  vctx.clearRect(0, 0, view.width, view.height);
  const live = new Set();
  for (const b of tracker.boxes) {
    if (!isBlurred(b)) continue;
    live.add(b.id);
    const lead = (b.vy || 0) * LEAD_FRAMES; // the screen has moved on a little since this frame
    const px = blurPx(b.p) * k, pad = Math.ceil(px * 2);
    const y = b.y + lead;
    vctx.save();
    vctx.beginPath(); vctx.rect(b.x, y, b.w, b.h); vctx.clip();
    vctx.filter = `blur(${px.toFixed(1)}px) saturate(0.85)`;
    vctx.drawImage(frame, b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad, b.x - pad, y - pad, b.w + 2 * pad, b.h + 2 * pad);
    vctx.restore();
    let chip = chips.get(b.id);
    if (!chip) {
      chip = document.createElement('div'); chip.className = 'chip';
      chip.addEventListener('mouseenter', () => slop.clickable(true));
      chip.addEventListener('mouseleave', () => slop.clickable(false));
      chip.addEventListener('click', () => { b.revealed = true; const c = cache.get(b.sig); if (c) c.revealed = true; slop.clickable(false); chip.remove(); chips.delete(b.id); });
      chipsEl.appendChild(chip); chips.set(b.id, chip);
    }
    chip.textContent = `Likely AI · ${Math.round(b.p * 100)}% · show`;
    chip.style.transform = `translate(${(b.x / k + 8).toFixed(1)}px, ${(y / k + 8).toFixed(1)}px)`;
  }
  for (const [id, el] of chips) if (!live.has(id)) { el.remove(); chips.delete(id); }
}

function clearAll() {
  paintBar();
  vctx.clearRect(0, 0, view.width, view.height);
  for (const el of chips.values()) el.remove();
  chips.clear();
}

// test hook: lets the test harness read what the overlay is doing
let lastFps = 0;
window.__slopPerf = () => { const o = { frames: perf.n, avgMs: +(perf.ms / Math.max(1, perf.n)).toFixed(1) }; for (const [k2, v] of Object.entries(perf.parts)) o[k2] = +(v / Math.max(1, perf.n)).toFixed(1); perf.n = 0; perf.ms = 0; perf.parts = {}; return o; };
window.__slopState = () => ({ paused: settings.paused, k, fps: lastFps, engine: engine?.name, boxes: tracker.boxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), p: b.p, blurred: isBlurred(b) })) });
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
slop.onSettings((s) => { settings = s; paintBar(); });

start().then(paintBar);
