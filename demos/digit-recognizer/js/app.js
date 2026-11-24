// app.js — wires the drawing pad, the from-scratch network (engine/ is a
// byte-identical copy of the project's src/) and the visualisations together.
import { fetchModel } from '../engine/serialize.js';
import { preprocessInk } from '../engine/preprocess.js';
import { parseIDX } from '../engine/idx.js';
import { DrawingPad } from './pad.js';
import { NetViz } from './netviz.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = { net: null, viz: null, samples: null, sampleIdx: -1, timer: 0 };

// ------------------------------------------------------------------ U3 bars
const bars = $('bars');
for (let d = 0; d < 10; d++) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="d">${d}</span><span class="track"><span class="fill"></span></span><span class="p">–</span>`;
  bars.appendChild(li);
}

// ------------------------------------------------------------------ U2 "what the network sees"
const seen = $('seen');
const seenCtx = seen.getContext('2d');

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawSeen(input) {
  state.lastInput = input; // kept so a theme change can repaint the grid
  const W = seen.width, cell = W / 28;
  seenCtx.clearRect(0, 0, W, W);
  const off = cssVar('--surface-2'), led = cssVar('--led');
  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < 28; x++) {
      const v = input ? input[y * 28 + x] : 0;
      seenCtx.globalAlpha = 1;
      seenCtx.fillStyle = off;
      seenCtx.fillRect(x * cell + 0.75, y * cell + 0.75, cell - 1.5, cell - 1.5);
      if (v > 0.01) {
        seenCtx.globalAlpha = Math.min(1, v);
        seenCtx.fillStyle = led;
        seenCtx.fillRect(x * cell + 0.75, y * cell + 0.75, cell - 1.5, cell - 1.5);
      }
    }
  }
  // centre crosshair: MNIST digits are centred by centre of mass at (14, 14)
  seenCtx.globalAlpha = 0.55;
  seenCtx.strokeStyle = cssVar('--copper');
  seenCtx.setLineDash([3, 4]);
  seenCtx.lineWidth = 1;
  seenCtx.beginPath();
  seenCtx.moveTo(14 * cell, 0); seenCtx.lineTo(14 * cell, W);
  seenCtx.moveTo(0, 14 * cell); seenCtx.lineTo(W, 14 * cell);
  seenCtx.stroke();
  seenCtx.setLineDash([]);
  seenCtx.globalAlpha = 1;
}

// ------------------------------------------------------------------ prediction
function showResult(probs) {
  const items = bars.children;
  let top = -1;
  if (probs) top = probs.indexOf(Math.max(...probs));
  for (let d = 0; d < 10; d++) {
    const li = items[d];
    const p = probs ? probs[d] : 0;
    li.classList.toggle('top', d === top);
    li.querySelector('.fill').style.width = `${(100 * p).toFixed(1)}%`;
    li.querySelector('.p').textContent = probs ? `${(100 * p).toFixed(p >= 0.9995 ? 0 : 1)}%` : '–';
  }
  const pred = $('pred');
  pred.textContent = probs ? String(top) : '–';
  pred.classList.toggle('idle', !probs);
  $('conf').textContent = probs ? `${(100 * probs[top]).toFixed(1)}% confident` : 'waiting for input';
}

function run(input) {
  if (!state.net) return;
  if (!input) {
    drawSeen(null);
    showResult(null);
    state.viz.update(null);
    return;
  }
  const trace = state.net.trace(input);
  drawSeen(input);
  showResult(Array.from(trace.probs));
  state.viz.update(trace, input);
}

const NOTE_DRAWN = 'Cropped, stroke width matched, scaled to 20 px and centred by centre of mass: the recipe used to build MNIST.';
const NOTE_SAMPLE = 'A real MNIST test digit: already 28×28 and centred, so it goes into the network as is.';

function predictFromPad() {
  $('seen-note').textContent = NOTE_DRAWN;
  clearTimeout(state.timer);
  state.timer = 0;
  if (pad.isEmpty) { run(null); return; }
  const res = preprocessInk(pad.getInk(), pad.canvas.width, pad.canvas.height);
  run(res ? res.input : null);
}

// Live prediction while drawing, throttled to ~12 updates per second.
function schedule(immediate) {
  if (immediate) { predictFromPad(); return; }
  if (!state.timer) state.timer = setTimeout(predictFromPad, 80);
}

// ------------------------------------------------------------------ pad
const pad = new DrawingPad($('pad'), {
  lineWidth: 28,
  onChange(kind) {
    if (kind === 'start') $('sample-info').textContent = '';
    updateButtons();
    schedule(kind !== 'draw');
  },
});

function updateButtons() {
  const empty = pad.isEmpty && !pad.image;
  $('undo-btn').disabled = empty;
  $('clear-btn').disabled = empty;
  $('pad-hint').classList.toggle('hidden', !empty);
}

$('undo-btn').addEventListener('click', () => pad.undo());
$('clear-btn').addEventListener('click', () => { pad.clear(); $('sample-info').textContent = ''; });

// ------------------------------------------------------------------ test samples
function showSample(i) {
  const s = state.samples;
  if (!s) return;
  state.sampleIdx = ((i % s.count) + s.count) % s.count;
  const k = state.sampleIdx;
  const px = s.images.subarray(k * 784, k * 784 + 784);
  pad.showImage(px);
  updateButtons();
  // MNIST samples are already in network format: no preprocessing needed.
  $('seen-note').textContent = NOTE_SAMPLE;
  const input = Float32Array.from(px, (v) => v / 255);
  run(input);
  const meta = s.list[k];
  const probs = state.net.predict(input, 1);
  const pred = probs.indexOf(Math.max(...probs));
  const ok = pred === meta.label;
  $('sample-info').innerHTML = `MNIST test #${meta.testIndex} · label <b>${meta.label}</b> · `
    + (ok ? '<span class="ok">✓ correct</span>' : `<span class="bad">✗ network says ${pred}</span>`)
    + ` · sample ${k + 1}/${s.count}`;
}

$('sample-btn').addEventListener('click', () => showSample(state.sampleIdx + 1));

// ------------------------------------------------------------------ theme
function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function rerender() {
  pad.render();
  state.viz?.readColors();
  if (state.lastInput !== undefined) drawSeen(state.lastInput);
}
$('theme-btn').addEventListener('click', () => {
  document.documentElement.dataset.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  rerender();
  predictOrSample();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { rerender(); predictOrSample(); });

function predictOrSample() {
  if (pad.image && state.sampleIdx >= 0) showSample(state.sampleIdx);
  else predictFromPad();
}

// ------------------------------------------------------------------ boot
async function boot() {
  drawSeen(null);
  showResult(null);
  try {
    const [{ net, manifest, bytes }, imgBuf, lblBuf, list] = await Promise.all([
      fetchModel('model/model.json'),
      fetch('model/samples-images.idx').then((r) => r.arrayBuffer()),
      fetch('model/samples-labels.idx').then((r) => r.arrayBuffer()),
      fetch('model/samples.json').then((r) => r.json()),
    ]);
    state.net = net;
    const imgs = parseIDX(imgBuf), labels = parseIDX(lblBuf);
    state.samples = { images: imgs.data, labels: labels.data, count: imgs.dims[0], list };
    state.viz = new NetViz($('net'), net);
    const m = manifest.meta;
    $('s-acc').textContent = `${m.testAccuracyInt8.toFixed(2)}%`;
    $('s-params').textContent = manifest.params.toLocaleString('en-US');
    $('s-size').textContent = `${(bytes / 1024).toFixed(0)} KB int8`;
    $('arch-chip').textContent = `MLP ${m.architecture}`;
    $('net-arch').textContent = m.architecture.replaceAll('-', ' → ');
    // Inference time per digit: warm up the JIT, then average 200 forward
    // passes on a real sample (browser timers are coarse, ~0.1 ms, so one
    // call cannot be timed on its own).
    const probe = Float32Array.from(state.samples.images.subarray(0, 784), (v) => v / 255);
    for (let i = 0; i < 50; i++) net.predict(probe, 1);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) net.predict(probe, 1);
    const ms = (performance.now() - t0) / 200;
    $('s-ms').textContent = ms > 0 ? `${ms.toFixed(2)} ms / digit` : `${m.inferenceMs.toFixed(2)} ms / digit (Node)`;

    const q = params.get('sample');
    if (q !== null && /^\d+$/.test(q)) showSample(+q);
    else state.viz.update(null);
  } catch (err) {
    console.error(err);
    $('sample-info').textContent = `Could not load the model (${err.message}). Serve this folder over HTTP.`;
  }
}

boot();
