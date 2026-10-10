// Model runner for the overlay page: same preprocessing and calibration as Detectra v3.
import * as ort from '../node_modules/onnxruntime-web/dist/ort.bundle.min.mjs';

const CFG = { inputSize: 384, resize: 440, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], a: 1.121656, b: 0.506874 };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export async function createEngine(modelBytes, wasmBytes, log = () => {}) {
  ort.env.wasm.wasmBinary = wasmBytes;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  let session = null, name = null, lastErr = null;
  for (const ep of ['webgpu', 'wasm']) {
    if (ep === 'webgpu' && !('gpu' in navigator)) continue;
    try { session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: [ep], graphOptimizationLevel: 'all' }); name = ep; break; }
    catch (e) { lastErr = e; log(`engine ${ep} failed: ${e?.message || e}`); }
  }
  if (!session) throw new Error(`no engine available: ${lastErr?.message || lastErr}`);
  const input = session.inputNames[0], output = session.outputNames[0], s = CFG.inputSize;
  await session.run({ [input]: new ort.Tensor('float32', new Float32Array(3 * s * s), [1, 3, s, s]) }); // warm-up
  let queue = Promise.resolve();
  return {
    name,
    /** Probability (0..1) that this picture is AI-generated. */
    async score(bitmap) {
      let best = 0;
      for (const tensor of [preprocess(bitmap), preprocessWhole(bitmap)]) {
        const run = () => session.run({ [input]: tensor });
        const res = await (queue = queue.then(run, run));
        best = Math.max(best, sigmoid(CFG.a * res[output].data[0] + CFG.b));
      }
      return best;
    },
  };
}

// the whole picture shrunk to fit 384x384, padded with the average color (catches what the middle crop cuts off)
function preprocessWhole(bitmap) {
  const s = CFG.inputSize, k = s / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(s, s), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(124,116,104)'; g.fillRect(0, 0, s, s);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, Math.floor((s - w) / 2), Math.floor((s - h) / 2), w, h);
  return toTensor(g.getImageData(0, 0, s, s).data, s);
}
function toTensor(data, crop) {
  const { mean, std } = CFG, n = crop * crop, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4] / 255 - mean[0]) / std[0];
    out[n + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, crop, crop]);
}

// shortest edge -> 440, center crop 384, [0,1], ImageNet normalize, CHW float32 (mirrors training)
function preprocess(bitmap) {
  const { resize, inputSize: crop, mean, std } = CFG;
  const k = resize / Math.min(bitmap.width, bitmap.height);
  const w = Math.max(crop, Math.round(bitmap.width * k)), h = Math.max(crop, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  const { data } = g.getImageData(Math.floor((w - crop) / 2), Math.floor((h - crop) / 2), crop, crop);
  const n = crop * crop, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4] / 255 - mean[0]) / std[0];
    out[n + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, crop, crop]);
}
