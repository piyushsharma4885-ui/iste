const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Fixture types. radius is a fraction of the longer side. core scales the hot centre.
export const FIXTURES = {
  ceiling: { label: 'Ceiling', radius: 0.38, core: 0.55, cone: 150 },
  floor: { label: 'Floor', radius: 0.24, core: 0.8, cone: 120 },
  sconce: { label: 'Sconce', radius: 0.16, core: 1.0, cone: 110 },
  table: { label: 'Table', radius: 0.2, core: 0.9, cone: 110 },
  accent: { label: 'Accent', radius: 0.1, core: 1.2, cone: 60 },
};

// Approximate RGB for a colour temperature in Kelvin (Tanner Helland's curve fit).
export function kelvinToRGB(K) {
  const t = Math.min(40000, Math.max(1000, K)) / 100;
  let r;
  let g;
  let b;
  r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.round(Math.max(0, Math.min(255, v)));
  return [c(r), c(g), c(b)];
}

// Draws the night tint and vignette over the relit image. Lamp light is computed in the shader (relight.js).
export function applyEffects(canvas, { lamps = [], lampStrength = 0, nightAmount = 0 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const n = clamp01(nightAmount);
  if (n > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${255 - 175 * n}, ${255 - 150 * n}, ${255 - 70 * n})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Vignette: white until 35% of the radius, then darkening to the corners.
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(cx, cy);
  const vg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  vg.addColorStop(0.35, 'rgb(255, 255, 255)');
  vg.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// Downloads exactly what is on the visible canvas.
export function exportPNG(canvas, filename = 'relight.png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Export failed.'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    }, 'image/png');
  });
}

// Brightest distinct cells on a 16x16 grid, at least 0.3 apart. Returns {x, y} in [0, 1], top-left origin.
export function findLamps(photoCanvas, count = 3) {
  const G = 16;
  const c = document.createElement('canvas');
  c.width = G;
  c.height = G;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photoCanvas, 0, 0, G, G);

  let data;
  try {
    data = ctx.getImageData(0, 0, G, G).data;
  } catch (err) {
    return [];
  }

  const cells = [];
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 4;
      const L = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255;
      cells.push({ x: (i + 0.5) / G, y: (j + 0.5) / G, L });
    }
  }
  cells.sort((a, b) => b.L - a.L);

  const picked = [];
  for (const cell of cells) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.hypot(p.x - cell.x, p.y - cell.y) >= 0.3)) {
      picked.push({ x: cell.x, y: cell.y });
    }
  }
  return picked;
}
