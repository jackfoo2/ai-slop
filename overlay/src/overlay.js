// AI Slop Overlay — the see-through page over the screen.
// Each frame: capture the screen, keep boxes glued to pictures as things scroll, and draw a light
// blur over the ones the model thinks are AI. A few times a second: look for new pictures.
import { findRegions, grayDown, Tracker } from './core.js';
import { startOcr, readText, matchAiText } from './ocr.js';

const THRESH = { sensitive: 0.5, balanced: 0.65, strict: 0.8 };
const BLUR = { light: [3, 9], medium: [6, 16], strong: [10, 24] }; // CSS px at the line -> at 100%
const DETECT_EVERY = 150, MAX_PROC_W = 1280, RESCORE_FLAGGED = 8000, RESCORE_CLEAN = 2500, LEAD_FRAMES = 1;

const slop = window.slop;
const view = document.getElementById('view'), vctx = view.getContext('2d');
const chipsEl = document.getElementById('chips');
const video = document.createElement('video'); video.muted = true;
const frame = document.createElement('canvas'), fctx = frame.getContext('2d', { willReadFrequently: true });
let settings = { paused: false, strength: 'light', sensitivity: 'balanced', video: true, showScores: false, readText: true };
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
  for (const b of tracker.boxes) if (b.p != null) lastSeen.set(b.id, { x: b.x, w: b.w, top: b.y - scrollAcc, h: b.h, p: b.p, revealed: !!b.revealed, history: b.history.slice(), textHit: b.textHit, ocrDone: b.ocrDone });
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
const blurPx = (p) => { const t = thr(), [lo, hi] = BLUR[settings.strength] || BLUR.light; const q = Math.min(1, Math.max(0, (p - t) / (1 - t))); return lo + (hi - lo) * q; };

async function start() {
  try {
    settings = await slop.settings();
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
    slop.log('capturing', { video: [video.videoWidth, video.videoHeight], display: disp, k, engine: engine.name });
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
      else if (m.type === 'ready') resolve({ name: m.name, score: (bitmap) => new Promise((ok, bad) => { const id = ++nid; pending.set(id, [ok, bad]); w.postMessage({ type: 'score', id, bitmap }, [bitmap]); }) });
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
  if (frame.width !== W || frame.height !== H) { frame.width = W; frame.height = H; view.width = W; view.height = H; tracker = new Tracker({ searchY: 60 }); }
  if (settings.paused) { clearAll(); return; }
  let t = performance.now(); const mark = (k) => { const n = performance.now(); perf.parts[k] = (perf.parts[k] || 0) + n - t; t = n; };
  fctx.drawImage(video, 0, 0, W, H); mark('draw');
  const img = fctx.getImageData(0, 0, W, H); mark('read');
  const gc = grayDown(img, 4), gf = grayDown(img, 1); mark('gray');
  tracker.update(gc, gf); scrollAcc += tracker.pageShift || 0; mark('track');
  const now = performance.now();
  if (now - lastDetect > DETECT_EVERY) { lastDetect = now; detect(img); mark('detect'); }
  for (const b of tracker.boxes) if (b.p == null ? !b.scoring : (b.nextScore && now > b.nextScore)) queueScore(b); // unscored pictures retry every frame
  if (settings.readText && !ocrBusy) { const b = tracker.boxes.find((x) => !x.ocrDone && Math.abs(x.vpm || 0) < 0.02 && x.y >= 0 && x.y + x.h <= frame.height); if (b) queueOcr(b); }
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
  const found = findRegions(img, { block: Math.max(8, Math.round(8 * k)), minW: 120 * k, minH: 90 * k });
  const seen = new Set();
  for (const r of found) {
    const inter = (b) => Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x)) * Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
    const hit = tracker.boxes.find((b) => iou(b, r) > 0.3) || tracker.boxes.find((b) => inter(b) > 0.8 * b.w * b.h);
    if (hit) {
      const ratio = (r.w * r.h) / (hit.w * hit.h);
      if (ratio > 0.7 && ratio < 1.4) snapTo(hit, r); // a much bigger shape around it (hover highlight): keep the picture's own box
      hit.miss = 0; hit.thumb = thumbOf(img, hit); seen.add(hit.id); continue;
    }
    const b = tracker.add({ ...r, p: null, history: [], sig: signature(img, r) });
    b.thumb = thumbOf(img, b);
    const known = cache.get(b.sig);
    seen.add(b.id);
    const back = known ? null : recall(r);
    if (known) { b.p = known.p; b.revealed = known.revealed; b.textHit = known.textHit; b.ocrDone = known.ocrDone; b.nextScore = performance.now() + RESCORE_CLEAN; }
    else if (back) { b.p = back.p; b.revealed = back.revealed; b.history = back.history.slice(); b.textHit = back.textHit; b.ocrDone = back.ocrDone; b.nextScore = performance.now() + 1000; } // scrolled back: blur at once, re-check soon
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

/** Correct a tracked box from a fresh detection without making it jump around. */
function snapTo(b, r) {
  if (Math.abs(r.x - b.x) > 2 || Math.abs(r.w - b.w) > 2) { b.x = r.x; b.w = r.w; }
  const dTop = r.y - b.y, dBot = (r.y + r.h) - (b.y + b.h);
  if (Math.abs(dBot) <= 6 && dTop > 8) { b.clipTop = r.y; b.clipBot = null; if (Math.abs(dBot) > 2) b.y += dBot; }            // covered at the top
  else if (Math.abs(dTop) <= 6 && dBot < -8) { b.clipBot = r.y + r.h; b.clipTop = null; if (Math.abs(dTop) > 2) b.y += dTop; } // covered at the bottom
  else { b.clipTop = b.clipBot = null; if (Math.abs(dTop) > 2 || Math.abs(dBot) > 2) { b.y = r.y; b.h = r.h; } }
}

/** An 8x8 gray thumbnail of what's inside a box right now, to tell "same picture" from "something else". */
function thumbOf(img, b) {
  const { data, width: W, height: H } = img, t = new Float32Array(64);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(b.x + ((i + 0.5) * b.w) / 8))), y = Math.min(H - 1, Math.max(0, Math.floor(b.y + ((j + 0.5) * b.h) / 8))), q = (y * W + x) * 4;
    t[j * 8 + i] = (data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 8;
  }
  return t;
}
function sameContent(img, b) {
  if (b.y < 0 || b.y + b.h > img.height) return false; // partly off screen: let the normal rules decide
  const now = thumbOf(img, b); let d = 0;
  for (let i = 0; i < 64; i++) d += Math.abs(now[i] - b.thumb[i]);
  return d / 64 < 14;
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

let ocrBusy = false, ocrMs = 0, ocrN = 0;
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
    .then((bmp) => engine.score(bmp))
    .then((p) => {
      b.history.push(p); if (b.history.length > 3) b.history.shift();
      b.p = b.history.reduce((a, c) => a + c, 0) / b.history.length;
      b.nextScore = performance.now() + (b.p >= thr() ? RESCORE_FLAGGED : RESCORE_CLEAN);
      cache.set(b.sig, { ...(cache.get(b.sig) || {}), p: b.p, revealed: !!b.revealed });
    })
    .catch((e) => slop.log('score error', String(e?.message || e)))
    .finally(() => { b.scoring = false; scoring--; });
}

const textP = (b) => (b.textHit ? (b.textHit.kind === 'watermark' ? 0.97 : 0.9) : 0);
const effP = (b) => Math.max(b.p ?? 0, textP(b));
const isBlurred = (b) => (b.p != null || b.textHit) && effP(b) >= thr() && !b.revealed && (b.lost || 0) < 2;

// ---- drawing: its own loop at the screen's refresh rate, projecting each box forward by how fast it
// moves and how old the latest capture is, so the blur keeps up with scrolling between captures
const xs = new Map(); // box id -> its ✕ button
function uiEl(map, id, make, kind = '') { let el = map.get(id); if (el && el.dataset.kind !== kind) { el.remove(); el = null; } if (!el) { el = make(); el.dataset.kind = kind; chipsEl.appendChild(el); map.set(id, el); } return el; }
function clickableEl(el) { el.addEventListener('mouseenter', () => slop.clickable(true)); el.addEventListener('mouseleave', () => slop.clickable(false)); return el; }
function reveal(b) { b.revealed = true; const c = cache.get(b.sig); if (c) c.revealed = true; slop.clickable(false); }

let lastRender = 0;
function renderLoop() { render(); requestAnimationFrame(renderLoop); }
// backup: if the screen-refresh loop ever stalls, keep drawing anyway
setInterval(() => { if (performance.now() - lastRender > 120) render(); }, 60);
function render() {
  lastRender = performance.now();
  if (settings.paused || !engine) return;
  vctx.clearRect(0, 0, view.width, view.height);
  const now = performance.now(), ahead = Math.min(150, Math.max(0, now - frameAt + 8)); // ms the screen is ahead of our capture
  const live = new Set();
  for (const b of tracker.boxes) {
    const y = b.y + (b.vpm || 0) * ahead;
    const top = Math.max(y, b.clipTop ?? -1e9), bottom = Math.min(y + b.h, b.clipBot ?? 1e9);
    if (bottom - top < 8) continue;
    if (isBlurred(b)) {
      live.add(b.id);
      const moving = Math.abs(b.vpm || 0) > 0.05, m = moving ? Math.min(14, Math.abs(b.vpm) * 25) : 0; // a little extra cover while scrolling
      const px = blurPx(effP(b)) * k, pad = Math.ceil(px * 2);
      vctx.save();
      vctx.beginPath(); vctx.rect(b.x, top - m, b.w, bottom - top + 2 * m); vctx.clip();
      vctx.filter = `blur(${px.toFixed(1)}px) saturate(0.85)`;
      vctx.drawImage(frame, b.x - pad, b.y - pad - m, b.w + 2 * pad, b.h + 2 * pad + 2 * m, b.x - pad, y - pad - m, b.w + 2 * pad, b.h + 2 * pad + 2 * m);
      vctx.restore();
      const chip = uiEl(chips, b.id, () => { const el = clickableEl(document.createElement('div')); el.className = 'chip'; el.addEventListener('click', () => reveal(b)); return el; }, 'blur');
      chip.className = 'chip';
      chip.textContent = b.textHit ? `${b.textHit.kind === 'watermark' ? 'Watermark' : 'Label'} · ${b.textHit.word} · show` : `Likely AI · ${Math.round(b.p * 100)}% · show`;
      chip.style.transform = `translate(${(b.x / k + 8).toFixed(1)}px, ${(top / k + 8).toFixed(1)}px)`;
      const x = uiEl(xs, b.id, () => { const el = clickableEl(document.createElement('div')); el.className = 'x'; el.textContent = '✕'; el.title = 'Remove the blur'; el.addEventListener('click', () => reveal(b)); return el; });
      x.style.transform = `translate(${((b.x + b.w) / k - 34).toFixed(1)}px, ${(top / k + 6).toFixed(1)}px)`;
    } else if (settings.showScores) {
      // diagnostic: a small grey score on every picture it found, blurred or not
      live.add(b.id);
      const chip = uiEl(chips, b.id, () => { const el = document.createElement('div'); el.className = 'chip'; return el; }, 'score');
      chip.className = 'chip score';
      chip.textContent = (b.p == null ? 'checking…' : `AI ${Math.round(b.p * 100)}%`) + (b.textHit ? ` · ${b.textHit.word}` : '') + (b.revealed ? ' (shown)' : '');
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
window.__slopUI = () => ({ ocrAvgMs: ocrN ? Math.round(ocrMs / ocrN) : null, texts: tracker.boxes.map((b) => ({ y: Math.round(b.y / k), done: !!b.ocrDone, hit: b.textHit, blurred: isBlurred(b) })), chips: [...chipsEl.querySelectorAll('.chip')].map((c) => c.textContent), xs: chipsEl.querySelectorAll('.x').length });
window.__slopState = () => ({ scrollAcc, departed: departed.length, paused: settings.paused, k, fps: lastFps, engine: engine?.name, boxes: tracker.boxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), p: b.p, blurred: isBlurred(b) })) });
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
