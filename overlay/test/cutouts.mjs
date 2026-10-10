import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { findRegions } from '../src/core.js';
const k = 1280 / 1920;
for (const name of ['cutouts_light', 'cutouts_dark', 'explorer', 'index']) {
  const p = PNG.sync.read(readFileSync(`/tmp/${name}_1280.png`));
  const boxes = findRegions({ data: p.data, width: p.width, height: p.height }, { block: 8, minW: 120 * k, minH: 90 * k }).map((b) => ({ x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k }));
  const truth = JSON.parse(readFileSync(`/tmp/${name}.json`, 'utf8'));
  // a picture counts as found if a box sits inside it and covers a real part of it (cut-outs only show their subject)
  const inside = (b, t) => b.x >= t.x - 20 && b.y >= t.y - 20 && b.x + b.w <= t.x + t.w + 20 && b.y + b.h <= t.y + t.h + 20 && b.w * b.h >= 0.15 * t.w * t.h;
  const found = truth.filter((t) => boxes.some((b) => inside(b, t))).length;
  const stray = boxes.filter((b) => !truth.some((t) => inside(b, t) || (b.x < t.x + t.w && b.x + b.w > t.x && b.y < t.y + t.h && b.y + b.h > t.y))).length;
  console.log(`${name.padEnd(14)} pictures found ${found}/${truth.length}, boxes not on any picture: ${stray}`);
}
