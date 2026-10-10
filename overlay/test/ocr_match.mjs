import { matchAiText } from '../src/ocr.js';
const cases = [
  ['', 'Ana Lopez · 2h · AI info\nSunset tonight', 'label'], ['', 'sunset vibes #aiart #midjourney', 'label'], ['lmagined with Al', '', 'watermark'],
  ['KLING AI', '', 'watermark'], ['sora', '', 'watermark'], ['', 'Is this real? Looks amazing', null], ['', 'Gemini season starts today', null],
  ['', 'fashion week runway looks', null], ['', 'I took this with my phone', null], ['Imagined w1th AI', '', 'watermark'], ['', 'Altered or synthetic content', 'label'],
  ['', 'sorarity', null], ['', 'a1 generated', 'label'],
];
let ok = 0;
for (const [inside, around, want] of cases) { const r = matchAiText(inside, around); const got = r ? r.kind : null; if (got === want) ok++; else console.log('WRONG:', JSON.stringify({ inside, around, want, got: r })); }
console.log(`${ok}/${cases.length} text cases right`);
