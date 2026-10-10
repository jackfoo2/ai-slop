import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { findRegions } from '../src/core.js';
const p = PNG.sync.read(readFileSync('test/ex1280.png')), k = 1280 / 1920;
const boxes = findRegions({ data: p.data, width: p.width, height: p.height }, { block: 8, minW: 120 * k, minH: 90 * k }).map((b) => ({ x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k }));
const truth = JSON.parse(readFileSync('test/ex1920.json', 'utf8'));
const iou = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i); };
const rows = {};
for (const t of truth) { const row = Math.round(t.y / 280); rows[row] = rows[row] || [0, 0]; rows[row][1]++; if (boxes.some((b) => iou(b, t) > 0.6)) rows[row][0]++; }
for (const [r, [hit, n]] of Object.entries(rows)) console.log(`row ${+r + 1}: found ${hit} of ${n} thumbnails separately`);
console.log(`detections: ${boxes.length}, thumbnails on screen: ${truth.length}`);
