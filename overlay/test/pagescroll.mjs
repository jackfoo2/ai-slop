import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { grayDown, Tracker } from '../src/core.js';
const meta = JSON.parse(readFileSync('test/frames/meta.json', 'utf8'));
const load = (i) => { const p = PNG.sync.read(readFileSync(`test/frames/f${String(i).padStart(3, '0')}.png`)); return { data: p.data, width: p.width, height: p.height }; };
const tr = new Tracker(); let acc = 0, bad = 0;
for (let i = 0; i < meta.length; i++) {
  const f = load(i); tr.update(grayDown(f, 4), grayDown(f, 1)); acc += tr.pageShift || 0;
  const truth = -(meta[i].scroll - meta[0].scroll);
  if (Math.abs(acc - truth) > 2) bad++;
  if (i % 12 === 0 || i === meta.length - 1 || (i >= 60 && i <= 64)) console.log(`frame ${i}: measured page moved ${acc}px, truly ${truth}px`);
}
console.log(`frames more than 2 px off: ${bad} of ${meta.length}`);
