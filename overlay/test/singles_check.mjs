import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { findPanels } from '../src/core.js';
let n = 0, split = [];
for (const f of readdirSync('/tmp/singles')) {
  const p = PNG.sync.read(readFileSync(`/tmp/singles/${f}`));
  const r = findPanels({ data: p.data, width: p.width, height: p.height }, { x: 0, y: 0, w: p.width, h: p.height });
  n++; if (r.length) split.push(`${f}: ${r.length}`);
}
console.log(`${n} single pictures checked, wrongly split: ${split.length ? split.join(', ') : 'none'}`);
