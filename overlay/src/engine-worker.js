// Runs the detection model on its own thread, so the overlay never freezes while a picture is scored.
import { createEngine } from './engine.js';
let engine = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try { engine = await createEngine(m.model, m.wasm, (t) => self.postMessage({ type: 'log', text: t })); self.postMessage({ type: 'ready', name: engine.name }); }
    catch (err) { self.postMessage({ type: 'error', error: String(err?.message || err) }); }
  } else if (m.type === 'score') {
    try { const p = await engine.score(m.bitmap); m.bitmap.close(); self.postMessage({ type: 'score', id: m.id, p }); }
    catch (err) { self.postMessage({ type: 'score', id: m.id, error: String(err?.message || err) }); }
  }
};
