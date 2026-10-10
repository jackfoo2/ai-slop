// The feedback reader's language model (Qwen2.5-0.5B-Instruct, Apache-2.0), on its own thread.
// Its files come through the app's own "slopmodels:" address, which downloads them once from the
// official Hugging Face repo and keeps them on this PC.
import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.web.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'slopmodels://hf/';
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('tjs/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;

const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
const SYSTEM = `You turn one sentence of feedback about an app that blurs AI-made pictures into exactly one JSON action.
The actions:
{"action":"mark","verdict":"ai"}  this picture is AI-made / fake / generated
{"action":"mark","verdict":"real"}  this picture is real, a real photo, not AI
{"action":"similar","verdict":"ai"}  pictures like this one are AI
{"action":"similar","verdict":"real"}  pictures like this one are real
{"action":"app_off"}  stop working in the current app or program
{"action":"sensitivity","direction":"down"}  too many false alarms, it blurs too much
{"action":"sensitivity","direction":"up"}  it misses AI pictures, it should catch more
{"action":"strength","direction":"up"}  the blur is too weak
{"action":"strength","direction":"down"}  the blur is too strong
{"action":"ignore_small"}  stop blurring small things like avatars, icons, thumbnails
{"action":"note"}  anything else
Examples:
"the fingers are all wrong, obviously generated" -> {"action":"mark","verdict":"ai"}
"my cousin took this at the lake" -> {"action":"mark","verdict":"real"}
"leave my game alone" -> {"action":"app_off"}
"the colors look odd" -> {"action":"note"}
Reply with the JSON only.`;

let gen = null, loading = null;
async function load() {
  if (gen) return gen;
  loading ??= (async () => {
    let gpu = false;
    try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { gpu = false; }
    let last = -1;
    const progress = (p) => { if (p.status === 'progress' && p.file && /onnx/.test(p.file)) { const pct = Math.floor(p.progress || 0); if (pct !== last && pct % 5 === 0) { last = pct; self.postMessage({ type: 'progress', pct }); } } };
    gen = await pipeline('text-generation', MODEL, { device: gpu ? 'webgpu' : 'wasm', dtype: gpu ? 'q4f16' : 'q4', progress_callback: progress });
    self.postMessage({ type: 'ready', device: gpu ? 'webgpu' : 'wasm' });
    return gen;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

self.onmessage = async (e) => {
  const { id, text } = e.data;
  try {
    const g = await load();
    const out = await g([{ role: 'system', content: SYSTEM }, { role: 'user', content: String(text).slice(0, 300) }], { max_new_tokens: 40, do_sample: false });
    const reply = out[0].generated_text.at(-1).content;
    const m = reply.match(/\{[^{}]*\}/);
    let action = null; try { action = m ? JSON.parse(m[0]) : null; } catch { action = null; }
    self.postMessage({ type: 'result', id, action, raw: reply });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: String(err?.message || err) });
  }
};
