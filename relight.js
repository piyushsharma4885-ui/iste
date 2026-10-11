import { kelvinToRGB, FIXTURES } from './effects.js';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPhoto;
uniform sampler2D uDepth;
uniform sampler2D uBlur;
uniform vec2 uTexel;
uniform vec3 uNewSun;
uniform vec3 uOrigSun;
uniform float uSunStrength;
uniform float uWarmth;
uniform float uExposure;
uniform float uNormalK;
uniform float uAspect;
uniform float uNight;
uniform vec3 uWB;
uniform float uLampPower;
uniform float uLampCount;
uniform vec2 uLampUV[8];
uniform vec3 uLampColor[8];
uniform float uLampI[8];
uniform float uLampCos[8];
uniform float uLampCosIn[8];

float depthOff(vec2 off) {
  return texture2D(uDepth, vUv + off * uTexel).r;
}

float lambert(vec3 n, vec3 l) {
  return 0.25 + 0.75 * max(dot(n, l), 0.0);
}

// Blinn-Phong highlight for the sun, viewer straight on.
float specTerm(vec3 n, vec3 l) {
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  return pow(max(dot(n, h), 0.0), 40.0);
}

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSRGB(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

// Soft highlight rolloff above 0.8 so bright walls roll off instead of clipping.
vec3 shoulder(vec3 x) {
  vec3 knee = 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2));
  return mix(x, knee, step(0.8, x));
}

// Hue-preserving rolloff: compress the brightest channel and scale the others with it,
// so bright colours keep their hue instead of drifting toward yellow or pale.
vec3 hueSafe(vec3 x) {
  x = max(x, vec3(0.0));
  float peak = max(max(x.r, x.g), x.b);
  if (peak <= 0.8) return x;
  float mapped = shoulder(vec3(peak)).x;
  return x * (mapped / peak);
}

// Screen-space march from the surface point P toward the lamp L through the height field.
// Returns the fraction of steps blocked by geometry (0 = clear, 1 = fully blocked).
float lampOcclusion(vec3 P, vec3 L) {
  float occ = 0.0;
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 13.0;
    vec3 Q = mix(P, L, t);
    vec2 suv = clamp(vec2(Q.x / uAspect, Q.y), vec2(0.0), vec2(1.0));
    float surf = texture2D(uDepth, suv).r * 0.5;
    occ += step(Q.z + 0.015, surf);
  }
  return occ / 12.0;
}

void main() {
  vec3 photoS = texture2D(uPhoto, vUv).rgb;
  vec3 photo = toLinear(photoS) * uWB;
  float lum = dot(photoS, vec3(0.299, 0.587, 0.114));

  // Sobel-style gradients on a 5x5 footprint, weighted across three rows and columns.
  float gx = (depthOff(vec2( 2.0,-2.0)) + 2.0 * depthOff(vec2( 2.0, 0.0)) + depthOff(vec2( 2.0, 2.0))
            - depthOff(vec2(-2.0,-2.0)) - 2.0 * depthOff(vec2(-2.0, 0.0)) - depthOff(vec2(-2.0, 2.0))) / 8.0;
  float gy = (depthOff(vec2(-2.0, 2.0)) + 2.0 * depthOff(vec2( 0.0, 2.0)) + depthOff(vec2( 2.0, 2.0))
            - depthOff(vec2(-2.0,-2.0)) - 2.0 * depthOff(vec2( 0.0,-2.0)) - depthOff(vec2( 2.0,-2.0))) / 8.0;
  // Clamp so large depth jumps at object borders never create halos or outlines.
  gx = clamp(gx, -0.03, 0.03);
  gy = clamp(gy, -0.03, 0.03);

  vec3 n = normalize(vec3(-gx * uNormalK, -gy * uNormalK, 1.0));

  // Cavity shading: pixels deeper than their surroundings (creases, corners) get a soft darkening.
  float ring = (depthOff(vec2(-6.0, 0.0)) + depthOff(vec2(6.0, 0.0)) + depthOff(vec2(0.0,-6.0)) + depthOff(vec2(0.0, 6.0))
              + depthOff(vec2(-4.0,-4.0)) + depthOff(vec2(4.0,-4.0)) + depthOff(vec2(-4.0, 4.0)) + depthOff(vec2(4.0, 4.0))) / 8.0;
  float cavity = clamp((ring - depthOff(vec2(0.0))) * 3.0, 0.0, 0.12);
  float aoMix = mix(1.0, 1.0 - cavity, uSunStrength);

  // Sun (unchanged).
  float ratio = clamp(lambert(n, uNewSun) / lambert(n, uOrigSun), 0.6, 1.5);
  ratio = mix(1.0, ratio, uSunStrength);

  float gloss = smoothstep(0.55, 0.95, lum);
  float specDelta = specTerm(n, uNewSun) - specTerm(n, uOrigSun);
  float specAdd = specDelta * gloss * uSunStrength * 0.35;

  // Point lamps: inverse-square falloff, lampshade cone, soft shadows, specular, bounce.
  vec3 P = vec3(vUv.x * uAspect, vUv.y, texture2D(uDepth, vUv).r * 0.5);
  vec3 blurCol = toLinear(texture2D(uBlur, vUv).rgb) * uWB;
  float matte = smoothstep(0.002, 0.02, length(vec2(gx, gy)));
  float lampPowerI = mix(0.02, 0.25, uLampPower);
  vec3 lampLight = vec3(0.0);
  float lampE = 0.0;
  for (int k = 0; k < 8; k++) {
    if (float(k) >= uLampCount) break;
    vec3 col = uLampColor[k];
    vec2 luv = uLampUV[k];
    vec3 L = vec3(luv.x * uAspect, luv.y, texture2D(uDepth, luv).r * 0.5 + 0.08);
    vec3 toL = L - P;
    float d = length(toL);
    vec3 Ld = toL / max(d, 0.0001);

    float E = lampPowerI * uLampI[k] / (d * d + 0.02);
    float cone = smoothstep(uLampCos[k], uLampCosIn[k], dot(normalize(P - L), vec3(0.0, 0.0, -1.0)));
    float Ek = E * cone * (1.0 - 0.8 * lampOcclusion(P, L));
    float lam = max(dot(n, Ld), 0.0);

    vec3 H = normalize(Ld + vec3(0.0, 0.0, 1.0));
    float fres = 0.04 + 0.96 * pow(1.0 - max(H.z, 0.0), 5.0);
    float lampSpec = pow(max(dot(n, H), 0.0), 48.0) * 0.25 * fres * matte;

    lampLight += photo * col * Ek * lam;      // direct diffuse
    lampLight += col * lampSpec * Ek;         // glossy highlight, matte walls excluded
    lampLight += blurCol * col * Ek * 0.15;   // bounce from the room's own colours
    lampE += Ek;
  }

  // At night, the sun's share fades where the lamps dominate.
  float share = clamp(lampE / (lampE + 1.0), 0.0, 1.0);
  ratio = mix(ratio, 1.0, smoothstep(0.5, 1.0, uNight) * share);

  vec3 tint = mix(vec3(0.92, 0.97, 1.08), vec3(1.16, 1.0, 0.78), uWarmth);
  tint = mix(vec3(1.0), tint, uSunStrength);

  vec3 lin = photo * ratio * tint * aoMix * uExposure + specAdd * uExposure + lampLight;
  lin = hueSafe(lin);
  gl_FragColor = vec4(clamp(toSRGB(lin), 0.0, 1.0), 1.0);
}`;

const UNIFORMS = [
  'uPhoto', 'uDepth', 'uBlur', 'uTexel', 'uNewSun', 'uOrigSun',
  'uSunStrength', 'uWarmth', 'uExposure', 'uNormalK', 'uAspect',
  'uNight', 'uWB', 'uLampPower', 'uLampCount',
  'uLampUV[0]', 'uLampColor[0]', 'uLampI[0]', 'uLampCos[0]', 'uLampCosIn[0]',
];

const states = new WeakMap();

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function makeTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function upload(gl, tex, unit, source) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

function setup(canvas) {
  const opts = { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false };
  const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  if (!gl) throw new Error('WebGL is not available in this browser.');

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);

  // Full-screen triangle strip.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  for (const name of UNIFORMS) u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, name);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform1i(u.uPhoto, 0);
  gl.uniform1i(u.uDepth, 1);
  gl.uniform1i(u.uBlur, 2);

  const st = {
    canvas,
    gl,
    prog,
    u,
    photoTex: makeTexture(gl),
    depthTex: makeTexture(gl),
    blurTex: makeTexture(gl),
    small: document.createElement('canvas'),
    photoRef: null,
    depthRef: null,
    blurRef: null,
    fake: null,
  };
  // Keep textures bound to their units for the life of the context.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, st.photoTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, st.depthTex);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, st.blurTex);
  return st;
}

function getState(canvas) {
  let st = states.get(canvas);
  if (!st) {
    st = setup(canvas);
    states.set(canvas, st);
  }
  return st;
}

function fakeDepth(st, w, h) {
  if (st.fake && st.fake.width === w && st.fake.height === h) return st.fake;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#404040');
  g.addColorStop(1, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  st.fake = c;
  return c;
}

function norm3(x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// Prepare the WebGL context on a canvas. Safe to call more than once.
export function initRelight(canvas) {
  getState(canvas);
  return true;
}

// Grey-world white balance estimate. Saturated pixels count for less, so a red wall does not
// tint the whole estimate. Returns per-channel gains, limited and blended toward neutral.
const wbCache = new WeakMap();
function whiteBalanceGain(photo) {
  if (wbCache.has(photo)) return wbCache.get(photo);
  const N = 32;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sw = 0;
  for (let i = 0; i < N * N; i++) {
    const r = Math.pow(d[4 * i] / 255, 2.2);
    const g = Math.pow(d[4 * i + 1] / 255, 2.2);
    const b = Math.pow(d[4 * i + 2] / 255, 2.2);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = (mx - mn) / (mx + 1e-3);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const w = (1 / (sat + 0.25)) * (lum > 0.05 && lum < 0.95 ? 1 : 0.2);
    sr += r * w;
    sg += g * w;
    sb += b * w;
    sw += w;
  }
  const mR = sr / sw;
  const mG = sg / sw;
  const mB = sb / sw;
  const grey = (mR + mG + mB) / 3;
  const gain = [mR, mG, mB].map((m) => {
    const raw = grey / Math.max(m, 1e-4);
    const limited = Math.max(0.65, Math.min(1.35, raw));
    return 1 + (limited - 1) * 0.85; // partial correction keeps some of the room's character
  });
  wbCache.set(photo, gain);
  return gain;
}

// lamps: up to 8 of { x, y (0 to 1, y down), kelvin, intensity (0 to 1), type }.
// lampPower: 0 to 1, the master lamp brightness. night: 0 to 1, time-of-day night amount.
export function relight(targetCanvas, photo, depthCanvas, opts = {}) {
  const st = getState(targetCanvas);
  const gl = st.gl;
  const {
    sunX = -0.4,
    sunY = 0.4,
    sunStrength = 0.8,
    warmth = 0.5,
    exposure = 1.0,
    normalK = 4.0,
    orig = { x: -0.4, y: 0.4 },
    lamps = [],
    lampPower = 0,
    night = 0,
  } = opts;

  const w = photo.width;
  const h = photo.height;
  if (targetCanvas.width !== w || targetCanvas.height !== h) {
    targetCanvas.width = w;
    targetCanvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.useProgram(st.prog);

  if (st.photoRef !== photo) {
    upload(gl, st.photoTex, 0, photo);
    st.photoRef = photo;
  }

  // Blurred colour field for bounce light: an 8x8 copy of the photo, sampled bilinearly.
  if (st.blurRef !== photo) {
    st.small.width = 8;
    st.small.height = 8;
    st.small.getContext('2d').drawImage(photo, 0, 0, 8, 8);
    upload(gl, st.blurTex, 2, st.small);
    st.blurRef = photo;
  }

  const depth = depthCanvas || fakeDepth(st, w, h);
  if (st.depthRef !== depth) {
    upload(gl, st.depthTex, 1, depth);
    st.depthRef = depth;
  }

  const u = st.u;
  gl.uniform2f(u.uTexel, 1 / depth.width, 1 / depth.height);
  gl.uniform3fv(u.uNewSun, norm3(sunX, sunY, 0.6));
  gl.uniform3fv(u.uOrigSun, norm3(orig.x * 0.8, orig.y * 0.8, 0.6));
  gl.uniform1f(u.uSunStrength, sunStrength);
  gl.uniform1f(u.uWarmth, warmth);
  gl.uniform1f(u.uExposure, exposure);
  gl.uniform1f(u.uNormalK, normalK);
  gl.uniform1f(u.uAspect, w / h);
  gl.uniform1f(u.uNight, night);
  gl.uniform3fv(u.uWB, whiteBalanceGain(photo));
  gl.uniform1f(u.uLampPower, lampPower);

  const n = Math.min(8, lamps.length);
  const posUV = new Float32Array(16);
  const colors = new Float32Array(24);
  const intens = new Float32Array(8);
  const cosOuter = new Float32Array(8);
  const cosInner = new Float32Array(8);
  for (let k = 0; k < n; k++) {
    const lamp = lamps[k];
    posUV[2 * k] = lamp.x;
    posUV[2 * k + 1] = 1 - lamp.y; // texture space has y up
    const rgb = kelvinToRGB(lamp.kelvin || 2700).map((c) => Math.pow(c / 255, 2.2));
    colors.set(rgb, 3 * k);
    intens[k] = lamp.intensity ?? 0.6;
    const f = FIXTURES[lamp.type] || FIXTURES.table;
    cosOuter[k] = Math.cos((f.cone * Math.PI) / 180);
    cosInner[k] = Math.cos(((f.cone - 35) * Math.PI) / 180);
  }
  gl.uniform1f(u.uLampCount, n);
  gl.uniform2fv(u.uLampUV, posUV);
  gl.uniform3fv(u.uLampColor, colors);
  gl.uniform1fv(u.uLampI, intens);
  gl.uniform1fv(u.uLampCos, cosOuter);
  gl.uniform1fv(u.uLampCosIn, cosInner);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return targetCanvas;
}

// Brightness-cubed weighted centroid on a 24x24 thumbnail. Returns {x, y} in [-1, 1], y up.
export function estimateLight(photoCanvas) {
  const FALLBACK = { x: -0.4, y: 0.4 };
  const N = 24;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photoCanvas, 0, 0, N, N);

  let data;
  try {
    data = ctx.getImageData(0, 0, N, N).data;
  } catch (err) {
    return { ...FALLBACK };
  }

  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4;
      const L = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255;
      const wgt = L * L * L;
      sw += wgt;
      sx += wgt * ((i / (N - 1)) * 2 - 1);
      sy += wgt * (1 - (j / (N - 1)) * 2);
    }
  }
  if (sw < 1e-4) return { ...FALLBACK };
  return {
    x: Math.max(-1, Math.min(1, sx / sw)),
    y: Math.max(-1, Math.min(1, sy / sw)),
  };
}
