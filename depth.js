import { pipeline, env } from '@huggingface/transformers';

// Depth Anything V2 Small, ONNX build for transformers.js.
// Verify this ID on https://huggingface.co/onnx-community before release.
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
const MAX_SIDE_DEFAULT = 1024;

env.allowLocalModels = false;

let pipePromise = null;
let activeDevice = null;
const cache = new WeakMap();

function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

function makeProgress(onProgress) {
  return (info) => {
    if (onProgress && info && info.status === 'progress' && typeof info.progress === 'number') {
      onProgress(Math.max(0, Math.min(100, Math.round(info.progress))));
    }
  };
}

async function build(device, onProgress) {
  const pipe = await pipeline('depth-estimation', MODEL_ID, {
    device,
    progress_callback: makeProgress(onProgress),
  });
  activeDevice = device;
  return pipe;
}

function ensurePipeline(onProgress) {
  if (!pipePromise) {
    const first = hasWebGPU() ? 'webgpu' : 'wasm';
    pipePromise = build(first, onProgress).catch((err) => {
      if (first === 'webgpu') {
        // WebGPU init failed: rebuild on WASM once.
        return build('wasm', onProgress);
      }
      throw err;
    });
    pipePromise.catch(() => {
      pipePromise = null;
    });
  }
  return pipePromise;
}

// Convert a raw single-channel result into a canvas if toCanvas() is unavailable.
function rawToCanvas(raw) {
  const c = document.createElement('canvas');
  c.width = raw.width;
  c.height = raw.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(raw.width, raw.height);
  const channels = raw.channels || 1;
  for (let i = 0, p = 0; i < raw.width * raw.height; i++, p += 4) {
    const v = raw.data[i * channels];
    img.data[p] = v;
    img.data[p + 1] = v;
    img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Separable box filter with a sliding window. Edges are clamped.
function boxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      const cnt = Math.min(x + r, w - 1) - Math.max(x - r, 0) + 1;
      tmp[row + x] = acc / cnt;
      if (x + r + 1 < w) acc += src[row + x + r + 1];
      if (x - r >= 0) acc -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const cnt = Math.min(y + r, h - 1) - Math.max(y - r, 0) + 1;
      out[y * w + x] = acc / cnt;
      if (y + r + 1 < h) acc += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

// Guided filter (He et al.): smooths p while keeping the edges of the guide image I.
// I and p are single-channel arrays in 0 to 1.
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const mI = boxFilter(I, w, h, r);
  const mp = boxFilter(p, w, h, r);
  const mII = boxFilter(II, w, h, r);
  const mIp = boxFilter(Ip, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxFilter(a, w, h, r);
  const mb = boxFilter(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

async function computeDepth(img, { onProgress, maxSide, blur }) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('The image has no size yet.');

  const s = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * s));
  const dh = Math.max(1, Math.round(h * s));

  const small = document.createElement('canvas');
  small.width = dw;
  small.height = dh;
  small.getContext('2d').drawImage(img, 0, 0, dw, dh);

  const blob = await new Promise((resolve, reject) => {
    small.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo for the depth model.'))),
      'image/png'
    );
  });
  const url = URL.createObjectURL(blob);

  try {
    let pipe = await ensurePipeline(onProgress);
    let result;
    try {
      result = await pipe(url);
    } catch (err) {
      if (activeDevice !== 'webgpu') throw err;
      // WebGPU inference failed: rebuild on WASM and retry once.
      pipePromise = build('wasm', onProgress);
      pipe = await pipePromise;
      result = await pipe(url);
    }

    const raw = result.depth;
    const src = typeof raw.toCanvas === 'function' ? raw.toCanvas() : rawToCanvas(raw);

    // The model's map is coarse (its input is about 518 px). Bring it to photo size, then
    // refine its edges with the photo as a guide so depth boundaries follow the real edges.
    const coarse = document.createElement('canvas');
    coarse.width = dw;
    coarse.height = dh;
    const cctx = coarse.getContext('2d', { willReadFrequently: true });
    cctx.imageSmoothingQuality = 'high';
    if (blur > 0) cctx.filter = `blur(${blur}px)`;
    cctx.drawImage(src, 0, 0, dw, dh);
    cctx.filter = 'none';
    const depthPx = cctx.getImageData(0, 0, dw, dh).data;
    const guidePx = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, dw, dh).data;

    const n = dw * dh;
    const guide = new Float32Array(n);
    const dep = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      guide[i] = (0.299 * guidePx[k] + 0.587 * guidePx[k + 1] + 0.114 * guidePx[k + 2]) / 255;
      dep[i] = depthPx[k] / 255;
    }
    const radius = Math.max(2, Math.round(Math.max(dw, dh) / 128));
    const refined = guidedFilter(guide, dep, dw, dh, radius, 0.01);

    const out = document.createElement('canvas');
    out.width = dw;
    out.height = dh;
    const octx = out.getContext('2d');
    const img = octx.createImageData(dw, dh);
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      const v = Math.max(0, Math.min(255, Math.round(refined[i] * 255)));
      img.data[k] = v;
      img.data[k + 1] = v;
      img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Call early (on page load) so the model downloads while the user picks a photo.
export function warmUp(onProgress) {
  return ensurePipeline(onProgress);
}

export function getDepth(imageElement, { onProgress, maxSide = MAX_SIDE_DEFAULT, blur = 0 } = {}) {
  if (cache.has(imageElement)) return cache.get(imageElement);
  const job = computeDepth(imageElement, { onProgress, maxSide, blur });
  cache.set(imageElement, job);
  job.catch(() => cache.delete(imageElement));
  return job;
}

export function loadDepthPNG(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error(`Could not load the depth map at ${url}`));
    img.src = url;
  });
}
