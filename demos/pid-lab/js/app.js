/**
 * app.js - PID Control Lab UI.
 *
 * The engine (../engine, byte-identical to the project's src/) does all the maths. This file
 * only wires it to the page:
 *   - a fixed-step accumulator inside requestAnimationFrame advances the closed loop in whole
 *     controller samples, so the simulation is deterministic and frame-rate independent
 *     (speed just changes how many samples run per frame);
 *   - scrolling canvas plots, an animated plant, live step metrics;
 *   - relay autotune (runs live, sample by sample), Nelder-Mead optimiser (runs in small
 *     time slices per frame), and a Compare view that overlays offline step responses.
 *
 * URL parameters: plant, kp, ki, kd, n, autoplay=1, compare=1, theme=light|dark,
 *                 prerun=<seconds>, speed=0|1|5|20, noise=1, terms=0, autotune=1
 */
import {
  PLANTS, PLANT_IDS, ClosedLoop, simulate, pidOptionsFor, stepMetrics, fmtMetric,
  RelayExperiment, gainsFromRule, TUNING_RULES, optimiseIter, tuningCost,
} from '../engine/index.js';
import { Plot } from './plot.js';
import { drawPlant } from './visuals.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const num = (k) => (qs.has(k) && qs.get(k) !== '' && Number.isFinite(+qs.get(k)) ? +qs.get(k) : undefined);

const RUN_COLORS = ['led', 'copper', 'signal'];
const SPEEDS = [0, 1, 5, 20];
const HIST_EXTRA = 1.25;

/* ------------------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------------- */
const S = {
  id: PLANTS[qs.get('plant')] ? qs.get('plant') : 'drone',
  def: null,
  loop: null,
  set: { Kp: 0, Ki: 0, Kd: 0, N: 10, uMin: 0, uMax: 1, aw: 'clamp', dom: true, noise: qs.get('noise') === '1', terms: qs.get('terms') !== '0', auto: qs.get('autoplay') === '1' },
  sp: 0, dist: false, speed: 1, view: qs.get('compare') === '1' ? 'compare' : 'live',
  hist: null, step: null, phi: 0, acc: 0,
  relay: null, relayStart: 0, tune: null, rule: 'zn-pid',
  opt: null,
  runs: [],
  pal: {},
  frame: 0,
};

/* ------------------------------------------------------------------------------------
 * Theme palette (read from CSS tokens so canvases follow light/dark)
 * ---------------------------------------------------------------------------------- */
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(`--${n}`).trim();
  S.pal = {
    bg: v('bg'), surface: v('surface'), surface2: v('surface-2'), border: v('border'), borderStrong: v('border-strong'),
    text: v('text'), muted: v('muted'), faint: v('faint'), copper: v('copper'), copperBright: v('copper-bright'),
    led: v('led'), signal: v('signal'), warn: v('warn'), danger: v('danger'), grid: v('grid'),
  };
}
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', readPalette);

/* ------------------------------------------------------------------------------------
 * Formatting helpers
 * ---------------------------------------------------------------------------------- */
function fmtGain(v) {
  if (v === 0) return '0';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return String(Number(v.toPrecision(3)));
}
function yDigits(def) {
  const span = def.spRange[1] - def.spRange[0];
  return span >= 50 ? 1 : span >= 10 ? 2 : 3;
}
const fmtY = (v) => (Number.isFinite(v) ? v.toFixed(yDigits(S.def)) : '—');
const fmtU = (v) => (Number.isFinite(v) ? v.toFixed(Math.abs(S.def.uMax) <= 1 ? 3 : Math.abs(S.def.uMax) >= 50 ? 1 : 2) : '—');
function fmtTime(t) {
  if (t < 60) return `${t.toFixed(2)} s`;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(0).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------------------
 * Simulation setup
 * ---------------------------------------------------------------------------------- */
function pidOptions() {
  const s = S.set;
  return { Kp: s.Kp, Ki: s.Ki, Kd: s.Kd, N: s.N, uMin: s.uMin, uMax: s.uMax, antiWindup: s.aw, derivativeOnMeasurement: s.dom };
}
function noiseOptions() {
  return S.set.noise ? { std: S.def.noiseStd, seed: 1 } : { std: 0, seed: 1 };
}

function newHistory() {
  const cap = Math.ceil(S.def.window / S.def.Ts) + 2;
  return { cap, t: [], sp: [], y: [], yTrue: [], u: [], P: [], I: [], D: [], sat: [] };
}
function newStepLog(y0, r) {
  return { y0, r, t0: S.loop ? S.loop.t : 0, t: [], sp: [], y: [], u: [] };
}

function resetSim() {
  const def = S.def;
  cancelRelay(false);
  S.opt = null;
  S.loop = new ClosedLoop({ plant: def, pid: pidOptions(), noise: noiseOptions(), quant: S.set.noise ? def.quant : 0 });
  S.dist = false;
  S.sp = def.step[1];
  S.loop.setpoint = S.sp;
  S.loop.disturbance = 0;
  S.hist = newHistory();
  S.step = newStepLog(S.loop.plant.y, S.sp);
  S.phi = 0; S.acc = 0;
  plots.y.resetScale(); plots.pid.resetScale();
  syncButtons();
  syncSetpointUI();
}

function loadPlant(id, gains) {
  S.id = id;
  S.def = PLANTS[id];
  const d = S.def;
  S.set = { ...S.set, ...d.defaultGains, ...gains, uMin: d.uMin, uMax: d.uMax };
  S.speed = num('speed') !== undefined && !loadPlant.done ? num('speed') : id === 'heater' ? 20 : 1;
  loadPlant.done = true;
  buildTrimmers();
  $('plant-title').textContent = d.name;
  $('plant-desc').innerHTML = '';
  $('plant-desc').append(d.description);
  const eq = document.createElement('span');
  eq.className = 'eq';
  eq.innerHTML = d.equations.map((e) => e.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
  $('plant-desc').append(eq);
  $('y-title').textContent = `${d.labels.y} [${d.units.y}]`;
  $('u-title').textContent = `${d.labels.u} u [${d.units.u}]`;
  $('cy-title').textContent = `Step ${d.step[0]} → ${d.step[1]} ${d.units.y}`;
  const ms = (v) => (v < 0.1 ? `${+(v * 1000).toFixed(2)} ms` : `${v} s`);
  $('ts-label').textContent = `Ts ${ms(d.Ts)} · h ${ms(d.h)}`;
  $('ts-label').title = 'Controller sample time Ts and RK4 integration step h';
  $('umin').value = d.uMin; $('umax').value = d.uMax;
  $('btn-dist').title = d.disturbance.label;
  document.querySelectorAll('#plant-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.plant === id)));
  syncSpeed();
  syncOptions();
  resetSim();
  S.runs = [];
  if (S.view === 'compare') loadPresetRuns();
  renderCompare();
  const u = new URL(location.href);
  u.searchParams.set('plant', id);
  if (!gains) for (const k of ['kp', 'ki', 'kd', 'n']) u.searchParams.delete(k);
  history.replaceState(null, '', u);
}

/* ------------------------------------------------------------------------------------
 * One controller sample (everything that changes the sim goes through here)
 * ---------------------------------------------------------------------------------- */
function autoEvents(t) {
  // Unattended demo: cycle the setpoint through three levels and pulse a disturbance.
  const d = S.def, period = d.duration;
  const n = Math.floor(t / period + 1e-9), ph = t / period - n;
  const s0 = d.step[0], s1 = d.step[1];
  const seq = [s1, s0 + (s1 - s0) * 0.4, s0 + (s1 - s0) * 1.4];
  const sp = seq[n % 3];
  if (Math.abs(sp - S.sp) > 1e-12) setSetpoint(sp, true);
  const dist = ph >= 0.55 && ph < 0.8;
  if (dist !== S.dist) setDisturbance(dist);
}

function simTick() {
  const loop = S.loop;
  if (S.set.auto && !S.relay) autoEvents(loop.t);
  const s = loop.tick();
  if (S.def.id === 'motor-speed') S.phi += s.yTrue * loop.Ts * 0.05;
  const h = S.hist;
  const sat = !S.relay && (s.u >= S.set.uMax - 1e-9 || s.u <= S.set.uMin + 1e-9) ? 1 : 0;
  h.t.push(s.t); h.sp.push(s.sp); h.y.push(s.y); h.yTrue.push(s.yTrue); h.u.push(s.u);
  h.P.push(s.P); h.I.push(s.I); h.D.push(s.D); h.sat.push(sat);
  if (h.t.length > h.cap * HIST_EXTRA) {
    const cut = h.t.length - h.cap;
    for (const k of ['t', 'sp', 'y', 'yTrue', 'u', 'P', 'I', 'D', 'sat']) h[k].splice(0, cut);
  }
  const st = S.step;
  if (st.t.length < 60000) { st.t.push(s.t); st.sp.push(s.sp); st.y.push(s.yTrue); st.u.push(s.u); }
  if (S.relay) {
    if (S.relay.done) finishRelay();
    else if (loop.t - S.relayStart > S.def.duration * 10) cancelRelay(true);
  }
}

function setSetpoint(v, fromAuto = false) {
  const [lo, hi] = S.def.spRange;
  v = Math.min(hi, Math.max(lo, v));
  if (Math.abs(v - S.sp) < 1e-12) return;
  if (!fromAuto && S.set.auto) { S.set.auto = false; $('opt-auto').checked = false; }
  S.sp = v;
  S.loop.setpoint = v;
  S.step = newStepLog(S.loop.plant.y, v);
  syncSetpointUI();
}

function setDisturbance(on) {
  S.dist = on;
  S.loop.disturbance = on ? S.def.disturbance.value : 0;
  syncButtons();
}

function lastRY() {
  const h = S.hist;
  const n = h.t.length;
  return n ? [h.sp[n - 1], h.y[n - 1]] : [undefined, undefined];
}

/** Apply gains to the running controller without a bump in u. */
function applyGains(g, bumpless = true) {
  const [r, y] = bumpless ? lastRY() : [undefined, undefined];
  S.set.Kp = g.Kp; S.set.Ki = g.Ki; S.set.Kd = g.Kd;
  S.loop.pid.setGains({ Kp: g.Kp, Ki: g.Ki, Kd: g.Kd }, r, y);
  for (const k of ['Kp', 'Ki', 'Kd']) trimmers[k]?.set(g[k]);
}

function applyOptions() {
  const s = S.set;
  S.loop.pid.configure({ N: s.N, uMin: s.uMin, uMax: s.uMax, antiWindup: s.aw, derivativeOnMeasurement: s.dom });
  S.loop.noise.std = s.noise ? S.def.noiseStd : 0;
  S.loop.quant = s.noise ? S.def.quant : 0;
}

/* ------------------------------------------------------------------------------------
 * Relay autotune, live
 * ---------------------------------------------------------------------------------- */
function startRelay() {
  const d = S.def;
  if (S.opt) return;
  const noiseEps = S.set.noise ? 2.5 * d.noiseStd + (d.quant || 0) : 0;
  S.relay = new RelayExperiment({
    h: d.relay.h, eps: noiseEps, bias: d.equilibriumU(S.sp, S.loop.plant.p),
    uMin: S.set.uMin, uMax: S.set.uMax, cycles: 8, measure: 4,
  });
  if (S.set.auto) { S.set.auto = false; $('opt-auto').checked = false; }
  S.relayStart = S.loop.t;
  S.loop.controller = (r, y, t) => S.relay.step(r, y, t);
  S.step = newStepLog(S.loop.plant.y, S.sp);
  status(`<b>Relay test</b> - u switches ${fmtU(d.relay.h)} ${d.units.u} around the operating point; waiting for a steady limit cycle…`);
  syncButtons();
}

function cancelRelay(failed) {
  if (!S.relay) return;
  S.relay = null;
  if (S.loop) { S.loop.controller = null; S.loop.pid.reset(); }
  if (failed) status('Relay test stopped: no steady oscillation within the time limit.');
  syncButtons();
}

function finishRelay() {
  const res = S.relay.result();
  S.relay = null;
  S.loop.controller = null;
  if (!res) { status('Relay test failed.'); syncButtons(); return; }
  S.tune = res;
  const g = gainsFromRule(res.Ku, res.Tu, S.rule);
  applyGains(g, false);
  S.loop.pid.reset(res.bias);     // start the integrator at the relay's operating point
  S.step = newStepLog(S.loop.plant.y, S.sp);
  renderTuneStatus();
  syncButtons();
}

function renderTuneStatus() {
  const res = S.tune, d = S.def;
  const g = gainsFromRule(res.Ku, res.Tu, S.rule);
  const opts = Object.entries(TUNING_RULES)
    .map(([k, r]) => `<option value="${k}"${k === S.rule ? ' selected' : ''}>${r.name}</option>`).join('');
  status(`Ku <b>${fmtGain(res.Ku)}</b> ${d.units.u}/${d.units.y} · Tu <b>${fmtGain(res.Tu)} s</b> (a = ${fmtGain(res.a)} ${d.units.y})` +
    `<div class="row"><select id="rule-select" aria-label="Tuning rule">${opts}</select>` +
    `<span>Kp ${fmtGain(g.Kp)} · Ki ${fmtGain(g.Ki)} · Kd ${fmtGain(g.Kd)}</span></div>`);
  $('rule-select').addEventListener('change', (e) => {
    S.rule = e.target.value;
    applyGains(gainsFromRule(res.Ku, res.Tu, S.rule));
    renderTuneStatus();
  });
}

/* ------------------------------------------------------------------------------------
 * Optimiser, time-sliced across frames
 * ---------------------------------------------------------------------------------- */
function startOptimise() {
  if (S.relay || S.opt) return;
  const start = { Kp: S.set.Kp, Ki: S.set.Ki, Kd: S.set.Kd };
  let mask = ['Kp', 'Ki', 'Kd'].filter((k) => start[k] > 0);
  if (!mask.length) { start.Kp = S.def.defaultGains.Kp; mask = ['Kp']; }
  const o = { pid: { N: S.set.N, uMin: S.set.uMin, uMax: S.set.uMax, antiWindup: S.set.aw, derivativeOnMeasurement: S.set.dom }, mask, maxEvals: 150 };
  S.opt = { it: optimiseIter(S.def, start, o), J0: tuningCost(S.def, start, o).J, last: null, mask };
  status(`<b>Optimising</b> ${mask.join(', ')} - Nelder-Mead on log-gains, cost = ITAE + overshoot + saturation + chatter…`);
  syncButtons();
}

function stepOptimiser() {
  if (!S.opt) return;
  const t0 = performance.now();
  while (performance.now() - t0 < 10) {
    const r = S.opt.it.next();
    if (r.done) {
      const v = r.value;
      const { J0 } = S.opt;
      S.opt = null;
      if (v.J < J0) {
        applyGains(v.gains);
        status(`Cost <b>${fmtGain(J0)} → ${fmtGain(v.J)}</b> after ${v.evals} simulations. ` +
          `Overshoot ${fmtMetric(v.m.overshoot, 2)} %, settling ${fmtMetric(v.m.settle)} s.`);
        if (S.view === 'compare') addRun('Optimised');
      } else {
        status(`Already near the optimum (cost ${fmtGain(J0)}); gains unchanged.`);
      }
      syncButtons();
      return;
    }
    S.opt.last = r.value;
  }
  const l = S.opt.last;
  if (l) status(`<b>Optimising…</b> ${l.evals}/150 sims · cost ${fmtGain(l.J)} (start ${fmtGain(S.opt.J0)})<br>Kp ${fmtGain(l.gains.Kp)} · Ki ${fmtGain(l.gains.Ki)} · Kd ${fmtGain(l.gains.Kd)}`);
}

/* ------------------------------------------------------------------------------------
 * Compare view
 * ---------------------------------------------------------------------------------- */
function runFor(name, gains) {
  const d = S.def;
  const pid = pidOptionsFor(d, { ...pidOptions(), ...gains });
  const s = simulate({ plant: d, pid, setpoint: [{ t: 0, value: d.step[1] }], duration: d.duration, noise: noiseOptions(), quant: S.set.noise ? d.quant : 0 });
  const m = stepMetrics(s, { yKey: 'yTrue', y0: d.step[0] });
  return { name, gains: { Kp: gains.Kp, Ki: gains.Ki, Kd: gains.Kd }, s, m };
}
function loadPresetRuns() {
  S.runs = Object.entries(S.def.presets).map(([name, g]) => runFor(name, g));
  renderCompare();
}
function addRun(name) {
  if (S.runs.length >= 3) S.runs.shift();
  S.runs.push(runFor(name ?? `Run ${S.runs.length + 1}`, S.set));
  renderCompare();
}

function renderCompare() {
  const tbl = $('compare-table');
  $('compare-empty').hidden = S.runs.length > 0;
  tbl.hidden = S.runs.length === 0;
  const d = S.def;
  const head = ['Run', 'Kp', 'Ki', 'Kd', 'Rise', 'Overshoot', 'Settling', 'SSE', 'ITAE', 'Sat.'];
  tbl.innerHTML = `<thead><tr>${head.map((h) => `<th class="silk">${h}</th>`).join('')}</tr></thead><tbody>` +
    S.runs.map((r, i) => `<tr><td><span class="swatch" style="background:var(--${RUN_COLORS[i]})"></span>${r.name}</td>` +
      `<td>${fmtGain(r.gains.Kp)}</td><td>${fmtGain(r.gains.Ki)}</td><td>${fmtGain(r.gains.Kd)}</td>` +
      `<td>${fmtMetric(r.m.rise)} s</td><td>${fmtMetric(r.m.overshoot, 2)} %</td><td>${fmtMetric(r.m.settle)} s</td>` +
      `<td>${fmtMetric(r.m.sse, 2)} ${d.units.y}</td><td>${fmtMetric(r.m.itae)}</td><td>${fmtMetric(r.m.satPct, 2)} %</td></tr>`).join('') +
    '</tbody>';
  S.compareDirty = true;
}

function drawCompare() {
  const d = S.def, pal = S.pal;
  const T = d.duration;
  let lo = Math.min(d.step[0], d.step[1]), hi = Math.max(d.step[0], d.step[1]);
  let ulo = S.set.uMin, uhi = S.set.uMax;
  for (const r of S.runs) {
    for (let i = 0; i < r.s.n; i++) {
      const y = r.s.yTrue[i];
      if (y < lo) lo = y; if (y > hi) hi = y;
      const u = r.s.u[i];
      if (u < ulo) ulo = u; if (u > uhi) uhi = u;
    }
  }
  const pad = (hi - lo) * 0.08 || 1, upad = (uhi - ulo) * 0.08 || 1;
  const spSeries = { x: [0, T], y: [d.step[1], d.step[1]], color: pal.muted, dash: [5, 4], width: 1.2 };
  cplots.y.draw({
    x0: 0, x1: T, y: [lo - pad, hi + pad], pal,
    series: [spSeries, ...S.runs.map((r, i) => ({ x: r.s.t, y: r.s.yTrue, color: pal[RUN_COLORS[i]], width: 2 }))],
  });
  cplots.u.draw({
    x0: 0, x1: T, y: [ulo - upad, uhi + upad], pal,
    hlines: [{ y: S.set.uMax, color: pal.warn, label: 'MAX', below: true }, { y: S.set.uMin, color: pal.warn, label: 'MIN' }],
    series: S.runs.map((r, i) => ({ x: r.s.t, y: r.s.u, color: pal[RUN_COLORS[i]], width: 1.5 })),
  });
}

/* ------------------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------------- */
const plantCanvas = $('plant-canvas');
const plantCtx = plantCanvas.getContext('2d');
let plantSize = { w: 300, h: 220 };
function resizePlantCanvas() {
  const r = plantCanvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, r.width), h = Math.max(10, r.height);
  if (w === plantSize.w && h === plantSize.h && plantCanvas.width === Math.round(w * dpr)) return;
  plantSize = { w, h };
  plantCanvas.width = Math.round(w * dpr); plantCanvas.height = Math.round(h * dpr);
  plantCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.loop) render();           // resizing cleared the bitmap: repaint now, even when paused
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizePlantCanvas).observe(plantCanvas);

const plots = { y: new Plot($('plot-y')), u: new Plot($('plot-u')), pid: new Plot($('plot-pid')) };
const cplots = { y: new Plot($('cplot-y')), u: new Plot($('cplot-u')) };
for (const p of [...Object.values(plots), ...Object.values(cplots)]) p.onResize = () => { if (S.loop) render(); };

function visibleRange(h, x0) {
  // first index with t >= x0 (history is sorted)
  let lo = 0, hi = h.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (h.t[m] < x0) lo = m + 1; else hi = m; }
  return Math.max(0, lo - 1);
}

function drawLive() {
  const h = S.hist, d = S.def, pal = S.pal;
  const tNow = S.loop.t;
  const x1 = Math.max(d.window, tNow), x0 = x1 - d.window;
  const from = visibleRange(h, x0), to = h.t.length;

  let lo = Infinity, hi = -Infinity;
  for (let i = from; i < to; i++) {
    const a = h.y[i], b = h.sp[i];
    if (a < lo) lo = a; if (a > hi) hi = a; if (b < lo) lo = b; if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo)) { lo = d.step[0]; hi = d.step[1]; }
  const span = d.spRange[1] - d.spRange[0];
  const yr = plots.y.scale(lo, hi, span * 0.08);
  const band = Math.abs(S.step.r - S.step.y0) * 0.02;
  plots.y.draw({
    x0, x1, y: yr, pal,
    bands: band > 0 && !S.relay ? [{ y0: S.sp - band, y1: S.sp + band, x0: S.step.t0, color: hexA(pal.signal, 0.12) }] : [],
    series: [
      { x: h.t, y: h.sp, from, to, color: pal.signal, dash: [6, 4], width: 1.4, step: true },
      { x: h.t, y: h.y, from, to, color: pal.led, width: 1.8 },
    ],
  });

  let ulo = S.set.uMin, uhi = S.set.uMax;
  for (let i = from; i < to; i++) { const u = h.u[i]; if (u < ulo) ulo = u; if (u > uhi) uhi = u; }
  const up = (uhi - ulo) * 0.1 || 1;
  plots.u.draw({
    x0, x1, y: [ulo - up, uhi + up], pal,
    bands: [{ y0: S.set.uMax, y1: uhi + up, color: hexA(pal.warn, 0.08) }, { y0: ulo - up, y1: S.set.uMin, color: hexA(pal.warn, 0.08) }],
    hlines: [{ y: S.set.uMax, color: pal.warn, label: `MAX ${fmtGain(S.set.uMax)}`, below: true }, { y: S.set.uMin, color: pal.warn, label: `MIN ${fmtGain(S.set.uMin)}` }],
    series: [{ x: h.t, y: h.u, from, to, color: pal.copper, width: 1.6, satMask: h.sat, satColor: pal.warn }],
  });

  if (S.set.terms) {
    let plo = Infinity, phi = -Infinity;
    for (let i = from; i < to; i++) for (const k of ['P', 'I', 'D']) { const v = h[k][i]; if (v < plo) plo = v; if (v > phi) phi = v; }
    if (!Number.isFinite(plo)) { plo = -1; phi = 1; }
    const pr = plots.pid.scale(plo, phi, (S.set.uMax - S.set.uMin) * 0.05);
    plots.pid.draw({
      x0, x1, y: pr, pal,
      hlines: [{ y: 0, color: pal.borderStrong, dash: [2, 3] }],
      series: [
        { x: h.t, y: h.P, from, to, color: pal.copperBright, width: 1.4 },
        { x: h.t, y: h.I, from, to, color: pal.signal, width: 1.4 },
        { x: h.t, y: h.D, from, to, color: pal.danger, width: 1.2, alpha: 0.9 },
      ],
    });
  }

  const banner = $('banner');
  if (S.relay) {
    const cyc = Math.max(0, S.relay.ups.length - 1);
    banner.hidden = false;
    banner.textContent = `RELAY TEST · cycle ${Math.min(cyc, 8)}/8 · u = bias ± ${fmtGain(S.def.relay.h)} ${S.def.units.u}`;
  } else if (S.opt) {
    banner.hidden = false;
    banner.textContent = `OPTIMISING · ${S.opt.last?.evals ?? 0}/150`;
  } else banner.hidden = true;
}

function hexA(color, a) {
  // accepts #rrggbb; anything else returned unchanged
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawMetrics() {
  const st = S.step;
  if (st.t.length < 3 || S.relay) {
    for (const id of ['m-rise', 'm-os', 'm-settle', 'm-sse', 'm-itae', 'm-sat']) $(id).querySelector('.v').textContent = '—';
    $('metric-since').textContent = S.relay ? 'relay test' : '';
    return;
  }
  const m = stepMetrics(st, { y0: st.y0, r: st.r, uMin: S.set.uMin, uMax: S.set.uMax });
  const u = S.def.units.y;
  // Rise/overshoot/settling are only meaningful for a real step (> 1 % of the range).
  const isStep = Math.abs(m.amplitude) > 0.01 * (S.def.spRange[1] - S.def.spRange[0]);
  if (!isStep) { m.rise = NaN; m.overshoot = NaN; m.settle = NaN; }
  const put = (id, v, unit, bad) => {
    const el = $(id);
    el.querySelector('.v').innerHTML = `${v}${unit ? `<small>${unit}</small>` : ''}`;
    el.classList.toggle('bad', !!bad);
  };
  put('m-rise', fmtMetric(m.rise), Number.isFinite(m.rise) ? 's' : '');
  put('m-os', fmtMetric(m.overshoot, 2), isStep ? '%' : '', m.overshoot > 20);
  put('m-settle', m.settle === Infinity ? '…' : fmtMetric(m.settle), Number.isFinite(m.settle) ? 's' : '');
  put('m-sse', fmtMetric(m.sse, 2), u, Math.abs(m.sse) > 0.05 * Math.abs(m.amplitude || 1));
  put('m-itae', fmtMetric(m.itae), '');
  put('m-sat', fmtMetric(m.satPct, 2), '%', m.satPct > 30);
  $('metric-since').textContent = `step @ ${fmtTime(st.t0)}`;
}

function render() {
  const d = S.def, loop = S.loop;
  const h = S.hist, n = h.t.length;
  const y = n ? h.yTrue[n - 1] : loop.plant.y;
  const u = n ? h.u[n - 1] : 0;
  drawPlant(plantCtx, plantSize.w, plantSize.h, { def: d, x: loop.plant.x, y, sp: S.sp, u, d: S.dist, phi: S.phi, t: loop.t }, S.pal);
  $('ro-sp').innerHTML = `${fmtY(S.sp)} <span class="u">${d.units.y}</span>`;
  $('ro-pv').innerHTML = `${fmtY(n ? h.y[n - 1] : y)} <span class="u">${d.units.y}</span>`;
  $('ro-u').innerHTML = `${fmtU(u)} <span class="u">${d.units.u}</span>`;
  $('ro-t').textContent = fmtTime(loop.t);
  const rs = $('run-state');
  rs.innerHTML = S.relay ? '<span class="led warn"></span>Relay' : S.speed === 0 ? '<span class="led"></span>Paused' : '<span class="led on"></span>PID';
  if (S.view === 'live') drawLive();
  else if (S.compareDirty || cplots.y.dirty || cplots.u.dirty) { drawCompare(); S.compareDirty = false; }
  if (S.frame % 3 === 0) drawMetrics();
  S.frame++;
}

/* ------------------------------------------------------------------------------------
 * Controls
 * ---------------------------------------------------------------------------------- */
const trimmers = {};

/** Log-scale trimmer: slider position 0 = exactly 0 (when allowed), 1..1000 = log range. */
function makeTrimmer(key, labelText, sub, [lo, hi], allowZero, onChange) {
  const row = document.createElement('div');
  row.className = 'trim';
  const id = `trim-${key}`;
  row.innerHTML = `<label for="${id}">${labelText}<small>${sub}</small></label>` +
    `<input type="range" id="${id}" min="0" max="1000" step="1" aria-label="${labelText} (log scale)">` +
    `<input type="number" step="any" min="0" aria-label="${labelText} value">`;
  const range = row.querySelector('input[type=range]');
  const box = row.querySelector('input[type=number]');
  const toVal = (p) => {
    if (allowZero && p <= 0) return 0;
    const f = allowZero ? (p - 1) / 999 : p / 1000;
    return lo * (hi / lo) ** f;
  };
  const toPos = (v) => {
    if (allowZero && v <= 0) return 0;
    const f = Math.log(Math.min(hi, Math.max(lo, v)) / lo) / Math.log(hi / lo);
    return allowZero ? 1 + Math.round(f * 999) : Math.round(f * 1000);
  };
  const fill = () => range.style.setProperty('--fill', `${range.value / 10}%`);
  const set = (v) => { range.value = toPos(v); box.value = fmtGain(v); fill(); };
  range.addEventListener('input', () => {
    const v = Number(toVal(+range.value).toPrecision(3));
    box.value = fmtGain(v); fill(); onChange(v);
  });
  box.addEventListener('change', () => {
    let v = +box.value;
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (!allowZero && v <= 0) v = lo;
    set(v); onChange(v);
  });
  return { row, set };
}

function buildTrimmers() {
  const host = $('trimmers');
  host.innerHTML = '';
  const d = S.def;
  const gainChange = (k) => (v) => {
    const g = { Kp: S.set.Kp, Ki: S.set.Ki, Kd: S.set.Kd, [k]: v };
    if (S.relay) { S.set[k] = v; return; }
    applyGains(g);
  };
  const defs = [
    ['Kp', 'KP', 'R1', d.gainRange.Kp, true, gainChange('Kp')],
    ['Ki', 'KI', 'R2 · 1/s', d.gainRange.Ki, true, gainChange('Ki')],
    ['Kd', 'KD', 'R3 · s', d.gainRange.Kd, true, gainChange('Kd')],
    ['N', 'N', 'D filt rad/s', d.gainRange.N, false, (v) => { S.set.N = v; applyOptions(); }],
  ];
  for (const [k, ...rest] of defs) {
    const t = makeTrimmer(k, ...rest);
    host.append(t.row);
    t.set(S.set[k]);
    trimmers[k] = t;
  }
}

function syncSetpointUI() {
  const [lo, hi] = S.def.spRange;
  $('sp-range').value = Math.round(((S.sp - lo) / (hi - lo)) * 1000);
  $('sp-range').style.setProperty('--fill', `${$('sp-range').value / 10}%`);
  $('sp-num').value = +S.sp.toFixed(4);
}

function syncSpeed() {
  document.querySelectorAll('#speed-seg button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.speed === S.speed)));
}
function syncOptions() {
  document.querySelectorAll('#aw-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aw === S.set.aw)));
  $('opt-dom').checked = S.set.dom;
  $('opt-noise').checked = S.set.noise;
  $('opt-terms').checked = S.set.terms;
  $('opt-auto').checked = S.set.auto;
  $('pid-wrap').hidden = !S.set.terms;
}
function syncView() {
  document.querySelectorAll('#view-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
  $('live-view').hidden = S.view !== 'live';
  $('compare-view').hidden = S.view !== 'compare';
  // canvases measured while hidden are 10 px wide: re-measure now that they're visible
  for (const p of [...Object.values(plots), ...Object.values(cplots)]) p.resize();
  S.compareDirty = true;
}
function syncButtons() {
  const busy = !!S.relay || !!S.opt;
  $('btn-tune').textContent = S.relay ? 'Cancel tune' : 'Autotune';
  $('btn-tune').classList.toggle('on', !!S.relay);
  $('btn-tune').disabled = !!S.opt;
  $('btn-opt').disabled = busy;
  $('btn-step').disabled = !!S.relay;
  $('btn-dist').classList.toggle('on', S.dist);
  $('btn-dist').textContent = S.dist ? 'Remove dist.' : 'Disturb';
}
function status(html) { $('status').innerHTML = html; }

function wireControls() {
  const seg = $('plant-seg');
  for (const id of PLANT_IDS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.plant = id; b.textContent = PLANTS[id].short;
    b.addEventListener('click', () => { if (id !== S.id) { loadPlant(id); status('Ready.'); } });
    seg.append(b);
  }
  document.querySelectorAll('#speed-seg button').forEach((b) => b.addEventListener('click', () => { S.speed = +b.dataset.speed; syncSpeed(); }));
  document.querySelectorAll('#view-seg button').forEach((b) => b.addEventListener('click', () => {
    S.view = b.dataset.view; syncView();
    if (S.view === 'compare' && !S.runs.length) loadPresetRuns();
  }));
  document.querySelectorAll('#aw-seg button').forEach((b) => b.addEventListener('click', () => {
    S.set.aw = b.dataset.aw; syncOptions(); applyOptions();
  }));
  $('opt-dom').addEventListener('change', (e) => { S.set.dom = e.target.checked; applyOptions(); });
  $('opt-noise').addEventListener('change', (e) => { S.set.noise = e.target.checked; applyOptions(); });
  $('opt-terms').addEventListener('change', (e) => { S.set.terms = e.target.checked; syncOptions(); });
  $('opt-auto').addEventListener('change', (e) => { S.set.auto = e.target.checked; });

  $('sp-range').addEventListener('input', (e) => {
    const [lo, hi] = S.def.spRange;
    setSetpoint(lo + ((hi - lo) * +e.target.value) / 1000);
  });
  $('sp-num').addEventListener('change', (e) => { if (Number.isFinite(+e.target.value)) setSetpoint(+e.target.value); else syncSetpointUI(); });
  const limits = () => {
    let a = +$('umin').value, b = +$('umax').value;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) { $('umin').value = S.set.uMin; $('umax').value = S.set.uMax; return; }
    S.set.uMin = a; S.set.uMax = b; applyOptions();
  };
  $('umin').addEventListener('change', limits);
  $('umax').addEventListener('change', limits);

  $('btn-step').addEventListener('click', () => {
    const [s0, s1] = S.def.step;
    setSetpoint(Math.abs(S.sp - s1) < 1e-9 ? s0 : s1);
  });
  $('btn-dist').addEventListener('click', () => {
    if (S.set.auto) { S.set.auto = false; $('opt-auto').checked = false; }
    setDisturbance(!S.dist);
  });
  $('btn-reset').addEventListener('click', () => { resetSim(); status('Reset: plant at rest, setpoint step at t = 0.'); });
  $('btn-defaults').addEventListener('click', () => {
    S.set = { ...S.set, ...S.def.defaultGains, uMin: S.def.uMin, uMax: S.def.uMax, aw: 'clamp', dom: true };
    $('umin').value = S.def.uMin; $('umax').value = S.def.uMax;
    buildTrimmers(); syncOptions(); resetSim(); status('Default gains restored.');
  });
  $('btn-tune').addEventListener('click', () => { if (S.relay) { cancelRelay(false); status('Relay test cancelled.'); } else startRelay(); });
  $('btn-opt').addEventListener('click', startOptimise);
  $('cmp-presets').addEventListener('click', loadPresetRuns);
  $('cmp-add').addEventListener('click', () => addRun());
  $('cmp-clear').addEventListener('click', () => { S.runs = []; renderCompare(); });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
    e.preventDefault();
    S.speed = S.speed === 0 ? (S.def.id === 'heater' ? 20 : 1) : 0;
    syncSpeed();
  });
}

/* ------------------------------------------------------------------------------------
 * Main loop: fixed-step accumulator
 * ---------------------------------------------------------------------------------- */
let lastNow = null;
function frame(now) {
  const dt = lastNow === null ? 0 : Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (S.speed > 0) {
    const Ts = S.loop.Ts;
    S.acc += dt * S.speed;
    let n = 0;
    while (S.acc >= Ts && n < 20000) { simTick(); S.acc -= Ts; n++; }
    if (n >= 20000) S.acc = 0;
  }
  stepOptimiser();
  render();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------------------- */
readPalette();
wireControls();
const urlGains = {};
for (const [q, k] of [['kp', 'Kp'], ['ki', 'Ki'], ['kd', 'Kd'], ['n', 'N']]) if (num(q) !== undefined && num(q) >= 0) urlGains[k] = num(q);
loadPlant(S.id, Object.keys(urlGains).length ? urlGains : undefined);
syncView();
if (qs.get('autotune') === '1') startRelay();

// ?prerun=<seconds>: simulate that much time instantly before the first paint
// (deterministic; useful for screenshots and the portfolio embed).
const prerun = num('prerun');
if (prerun > 0) {
  const n = Math.min(Math.round(prerun / S.loop.Ts), 2_000_000);
  for (let i = 0; i < n; i++) simTick();
}
resizePlantCanvas();
render();
requestAnimationFrame(frame);
