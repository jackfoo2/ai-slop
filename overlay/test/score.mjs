// Scores the vision core against the captured frames: does it find the pictures, and does tracking keep up with scrolling?
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { findRegions, grayDown, Tracker } from '../src/core.js';
const meta = JSON.parse(readFileSync('test/frames/meta.json', 'utf8'));
const load = (i) => { const p = PNG.sync.read(readFileSync(`test/frames/f${String(i).padStart(3, '0')}.png`)); return { data: p.data, width: p.width, height: p.height }; };
const iou = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i); };
const VIEW = { w: 1280, h: 800 };
const visible = (r) => { const h = Math.min(VIEW.h, r.y + r.h) - Math.max(54, r.y); return h > 0 ? h / r.h : 0; }; // below the 54px sticky header
const clipToView = (r) => { const y0 = Math.max(54, r.y), y1 = Math.min(VIEW.h, r.y + r.h); return { ...r, y: y0, h: y1 - y0 }; };

// ---- 1) detection, every 4th frame
let gtN = 0, hit = 0, det = 0, good = 0, ms = 0, runs = 0; const missBy = {};
for (let i = 0; i < meta.length; i += 4) {
  const img = load(i);
  const t0 = performance.now(); const boxes = findRegions(img); ms += performance.now() - t0; runs++;
  const gts = meta[i].rects.filter((r) => visible(r) >= 0.5).map(clipToView).filter((r) => r.h >= 80);
  det += boxes.length;
  for (const b of boxes) if (gts.some((g) => iou(b, g) >= 0.6)) good++;
  for (const g of gts) { gtN++; if (boxes.some((b) => iou(b, g) >= 0.6)) hit++; else missBy[g.src] = (missBy[g.src] || 0) + 1; }
}
console.log(`DETECTION: found ${hit}/${gtN} pictures (${(100 * hit / gtN).toFixed(0)}%), ${good}/${det} detections were real pictures (${(100 * good / Math.max(1, det)).toFixed(0)}%), ${(ms / runs).toFixed(0)} ms per full-screen pass`);
console.log('  missed, by picture:', JSON.stringify(missBy));

// ---- 2) tracking: start from frame 0's true boxes, follow them through the scroll using pixels only
const tr = new Tracker({ searchY: 60 });
const s = 4;
const first = meta[0].rects.filter((r) => visible(r) >= 0.5);
for (const r of first) tr.add({ x: r.x, y: r.y, w: r.w, h: r.h, src: r.src, gi: r.i });
let errs = [], tms = 0, gms = 0, lostAt = {}, trackedBefore = [];
for (let i = 0; i < meta.length; i++) {
  const fr = load(i);
  const tg = performance.now(); const gc = grayDown(fr, 4), gf = grayDown(fr, 1); gms += performance.now() - tg;
  const t0 = performance.now(); tr.update(gc, gf); tms += performance.now() - t0;
  // add pictures as they scroll in (in the real app, detection does this a few times a second)
  if (i % 8 === 4) for (const r of meta[i].rects) if (visible(r) >= 0.6 && !tr.boxes.some((b) => b.gi === r.i)) tr.add({ x: r.x, y: r.y, w: r.w, h: r.h, src: r.src, gi: r.i });
  for (const b of tr.boxes) {
    const truth = meta[i].rects.find((r) => r.i === b.gi);
    if (truth && visible(truth) > 0.2) { errs.push({ i, e: Math.abs(b.y - truth.y), fast: i >= 61 && i <= 63 }); if (Math.abs(b.y - truth.y) > 3 && process.env.DBG) console.log('  frame', i, 'picture', b.gi, 'box y', Math.round(b.y), 'true y', Math.round(truth.y), 'h', Math.round(truth.h)); }
  }
  for (const id of trackedBefore) { const r = meta[i].rects.find((q) => q.i === id); if (r && visible(r) > 0.3 && !tr.boxes.some((b) => b.gi === id)) lostAt[id] = lostAt[id] ?? i; }
  trackedBefore = tr.boxes.map((b) => b.gi);
}
const smooth = errs.filter((e) => !e.fast).map((e) => e.e), fast = errs.filter((e) => e.fast).map((e) => e.e);
const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
const p95 = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * 0.95)].toFixed(0) : '-'; };
console.log(`TRACKING: smooth scrolling, box off by ${avg(smooth)} px on average (95% within ${p95(smooth)} px); during the fast flick ${avg(fast)} px; ${(tms / meta.length).toFixed(1)} ms per frame tracking + ${(gms / meta.length).toFixed(1)} ms making the gray copies`);
console.log('  tracked pictures lost while still on screen:', Object.keys(lostAt).length ? JSON.stringify(lostAt) : 'none');
