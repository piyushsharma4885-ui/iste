import { getDepth, warmUp } from './depth.js';
import { initRelight, relight, estimateLight } from './relight.js';
import { applyEffects, exportPNG, findLamps, kelvinToRGB, FIXTURES } from './effects.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

const el = {
  file: $('file'),
  choose: $('choose'),
  newPhoto: $('newPhoto'),
  figure: $('figure'),
  view: $('view'),
  backdrop: $('backdrop'),
  panel: $('panel'),
  grabber: $('grabber'),
  dial: $('dial'),
  puck: $('puck'),
  time: $('time'),
  timeOut: $('timeOut'),
  strength: $('strength'),
  strengthOut: $('strengthOut'),
  depth: $('depth'),
  depthOut: $('depthOut'),
  lamp: $('lampStrength'),
  lampOut: $('lampOut'),
  kelvin: $('kelvin'),
  kelvinOut: $('kelvinOut'),
  intensity: $('intensity'),
  intensityOut: $('intensityOut'),
  inspectorTitle: $('inspectorTitle'),
  fixtures: $('fixtures'),
  moods: $('moods'),
  deleteLamp: $('deleteLamp'),
  clearLamps: $('clearLamps'),
  showDepth: $('showDepth'),
  presets: $('presets'),
  thumb: $('thumb'),
  compare: $('compare'),
  exportBtn: $('export'),
  status: $('status'),
};

const PRESETS = {
  morning: { hour: 8, strength: 85, lamps: 0 },
  noon: { hour: 12, strength: 80, lamps: 0 },
  golden: { hour: 17.5, strength: 90, lamps: 0 },
  cozy: { hour: 21, strength: 70, lamps: 85 },
};

// Staging moods. Lamp positions come from the photo's brightest spots, in order.
const MOODS = {
  hotel: {
    label: 'Hotel welcome', hour: 19.5, strength: 55, master: 45,
    lamps: [
      { type: 'table', kelvin: 2700, intensity: 0.6 },
      { type: 'ceiling', kelvin: 3000, intensity: 0.3 },
    ],
  },
  airbnb: {
    label: 'Airbnb evening', hour: 20, strength: 40, master: 50,
    lamps: [
      { type: 'floor', kelvin: 2700, intensity: 0.5 },
      { type: 'sconce', kelvin: 2900, intensity: 0.5 },
      { type: 'table', kelvin: 2700, intensity: 0.4 },
    ],
  },
  airy: {
    label: 'Bright and airy', hour: 11, strength: 90, master: 0,
    lamps: [],
  },
  romantic: {
    label: 'Romantic', hour: 21, strength: 30, master: 60,
    lamps: [
      { type: 'table', kelvin: 2200, intensity: 0.7 },
      { type: 'accent', kelvin: 2200, intensity: 0.4 },
    ],
  },
};

const LAMP_LIMIT = 8;
const DIAL_R = 70; // puck travel radius in px for a 168px dial
const HIT_PX = 36; // click radius for selecting an existing light

const glCanvas = document.createElement('canvas'); // offscreen WebGL target

const state = {
  img: null,
  photo: null,
  depth: null,
  fakeDepth: null,
  origLight: { x: -0.4, y: 0.4 },
  lampSpots: [],
  lamps: [],
  selected: null,
  // Defaults for new lamps (the inspector edits the selected lamp when there is one).
  fixture: 'table',
  kelvin: 2700,
  intensity: 0.6,
  sunX: -0.9,
  sunY: 0,
  manualSun: false,
  hour: 12,
  warmth: 0,
  exposure: 1,
  night: 0,
  strength: 0.8,
  depthAmt: 45,
  lampStrength: 0,
  comparing: false,
  showDepth: false,
};

let queued = false;
let depthJob = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');

function formatHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${pad2(mm)} ${hh >= 12 ? 'pm' : 'am'}`;
}

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.dataset.error = isError ? 'true' : 'false';
}

/* --------------------------------------------------------------------------
   Time of day
   -------------------------------------------------------------------------- */

function applyTime(h) {
  state.hour = h;
  const t = clamp((h - 6) / 13, 0, 1);
  const e = Math.sin(Math.PI * t);
  if (!state.manualSun) {
    state.sunX = -Math.cos(Math.PI * t) * 0.9;
    state.sunY = e * 0.9;
  }
  state.warmth = 1 - e;
  state.night = h > 19 ? clamp((h - 19) / 2.5, 0, 1) : 0;
  state.exposure = (0.55 + 0.55 * e) * (1 - 0.45 * state.night);

  // Sun puck colour follows warmth: white at noon, amber at dawn and dusk.
  const cool = [255, 246, 228];
  const warm = [255, 180, 84];
  const rgb = cool.map((c, i) => Math.round(c + (warm[i] - c) * state.warmth));
  const root = document.documentElement.style;
  root.setProperty('--sun-rgb', rgb.join(', '));
  root.setProperty('--night', state.night.toFixed(3));
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

function requestRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(render);
}

function makeFakeDepth(w, h) {
  if (state.fakeDepth && state.fakeDepth.width === w && state.fakeDepth.height === h) {
    return state.fakeDepth;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#404040');
  g.addColorStop(1, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  state.fakeDepth = c;
  return c;
}

function render() {
  queued = false;
  if (!state.photo) return;

  const ctx = el.view.getContext('2d');
  if (state.comparing) {
    ctx.drawImage(state.photo, 0, 0);
  } else if (state.showDepth) {
    ctx.drawImage(state.depth || makeFakeDepth(state.photo.width, state.photo.height), 0, 0);
  } else {
    relight(glCanvas, state.photo, state.depth, {
      sunX: state.sunX,
      sunY: state.sunY,
      sunStrength: state.strength,
      warmth: state.warmth,
      exposure: state.exposure,
      normalK: 0.5 + 7.5 * (state.depthAmt / 100),
      orig: state.origLight,
      lamps: state.lampStrength > 0 ? state.lamps : [],
      lampPower: state.lampStrength / 100,
      night: state.night,
    });
    ctx.drawImage(glCanvas, 0, 0);
    applyEffects(el.view, {
      lamps: state.lamps,
      lampStrength: state.lampStrength / 100,
      nightAmount: state.night,
    });
  }
  scheduleBackdrop();
}

// Backdrop: a tiny copy of the current frame, updated at most about 10 times a second.
let lastBackdrop = 0;
let backdropTimer = 0;

function scheduleBackdrop() {
  const now = performance.now();
  if (now - lastBackdrop >= 100) {
    drawBackdrop();
    lastBackdrop = now;
  } else if (!backdropTimer) {
    backdropTimer = setTimeout(() => {
      backdropTimer = 0;
      drawBackdrop();
      lastBackdrop = performance.now();
    }, 100);
  }
}

function drawBackdrop() {
  if (!state.photo) return;
  const w = 192;
  const h = Math.max(1, Math.round((w * state.photo.height) / state.photo.width));
  if (el.backdrop.width !== w || el.backdrop.height !== h) {
    el.backdrop.width = w;
    el.backdrop.height = h;
  }
  el.backdrop.getContext('2d').drawImage(el.view, 0, 0, w, h);
}

/* --------------------------------------------------------------------------
   Lamps: markers, selection, inspector
   -------------------------------------------------------------------------- */

function lampCss(lamp) {
  const [r, g, b] = kelvinToRGB(lamp.kelvin);
  return `rgb(${r}, ${g}, ${b})`;
}

// No dots on the photo. Only the clear button label reflects the lamp count.
function renderMarkers() {
  const n = state.lamps.length;
  el.clearLamps.textContent = n ? `Clear ${n} lamp${n === 1 ? '' : 's'}` : 'Clear lamps';
}

function selectLamp(i) {
  state.selected = state.selected === i ? null : i;
  renderMarkers();
  syncInspector();
}

function selectedLamp() {
  return state.selected !== null && state.lamps[state.selected] ? state.lamps[state.selected] : null;
}

function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${pct}%`);
}

function syncInspector() {
  const lamp = selectedLamp();
  const t = lamp || { type: state.fixture, kelvin: state.kelvin, intensity: state.intensity };

  el.fixtures.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.fixture === t.type));
  });
  el.kelvin.value = t.kelvin;
  el.intensity.value = Math.round(t.intensity * 100);
  el.kelvinOut.textContent = `${t.kelvin} K`;
  el.intensityOut.textContent = `${Math.round(t.intensity * 100)}%`;
  paintRange(el.kelvin);
  paintRange(el.intensity);
  el.inspectorTitle.textContent = lamp ? `Selected lamp: ${FIXTURES[lamp.type].label}` : 'New lamps';
  el.deleteLamp.disabled = !lamp;
}

// Apply an inspector change to the selected lamp, or to the defaults for new lamps.
function editLamp(patch) {
  const lamp = selectedLamp();
  if (lamp) {
    Object.assign(lamp, patch);
  } else {
    if ('type' in patch) state.fixture = patch.type;
    if ('kelvin' in patch) state.kelvin = patch.kelvin;
    if ('intensity' in patch) state.intensity = patch.intensity;
  }
  renderMarkers();
  syncInspector();
  refresh();
}

function makeLamp(x, y) {
  return { x, y, type: state.fixture, kelvin: state.kelvin, intensity: state.intensity };
}

/* --------------------------------------------------------------------------
   Controls
   -------------------------------------------------------------------------- */

function describeSun() {
  const dir = state.sunX < -0.2 ? 'to the left' : state.sunX > 0.2 ? 'to the right' : 'straight ahead';
  const height =
    state.sunY < 0 ? 'below the horizon' : state.sunY < 0.4 ? 'low' : state.sunY < 0.75 ? 'mid-height' : 'high';
  return `Sun ${dir}, ${height}, ${formatHour(state.hour)}`;
}

function updateDial() {
  el.puck.style.left = `${84 + state.sunX * DIAL_R}px`;
  el.puck.style.top = `${84 - state.sunY * DIAL_R}px`;
  el.dial.setAttribute('aria-valuenow', String(Math.round(state.sunX * 100)));
  el.dial.setAttribute('aria-valuetext', describeSun());
}

function updateOutputs() {
  [el.time, el.strength, el.depth, el.lamp].forEach(paintRange);
  el.timeOut.textContent = formatHour(state.hour);
  el.strengthOut.textContent = `${Math.round(state.strength * 100)}%`;
  el.depthOut.textContent = String(state.depthAmt);
  el.lampOut.textContent = `${state.lampStrength}%`;
  el.showDepth.setAttribute('aria-pressed', String(state.showDepth));
}

function refresh() {
  updateOutputs();
  updateDial();
  requestRender();
}

function syncControls() {
  el.time.value = state.hour;
  el.strength.value = Math.round(state.strength * 100);
  el.depth.value = state.depthAmt;
  el.lamp.value = state.lampStrength;
  refresh();
  syncInspector();
}

function moveThumb() {
  const active = el.presets.querySelector('button[aria-pressed="true"]');
  if (!active) {
    el.thumb.style.opacity = '0';
    return;
  }
  el.thumb.style.opacity = '1';
  el.thumb.style.width = `${active.offsetWidth}px`;
  el.thumb.style.transform = `translateX(${active.offsetLeft}px)`;
}

function setPresetHighlight(name) {
  el.presets.querySelectorAll('button[data-preset]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.preset === name));
  });
  moveThumb();
}

function setMoodHighlight(name) {
  el.moods.querySelectorAll('button[data-mood]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mood === name));
  });
}

// Called when the user changes the light by hand: presets and moods are no longer active.
function clearPresetHighlight() {
  setPresetHighlight(null);
  setMoodHighlight(null);
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  state.manualSun = false;
  state.strength = p.strength / 100;
  state.lampStrength = p.lamps;
  if (name === 'cozy' && state.lamps.length === 0) {
    state.lamps = state.lampSpots.map((s) => ({ ...s, type: 'table', kelvin: 2400, intensity: 0.6 }));
    state.selected = null;
    renderMarkers();
  }
  applyTime(p.hour);
  setMoodHighlight(null);
  setPresetHighlight(name);
  syncControls();
}

function applyMood(name) {
  const m = MOODS[name];
  if (!m) return;
  state.manualSun = false;
  state.strength = m.strength / 100;
  state.lampStrength = m.master;
  state.lamps = m.lamps
    .map((l, i) => (state.lampSpots[i] ? { x: state.lampSpots[i].x, y: state.lampSpots[i].y, ...l } : null))
    .filter(Boolean);
  state.selected = null;
  applyTime(m.hour);
  setPresetHighlight(null);
  setMoodHighlight(name);
  renderMarkers();
  syncControls();
  setStatus(`${m.label} applied. Select a lamp to fine-tune it.`);
}

/* --------------------------------------------------------------------------
   Sun dial: pointer drag and keyboard
   -------------------------------------------------------------------------- */

function moveSun(dx, dy) {
  let x = clamp(state.sunX + dx, -1, 1);
  let y = clamp(state.sunY + dy, -1, 1);
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  state.sunX = x;
  state.sunY = y;
  state.manualSun = true;
  clearPresetHighlight();
  refresh();
}

function setSunFromPointer(e) {
  const r = el.dial.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const scale = r.width / 2 - 14;
  let x = (e.clientX - cx) / scale;
  let y = -(e.clientY - cy) / scale;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  state.sunX = x;
  state.sunY = y;
  state.manualSun = true;
  clearPresetHighlight();
  refresh();
}

let dialDragging = false;

el.dial.addEventListener('pointerdown', (e) => {
  if (!state.photo) return;
  dialDragging = true;
  el.dial.setPointerCapture(e.pointerId);
  el.dial.classList.add('grabbing');
  setSunFromPointer(e);
});

el.dial.addEventListener('pointermove', (e) => {
  if (dialDragging) setSunFromPointer(e);
});

function endDial(e) {
  if (!dialDragging) return;
  dialDragging = false;
  el.dial.classList.remove('grabbing');
  try {
    el.dial.releasePointerCapture(e.pointerId);
  } catch (err) {
    /* capture already released */
  }
}
el.dial.addEventListener('pointerup', endDial);
el.dial.addEventListener('pointercancel', endDial);

el.dial.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.15 : 0.05;
  const moves = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  if (moves[e.key]) {
    e.preventDefault();
    moveSun(...moves[e.key]);
  } else if (e.key === 'Home') {
    e.preventDefault();
    state.manualSun = false;
    applyTime(state.hour);
    refresh();
  }
});

/* --------------------------------------------------------------------------
   Sliders and inspector
   -------------------------------------------------------------------------- */

el.time.addEventListener('input', () => {
  clearPresetHighlight();
  state.manualSun = false;
  applyTime(Number(el.time.value));
  refresh();
});

el.strength.addEventListener('input', () => {
  state.strength = Number(el.strength.value) / 100;
  refresh();
});

el.depth.addEventListener('input', () => {
  state.depthAmt = Number(el.depth.value);
  refresh();
});

el.lamp.addEventListener('input', () => {
  state.lampStrength = Number(el.lamp.value);
  refresh();
});

el.kelvin.addEventListener('input', () => {
  editLamp({ kelvin: Number(el.kelvin.value) });
});

el.intensity.addEventListener('input', () => {
  editLamp({ intensity: Number(el.intensity.value) / 100 });
});

el.fixtures.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fixture]');
  if (btn) editLamp({ type: btn.dataset.fixture });
});

el.deleteLamp.addEventListener('click', () => {
  if (state.selected === null) return;
  state.lamps.splice(state.selected, 1);
  state.selected = null;
  setStatus('Lamp deleted.');
  renderMarkers();
  syncInspector();
  refresh();
});

el.presets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (btn) applyPreset(btn.dataset.preset);
});

el.moods.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mood]');
  if (btn) applyMood(btn.dataset.mood);
});

el.clearLamps.addEventListener('click', () => {
  state.lamps = [];
  state.selected = null;
  setStatus('Lamps cleared.');
  renderMarkers();
  syncInspector();
  refresh();
});

el.showDepth.addEventListener('click', () => {
  state.showDepth = !state.showDepth;
  refresh();
});

el.view.addEventListener('click', (e) => {
  if (!state.photo || state.comparing) return;
  const r = el.view.getBoundingClientRect();
  const x = clamp((e.clientX - r.left) / r.width, 0, 1);
  const y = clamp((e.clientY - r.top) / r.height, 0, 1);
  // Close to an existing lamp? Select it instead of adding a new one.
  const near = state.lamps.findIndex(
    (l) => Math.hypot((l.x - x) * r.width, (l.y - y) * r.height) < HIT_PX
  );
  if (near !== -1) {
    selectLamp(near);
    return;
  }
  if (state.lamps.length >= LAMP_LIMIT) {
    setStatus(`Up to ${LAMP_LIMIT} lamps. Delete one to add another.`, true);
    return;
  }
  state.lamps.push(makeLamp(x, y));
  state.selected = state.lamps.length - 1;
  if (state.lampStrength < 20) state.lampStrength = 60;
  setStatus(`Lamp added. ${state.lamps.length} in the room.`);
  renderMarkers();
  syncInspector();
  refresh();
});

// Hold-to-compare: pointer hold, plus Space held.
function setCompare(on) {
  if (state.comparing === on) return;
  state.comparing = on;
  el.compare.setAttribute('aria-pressed', String(on));
  requestRender();
}

el.compare.addEventListener('pointerdown', (e) => {
  if (!state.photo) return;
  e.preventDefault();
  setCompare(true);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
  el.compare.addEventListener(type, () => setCompare(false));
});

function isTextTarget(target) {
  return target instanceof HTMLInputElement && target.type !== 'range';
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || isTextTarget(e.target) || !state.photo) return;
  e.preventDefault();
  if (!e.repeat) setCompare(true);
});

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  setCompare(false);
});

el.exportBtn.addEventListener('click', async () => {
  if (!state.photo) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  try {
    await exportPNG(el.view, `relight-${stamp}.png`);
    setStatus('Saved as PNG.');
  } catch (err) {
    console.error(err);
    setStatus('Export failed. Try again.', true);
  }
});

/* --------------------------------------------------------------------------
   Mobile bottom sheet
   -------------------------------------------------------------------------- */

function setSheet(collapsed) {
  el.panel.classList.toggle('collapsed', collapsed);
  el.grabber.setAttribute('aria-expanded', String(!collapsed));
}

let grabStartY = null;

el.grabber.addEventListener('pointerdown', (e) => {
  grabStartY = e.clientY;
});

el.grabber.addEventListener('pointerup', (e) => {
  if (grabStartY === null) return;
  const dy = e.clientY - grabStartY;
  grabStartY = null;
  if (Math.abs(dy) > 24) {
    setSheet(dy > 0);
  } else {
    setSheet(!el.panel.classList.contains('collapsed'));
  }
});

el.grabber.addEventListener('pointercancel', () => {
  grabStartY = null;
});

// Keyboard activation sends click with detail 0. Pointer clicks are handled on pointerup.
el.grabber.addEventListener('click', (e) => {
  if (e.detail === 0) setSheet(!el.panel.classList.contains('collapsed'));
});

/* --------------------------------------------------------------------------
   Photo loading
   -------------------------------------------------------------------------- */

function downscale(img, maxSide) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('That file is not an image. Use a JPG, PNG, or WebP photo.', true);
    return;
  }

  setStatus('Reading photo');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    setStatus('Could not open that photo. Try a JPG or PNG file.', true);
    return;
  }

  const photo = downscale(img, 1024);
  state.img = img;
  state.photo = photo;
  state.depth = null;
  state.origLight = estimateLight(photo);
  state.lampSpots = findLamps(photo, 4);
  state.lamps = [];
  state.selected = null;
  state.manualSun = false;
  state.showDepth = false;

  el.view.width = photo.width;
  el.view.height = photo.height;

  applyTime(state.hour);
  body.classList.add('has-photo');
  renderMarkers();
  syncControls();
  scheduleBackdrop();
  requestRender();

  // Depth runs in the background. The flat-light fallback shows until it is ready.
  const job = ++depthJob;
  setStatus('Reading depth');
  try {
    const depth = await getDepth(img, {
      onProgress: (p) => {
        if (job === depthJob && p < 100) setStatus(`Loading the depth model ${p}%`);
      },
    });
    if (job !== depthJob) return;
    state.depth = depth;
    setStatus('Ready. Drag the sun.');
  } catch (err) {
    console.error(err);
    if (job === depthJob) {
      state.depth = null;
      setStatus('Depth failed. Using a flat light model. Try another photo or reload the page.', true);
    }
  } finally {
    URL.revokeObjectURL(url);
    requestRender();
  }
}

el.choose.addEventListener('click', () => el.file.click());
el.newPhoto.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  const f = el.file.files && el.file.files[0];
  el.file.value = '';
  if (f) loadFile(f);
});

/* --------------------------------------------------------------------------
   Drag and drop anywhere on the page
   -------------------------------------------------------------------------- */

let dragDepth = 0;

function hasFiles(e) {
  return Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  body.classList.add('dragging');
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) body.classList.remove('dragging');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  body.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

window.addEventListener('resize', moveThumb);

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */

function init() {
  try {
    initRelight(glCanvas);
  } catch (err) {
    console.error(err);
    setStatus('WebGL is off. Turn on hardware acceleration or open Chrome, Edge, Safari, or Firefox.', true);
  }

  applyTime(state.hour);
  syncControls();

  setStatus('Preparing the depth model');
  warmUp((p) => {
    if (p < 100) setStatus(`Loading the depth model ${p}%`);
  })
    .then(() => {
      if (!state.photo) setStatus('Model ready. Add a room photo to begin.');
    })
    .catch((err) => {
      console.error(err);
      setStatus('The depth model did not load. Check your connection and reload. Photos will use a flat light model.', true);
    });
}

init();
