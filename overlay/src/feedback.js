// Turning a sentence of feedback into one of the few things the app can actually do.
// The phrase reader below works on its own; the small language model (see llm-worker.js) handles
// sentences it can't place, and its answer is checked against the same menu.

export const ACTIONS = ['mark', 'similar', 'app_off', 'sensitivity', 'strength', 'ignore_small', 'note'];

/** Validate an action from any source: anything off-menu becomes a note. */
export function cleanAction(a) {
  if (!a || !ACTIONS.includes(a.action)) return { action: 'note' };
  if ((a.action === 'mark' || a.action === 'similar') && !['ai', 'real'].includes(a.verdict)) return { action: 'note' };
  if ((a.action === 'sensitivity' || a.action === 'strength') && !['up', 'down'].includes(a.direction)) return { action: 'note' };
  return { action: a.action, verdict: a.verdict, direction: a.direction };
}

/** The phrase reader: common ways of saying each thing. Returns an action, or null if unsure. */
export function readPhrases(text) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has(' discord', ' in this app', ' in this program', 'turn off in', 'turn it off in', "don't run in", 'dont run in', 'stop in ', 'never in ', 'not in this app', 'ignore this app', 'off in this'))
    return { action: 'app_off' };
  if (has('too many false', 'false alarms', 'too sensitive', 'blurs everything', 'blurring everything', 'blurs too much', 'too trigger happy', 'less sensitive'))
    return { action: 'sensitivity', direction: 'down' };
  if (has('misses a lot', 'missing a lot', 'keeps missing', 'not catching', 'more sensitive', 'misses too many', 'catch more'))
    return { action: 'sensitivity', direction: 'up' };
  if (has('blur more', 'stronger blur', 'blur harder', 'too light', 'not blurry enough', 'more blur'))
    return { action: 'strength', direction: 'up' };
  if (has('too blurry', 'blur less', 'lighter blur', 'too strong', 'too much blur', 'less blur'))
    return { action: 'strength', direction: 'down' };
  if (has('profile pic', 'avatar', 'thumbnail', ' icons', ' emoji', 'small pictures', 'tiny pictures', 'small images'))
    return { action: 'ignore_small' };
  const real = has('not ai', "isn't ai", 'isnt ai', 'is real', ' are real', 'real ones', 'real photo', 'real picture', 'real person', 'its real', "it's real", 'false positive', 'not fake', 'actually real', 'human made', 'i took');
  const ai = !real && has(' is ai', ' its ai', "it's ai", 'ai made', 'ai generated', 'ai-generated', 'generated', ' fake', ' ai art', 'made by ai', 'definitely ai', ' slop');
  const similar = has('like this', 'similar', 'anything like', 'all of these', 'these are', 'this style', 'this kind', 'pictures like');
  if (real || ai) return { action: similar ? 'similar' : 'mark', verdict: real ? 'real' : 'ai' };
  return null;
}

/** A short plain-English description of an action, for the confirmation. */
export function describe(a, app) {
  switch (a.action) {
    case 'mark': return a.verdict === 'ai' ? 'marked this picture AI' : 'marked this picture real';
    case 'similar': return a.verdict === 'ai' ? 'will blur pictures that look like this' : "won't blur pictures that look like this";
    case 'app_off': return app ? `turned off in ${app}` : 'noted (no app to turn off in)';
    case 'sensitivity': return a.direction === 'down' ? 'less sensitive: blurs only when surer' : 'more sensitive: blurs when less sure';
    case 'strength': return a.direction === 'up' ? 'a bit more blur' : 'a bit less blur';
    case 'ignore_small': return 'ignores small pictures now';
    default: return 'saved as a note';
  }
}
