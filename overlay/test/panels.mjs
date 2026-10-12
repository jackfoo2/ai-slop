import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { findPanels } from '../src/core.js';
for (const f of readdirSync('/tmp/coll').sort()) {
  const p = PNG.sync.read(readFileSync(`/tmp/coll/${f}`));
  const img = { data: p.data, width: p.width, height: p.height };
  const t0 = performance.now();
  const panels = findPanels(img, { x: 0, y: 0, w: p.width, h: p.height });
  console.log(`${f.padEnd(26)} panels: ${String(panels.length).padStart(2)}  ${panels.map((r) => `${r.w}x${r.h}`).join(' ')}  (${(performance.now() - t0).toFixed(0)} ms)`);
}
