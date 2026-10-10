import { readPhrases } from '../src/feedback.js';
const cases = [
  ['this is ai, look at the hands', 'mark/ai'], ['this is a real photo of my friend', 'mark/real'], ['stop blurring stuff in discord', 'app_off'],
  ['too many false alarms', 'sensitivity/down'], ['it keeps missing obvious ones', 'sensitivity/up'], ['anything like this is ai', 'similar/ai'],
  ['pictures like this are real', 'similar/real'], ['too blurry, I can barely tell what it is', 'strength/down'], ['blur more, I can still see it fine', 'strength/up'],
  ['stop blurring profile pics', 'ignore_small'], ['the colors look weird', null], ["it's not ai, it's my dog", 'mark/real'], ['ai slop', 'mark/ai'],
];
let ok = 0;
for (const [t, want] of cases) { const r = readPhrases(t); const got = r ? [r.action, r.verdict || r.direction].filter(Boolean).join('/') : null; if (got === want) ok++; else console.log('WRONG:', t, '->', got, 'wanted', want); }
console.log(`${ok}/${cases.length} phrases read right`);
