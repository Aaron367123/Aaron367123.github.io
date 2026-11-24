/**
 * Logic Sim web app: wires the engine (engine/, a byte-identical copy of the
 * library's src/) to the board view, editor, timing panel and toolbar.
 *
 * Simulation modes
 *   run   - clocks advance, ticks at the chosen speed
 *   pause - clocks held; pending events still play out at the chosen speed,
 *           so flipping a switch shows the signal travelling gate by gate
 *   step  - nothing moves until Step (one tick, clocks included)
 *
 * URL: ?example=<name> ?run=1 ?theme=light|dark ?panel=timing|truth
 *      ?speed=<ticks/s> ?set=EN:1,A:0   #c=<share code>
 */
import {
  Simulator, CircuitError, createCircuit, cloneCircuit, fromJSON, stringify, toJSON, encodeCircuit, decodeCircuit,
  packageAsChip, chipInterface, truthTable, criticalPath, gateCount, withDefaults, nameOf, X,
} from './engine/index.js';
import { BoardView } from './ui/view.js';
import { Editor } from './ui/editor.js';
import { TimingPanel } from './ui/timing.js';
import { geometry } from './ui/geometry.js';
import { componentMarkup } from './ui/shapes.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ state */

const app = {
  circuit: createCircuit(),
  sim: null,
  error: null,
  mode: 'pause',
  speed: Number(params.get('speed')) || 10,
  undoStack: [],
  redoStack: [],
  examples: [],
};

const view = new BoardView($('#board'));
const editor = new Editor(app, view);
const timing = new TimingPanel($('#timing-panel'));

/* ------------------------------------------------------- circuit lifecycle */

/** Rebuild the simulator after a structural change and redraw everything. */
function rebuild({ settle = true } = {}) {
  try {
    app.sim = new Simulator(app.circuit);
    app.error = null;
  } catch (e) {
    app.sim = null;
    app.error = e.message;
  }
  view.render(app.circuit);
  view.bind(app.sim);
  if (app.sim && settle) app.sim.settle({ maxTicks: 4000 });
  view.paint();
  timing.setSim(app.sim, app.circuit);
  try { app.stats = app.sim ? gateCount(app.circuit) : null; } catch { app.stats = null; }
  buildPalette();
  refresh();
  updateInspector();
}

function setCircuit(circuit, { fit = true, keepHistory = false } = {}) {
  if (!keepHistory) { app.undoStack = []; app.redoStack = []; }
  app.circuit = circuit;
  editor.select();
  rebuild();
  if (fit) requestAnimationFrame(() => view.fit());
  const d = $('#desc');
  d.innerHTML = circuit.description ? `<b>${esc(circuit.name)}</b>${esc(circuit.description)}` : '';
}

const snapshot = () => JSON.stringify(app.circuit);

/** Apply a structural edit with undo support. */
app.commit = (mutate) => {
  app.undoStack.push(snapshot());
  if (app.undoStack.length > 100) app.undoStack.shift();
  app.redoStack = [];
  mutate(app.circuit);
  rebuild();
};
app.undo = () => {
  if (!app.undoStack.length) return;
  app.redoStack.push(snapshot());
  app.circuit = JSON.parse(app.undoStack.pop());
  editor.select();
  rebuild();
};
app.redo = () => {
  if (!app.redoStack.length) return;
  app.undoStack.push(snapshot());
  app.circuit = JSON.parse(app.redoStack.pop());
  editor.select();
  rebuild();
};
// Moves only change positions: re-route wires, keep the running simulator.
app.beginMove = () => { app.undoStack.push(snapshot()); app.redoStack = []; };
app.liveRender = () => { view.render(app.circuit); view.bind(app.sim); view.paint(); };
app.endMove = () => { updateInspector(); };

app.setInput = (id, v) => {
  const comp = app.circuit.components.find((c) => c.id === id);
  if (comp?.type === 'INPUT') comp.props = { ...comp.props, value: v };
  if (!app.sim) return;
  app.sim.setInput(id, v);
  view.paint();
  refresh();
};
app.toggleInput = (id) => {
  if (!app.sim) return;
  app.setInput(id, app.sim.read(id) === 1 ? 0 : 1);
};

/* --------------------------------------------------------------- the loop */

let last = performance.now();
let acc = 0;
// A 60 Hz timer rather than requestAnimationFrame: it keeps simulated time
// moving in background tabs and headless screenshots (virtual time).
const schedule = () => setTimeout(() => frame(performance.now()), 16);

function frame(now) {
  const dt = Math.min(250, now - last);
  last = now;
  const sim = app.sim;
  const active = sim && (app.mode === 'run' || (app.mode === 'pause' && sim.pendingEvents > 0));
  if (active) {
    acc += (dt * app.speed) / 1000;
    const n = Math.min(Math.floor(acc), 4000);
    acc -= n;
    if (n > 0) {
      let changed = [];
      for (let i = 0; i < n; i++) changed = changed.concat(sim.step({ freezeClocks: app.mode !== 'run' }));
      view.paint();
      if (app.speed <= 30) view.flash(changed, Math.min(450, 1000 / app.speed));
      refresh();
    }
  } else {
    acc = 0;
  }
  schedule();
}

app.toggleRun = () => {
  app.mode = app.mode === 'run' ? 'pause' : 'run';
  refresh();
};
app.stepOnce = () => {
  if (!app.sim) return;
  app.mode = 'step';
  const changed = app.sim.step();
  view.paint();
  view.flash(changed, 380);
  refresh();
};

/* ------------------------------------------------------- status & banner */

function refresh() {
  const sim = app.sim;
  const run = $('#run');
  run.classList.toggle('running', app.mode === 'run');
  run.querySelector('.ico').textContent = app.mode === 'run' ? '❚❚' : '▶';
  run.querySelector('.txt').textContent = app.mode === 'run' ? 'Pause' : 'Run';
  $('#undo').disabled = !app.undoStack.length;
  $('#redo').disabled = !app.redoStack.length;

  const banner = $('#banner');
  if (app.error) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<b>INVALID</b>${esc(app.error)}`;
  } else if (sim?.oscillation) {
    const o = sim.oscillation;
    banner.hidden = false;
    banner.className = 'banner';
    const nets = o.nets.slice(0, 6).map(esc).join(', ') + (o.nets.length > 6 ? ', …' : '');
    banner.innerHTML = o.reason === 'event-cap'
      ? `<b>UNSTABLE</b>more than ${sim.maxEventsPerTick} events in one tick`
      : `<b>UNSTABLE</b>oscillating loop of ${o.nets.length} net${o.nets.length === 1 ? '' : 's'}` +
        (o.period ? `, period ${o.period} ticks` : '') + ` <code>${nets}</code>`;
  } else {
    banner.hidden = true;
  }

  const status = $('#status');
  if (!sim) { status.innerHTML = '<span><span class="dot bad"></span>no simulation</span>'; timing.draw(); return; }
  const pending = sim.pendingEvents;
  const state = app.mode === 'run' ? ['run', 'running'] : sim.oscillation ? ['bad', 'unstable'] : pending ? ['busy', 'propagating'] : ['', app.mode === 'step' ? 'single-step' : 'stable'];
  const st = app.stats;
  status.innerHTML =
    `<span><span class="dot ${state[0]}"></span><b>${state[1]}</b></span>` +
    `<span>t = <b>${sim.time}</b></span>` +
    `<span>events <b>${pending}</b> pending</span>` +
    (st ? `<span><b>${st.gates}</b> gates${st.flipFlops ? ` · <b>${st.flipFlops}</b> FF` : ''}</span>` : '') +
    `<span class="st-speed">${app.speed} ticks/s</span>`;
  timing.draw();
}

/* ---------------------------------------------------------------- palette */

const PARTS = [
  ['Inputs', [
    { key: 'INPUT', type: 'INPUT', name: 'Switch' },
    { key: 'BUTTON', type: 'BUTTON', name: 'Button' },
    { key: 'CLOCK', type: 'CLOCK', name: 'Clock', props: { period: 8 } },
    { key: 'CONST1', type: 'CONST', name: 'High', props: { value: 1 } },
    { key: 'CONST0', type: 'CONST', name: 'Low', props: { value: 0 } },
  ]],
  ['Gates', ['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT', 'BUF'].map((t) => ({ key: t, type: t, name: t }))],
  ['Outputs', [
    { key: 'OUTPUT', type: 'OUTPUT', name: 'LED' },
    { key: 'PROBE', type: 'PROBE', name: 'Probe' },
    { key: 'SEG7', type: 'SEG7', name: '7-seg' },
  ]],
  ['Memory', [{ key: 'DFF', type: 'DFF', name: 'D flip-flop', props: { init: 0 } }]],
];

function partIcon(item, lib) {
  const comp = { id: 'icon', type: item.type, x: 0, y: 0, props: item.props ?? {} };
  const geo = geometry(comp, lib);
  const b = geo.box;
  const pad = 4;
  // Icons drop the name labels and period text; IC pin names stay.
  const body = componentMarkup(comp, geo).replace(/<text class="silk (lbl|small)[^"]*"[^>]*>[^<]*<\/text>/g, '');
  return `<svg viewBox="${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}" class="comp t-${item.type}">${body}</svg>`;
}

function buildPalette() {
  const lib = app.circuit.chips ?? {};
  const chips = Object.keys(lib).map((name) => ({ key: `chip:${name}`, type: 'SUBCIRCUIT', name, props: { chip: name } }));
  const sections = [...PARTS, ['Chips', chips]];
  const parts = $('#parts');
  const sig = JSON.stringify(sections.map(([, items]) => items.map((i) => i.key)));
  if (parts.dataset.sig === sig) return;
  parts.dataset.sig = sig;
  parts.innerHTML = sections.map(([title, items]) => {
    if (!items.length) return title === 'Chips' ? '<h3>Chips</h3><p class="muted" style="font-size:11px;margin:0 2px">Use “Package chip” to turn a circuit into a reusable part.</p>' : '';
    return `<h3>${title}</h3><div class="part-grid">` + items.map((it) =>
      `<button class="part ${it.type === 'SUBCIRCUIT' ? 'chip-part' : ''}" data-key="${esc(it.key)}" title="${esc(it.name)}: drag onto the board, or tap then tap the board">` +
      `${partIcon(it, lib)}<span>${esc(it.name)}</span></button>`).join('') + '</div>';
  }).join('');
  const byKey = new Map(sections.flatMap(([, items]) => items).map((i) => [i.key, i]));
  parts.querySelectorAll('.part').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      editor.beginPaletteDrag(byKey.get(btn.dataset.key), e, $('#ghost'));
    });
  });
  highlightArmed(editor.armed);
}

function highlightArmed(item) {
  document.querySelectorAll('.part').forEach((b) => b.classList.toggle('armed', item?.key === b.dataset.key));
  const hint = $('#armed-hint');
  hint.hidden = !item;
  if (item) hint.textContent = `Tap the board to place ${item.name} · Esc to cancel`;
  if (item && window.matchMedia('(max-width: 600px)').matches) $('#palette').classList.remove('open');
}
app.onArmChange = highlightArmed;

$('#sheet-handle').addEventListener('click', () => $('#palette').classList.toggle('open'));

/* -------------------------------------------------------------- inspector */

app.onSelectionChange = () => updateInspector();

function updateInspector() {
  const box = $('#inspector');
  const { comps, wires } = editor.selection;
  if (comps.size === 1 && !wires.size) {
    const comp = app.circuit.components.find((c) => c.id === [...comps][0]);
    if (comp) { box.innerHTML = inspectorFor(comp); bindInspector(box, comp); return; }
  }
  if (comps.size || wires.size) {
    const what = [comps.size && `${comps.size} part${comps.size > 1 ? 's' : ''}`, wires.size && `${wires.size} wire${wires.size > 1 ? 's' : ''}`].filter(Boolean).join(', ');
    const w = wires.size === 1 ? app.circuit.wires[[...wires][0]] : null;
    box.innerHTML = `<h3>Selection</h3><p>${what}</p>${w ? `<p><code>${esc(w.from)} → ${esc(w.to)}</code></p>` : ''}<button class="danger" data-act="delete">Delete</button>`;
    box.querySelector('[data-act="delete"]').addEventListener('click', () => editor.deleteSelection());
    return;
  }
  box.innerHTML = `<h3>How to</h3>
    <p>Drag parts onto the board. Drag from a pin to a pin to wire. Click a switch to flip it.</p>
    <p><kbd>Space</kbd> run · <kbd>→</kbd> step · <kbd>Del</kbd> delete · <kbd>Ctrl Z</kbd>/<kbd>Y</kbd> undo/redo · <kbd>F</kbd> fit · wheel zoom · drag board to pan · <kbd>Shift</kbd>-drag select</p>`;
}

function inspectorFor(comp) {
  const p = withDefaults(comp);
  const row = (label, html) => `<div class="row"><span>${label}</span>${html}</div>`;
  const sel = (name, opts, cur) => `<select data-prop="${name}">${opts.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  let s = `<h3>${esc(comp.type === 'SUBCIRCUIT' ? `Chip · ${p.chip}` : comp.type)} <span class="muted">${esc(comp.id)}</span></h3>`;
  s += row('Label', `<input type="text" data-field="label" value="${esc(comp.label ?? '')}" maxlength="12" spellcheck="false">`);
  if (['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR'].includes(comp.type)) s += row('Inputs', sel('inputs', [[2, '2'], [3, '3'], [4, '4']], p.inputs));
  if (comp.type === 'CLOCK') s += row('Period', `<input type="number" data-prop="period" min="2" step="2" value="${p.period}">`);
  if (comp.type === 'CONST') s += row('Value', sel('value', [[0, '0'], [1, '1']], p.value));
  if (comp.type === 'OUTPUT') s += row('Colour', sel('color', [['led', 'green'], ['warn', 'amber'], ['danger', 'red'], ['signal', 'cyan']], p.color));
  if (comp.type === 'DFF') s += row('Power-on', sel('init', [['X', 'X'], [0, '0'], [1, '1']], p.init));
  if (comp.type === 'SUBCIRCUIT') {
    const def = app.circuit.chips?.[p.chip];
    if (def) {
      const io = chipInterface(def);
      s += `<p>${io.inputs.map((x) => x.label).join(', ')} → ${io.outputs.map((x) => x.label).join(', ')}</p>`;
      try { s += `<p>${gateCount({ ...def, chips: { ...app.circuit.chips, ...def.chips } }).gates} gates inside</p>`; } catch { /* ignore */ }
    }
  }
  if (comp.type === 'DFF' && app.sim) {
    try { const q = app.sim.flipFlopState(comp.id); s += row('State', `<b>${q === X ? 'X' : q}</b>`); } catch { /* inside chip */ }
  }
  return s + '<button class="danger" data-act="delete">Delete</button>';
}

function bindInspector(box, comp) {
  box.querySelector('[data-field="label"]').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    app.commit((c) => { const x = c.components.find((k) => k.id === comp.id); if (v) x.label = v; else delete x.label; });
  });
  box.querySelectorAll('[data-prop]').forEach((input) => input.addEventListener('change', () => {
    const name = input.dataset.prop;
    let v = input.value;
    if (name === 'inputs' || name === 'period' || name === 'value') v = Number(v);
    if (name === 'init') v = v === 'X' ? 'X' : Number(v);
    if (name === 'period') v = Math.max(2, Math.round(v / 2) * 2);
    app.commit((c) => {
      const x = c.components.find((k) => k.id === comp.id);
      x.props = { ...x.props, [name]: v };
      if (name === 'inputs') c.wires = c.wires.filter((w) => !(w.to.startsWith(`${comp.id}.in`) && Number(w.to.slice(comp.id.length + 3)) >= v));
    });
  }));
  box.querySelector('[data-act="delete"]').addEventListener('click', () => editor.deleteSelection());
}
app.focusInspector = () => {
  if (window.matchMedia('(max-width: 600px)').matches) $('#palette').classList.add('open');
  $('#inspector [data-field="label"]')?.focus();
};

/* ------------------------------------------------------------------ modal */

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
}
app.closeModals = () => { $('#modal').hidden = true; };
$('#modal-close').addEventListener('click', app.closeModals);
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') app.closeModals(); });

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function showTruthTable() {
  let html = '';
  try {
    const gc = gateCount(app.circuit);
    const tt = truthTable(app.circuit);
    const cp = criticalPath(app.circuit);
    html += `<div class="stats">
      <div class="stat"><b>${tt.inputs.length} → ${tt.outputs.length}</b><span>inputs → outputs</span></div>
      <div class="stat"><b>${tt.rows.length}</b><span>rows</span></div>
      <div class="stat"><b>${gc.gates}</b><span>gates (flattened)</span></div>
      <div class="stat"><b>${cp.depth}</b><span>critical path (ticks)</span></div>
      <div class="stat"><b>${tt.maxSettleTicks}</b><span>worst settle (ticks)</span></div></div>
      <p class="path">longest path: ${cp.path.map(esc).join(' → ')}</p>`;
    html += '<div class="tt-wrap"><table class="tt"><thead><tr>' +
      tt.inputs.map((n) => `<th>${esc(n)}</th>`).join('') +
      tt.outputs.map((n, i) => `<th class="out ${i === 0 ? 'sep' : ''}">${esc(n)}</th>`).join('') + '</tr></thead><tbody>' +
      tt.rows.map((r) => '<tr>' +
        r.inputs.map((v) => `<td class="${v ? 'one' : ''}">${v}</td>`).join('') +
        r.outputs.map((v, i) => `<td class="out ${i === 0 ? 'sep' : ''} ${v === '1' ? 'one' : v === 'X' ? 'x' : ''}">${v}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  } catch (e) {
    let extra = '';
    try { const gc = gateCount(app.circuit); extra = `<div class="stats" style="margin-top:12px"><div class="stat"><b>${gc.gates}</b><span>gates (flattened)</span></div><div class="stat"><b>${gc.flipFlops}</b><span>flip-flops</span></div></div>`; } catch { /* invalid */ }
    html = `<div class="error-box">${esc(e.message)}</div>${extra}<p style="margin-top:12px">Truth tables need a combinational circuit (no clocks, flip-flops or feedback loops) with 1–8 switches. Use the timing diagram to study sequential circuits.</p>`;
  }
  openModal(`Truth table · ${app.circuit.name}`, html);
}

function showPackage() {
  openModal('Package as chip', `
    <p>Turns the current circuit into a reusable part. Its labelled switches become input pins and its labelled LEDs output pins, top to bottom. The board is replaced by one instance of the chip, wired to fresh switches and LEDs; the chip stays in the palette under <b>Chips</b>.</p>
    <div class="form-row"><input type="text" id="chip-name" value="${esc(app.circuit.name || 'my-chip')}" maxlength="24" spellcheck="false"><button class="primary" id="chip-go">Package</button></div>
    <div id="chip-err"></div>`);
  const go = () => {
    const name = $('#chip-name').value.trim().replace(/\s+/g, '-');
    try {
      const def = packageAsChip(app.circuit, name);
      const next = createCircuit(`${name}-test`, `One "${name}" chip wired to switches and LEDs.`);
      next.chips = { ...cloneCircuit(app.circuit.chips ?? {}), [name]: def };
      const io = chipInterface(def);
      const chip = { id: 'u1', type: 'SUBCIRCUIT', x: 240, y: 80, props: { chip: name } };
      next.components.push(chip);
      const geo = geometry(chip, next.chips);
      io.inputs.forEach((p, i) => {
        next.components.push({ id: `in${i}`, type: 'INPUT', x: 60, y: 60 + i * 60, label: p.label });
        next.wires.push({ from: `in${i}.out`, to: `u1.${p.label}` });
      });
      io.outputs.forEach((p, i) => {
        next.components.push({ id: `out${i}`, type: 'OUTPUT', x: 240 + geo.box.w + 80, y: 60 + i * 60, label: p.label });
        next.wires.push({ from: `u1.${p.label}`, to: `out${i}.in` });
      });
      app.undoStack.push(snapshot());
      app.closeModals();
      setCircuit(fromJSON(toJSON(next)), { keepHistory: true });
      toast(`Packaged "${name}": find it under Chips in the palette`);
    } catch (e) {
      $('#chip-err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  };
  $('#chip-go').addEventListener('click', go);
  $('#chip-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#chip-name').select();
}

/* --------------------------------------------------- save / load / share */

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

async function share() {
  const code = await encodeCircuit(app.circuit);
  const url = `${location.origin}${location.pathname}#c=${code}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    toast(`Share link copied (${code.length} characters, deflate + base64url)`);
  } catch {
    openModal('Share link', `<p>Copy this link; the whole circuit is encoded in it.</p><input class="share-url" readonly value="${esc(url)}">`);
    $('.share-url').select();
  }
}

/* -------------------------------------------------------- toolbar wiring */

$('#run').addEventListener('click', app.toggleRun);
$('#step').addEventListener('click', app.stepOnce);
$('#settle').addEventListener('click', () => {
  if (!app.sim) return;
  const r = app.sim.settle();
  view.paint();
  if (app.mode === 'step') app.mode = 'pause';
  refresh();
  toast(r.stable ? `Stable after ${r.ticks} tick${r.ticks === 1 ? '' : 's'}` : `Unstable: ${r.reason}${r.period ? `, period ${r.period}` : ''}`);
});
$('#reset').addEventListener('click', () => {
  if (!app.sim) return;
  app.sim.reset();
  app.sim.settle();
  view.paint();
  refresh();
});
$('#speed').value = String(app.speed);
if ($('#speed').value !== String(app.speed)) {
  $('#speed').insertAdjacentHTML('beforeend', `<option value="${app.speed}">${app.speed} t/s</option>`);
  $('#speed').value = String(app.speed);
}
$('#speed').addEventListener('change', (e) => { app.speed = Number(e.target.value); refresh(); });
$('#truth').addEventListener('click', showTruthTable);
$('#package').addEventListener('click', showPackage);
function setTiming(open) {
  $('#timing-panel').hidden = !open;
  $('#timing').setAttribute('aria-pressed', String(open));
  timing.draw();
}
$('#timing').addEventListener('click', () => setTiming($('#timing-panel').hidden));
$('#timing-close').addEventListener('click', () => setTiming(false));
$('#undo').addEventListener('click', app.undo);
$('#redo').addEventListener('click', app.redo);
$('#save').addEventListener('click', () => download(`${app.circuit.name || 'circuit'}.json`, stringify(app.circuit) + '\n'));
$('#load').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    setCircuit(fromJSON(await f.text()));
    toast(`Loaded ${f.name}`);
  } catch (err) {
    toast(`Could not load: ${err.message}`, 5000);
  }
});
$('#share').addEventListener('click', () => share().catch((e) => toast(`Share failed: ${e.message}`)));
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  timing.draw();
});
$('#zoom-in').addEventListener('click', () => { const r = view.svg.getBoundingClientRect(); view.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); });
$('#zoom-out').addEventListener('click', () => { const r = view.svg.getBoundingClientRect(); view.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); });
$('#zoom-fit').addEventListener('click', () => view.fit());
window.addEventListener('resize', () => timing.draw());
// Re-fit when the board changes size (rotation, panels, iframe resize) unless the user has panned/zoomed.
new ResizeObserver(() => { if (!view.userMoved) view.fit(); }).observe($('#board'));

$('#example').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) return;
  loadExample(name);
  const u = new URL(location.href);
  u.searchParams.set('example', name);
  u.hash = '';
  history.replaceState(null, '', u);
});

async function loadExample(name) {
  const res = await fetch(`examples/${encodeURIComponent(name)}.json`);
  if (!res.ok) throw new Error(`example "${name}" not found`);
  setCircuit(fromJSON(await res.text()));
  $('#example').value = name;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    app.examples = await (await fetch('examples/index.json')).json();
    $('#example').insertAdjacentHTML('beforeend', app.examples.map((e) => `<option value="${esc(e.name)}">${esc(e.title)}</option>`).join(''));
  } catch { /* offline: no examples list */ }

  const hash = new URLSearchParams(location.hash.slice(1));
  try {
    if (hash.get('c')) setCircuit(await decodeCircuit(hash.get('c')));
    else await loadExample(params.get('example') || 'full-adder');
  } catch (e) {
    toast(`Could not load circuit: ${e.message}`, 5000);
    setCircuit(createCircuit('untitled'));
  }

  // ?set=EN:1,A:0 flips switches after loading (handy for demos and screenshots).
  for (const pair of (params.get('set') ?? '').split(',').filter(Boolean)) {
    const [id, v] = pair.split(':');
    try {
      const comp = app.circuit.components.find((c) => c.id === id || c.label === id);
      if (comp) app.setInput(comp.id, Number(v));
    } catch (e) { console.warn(e); }
  }
  if (params.get('run') === '1') app.mode = 'run';
  const panel = params.get('panel');
  if (panel === 'timing') setTiming(true);
  if (panel === 'truth') showTruthTable();
  refresh();
  schedule();
}

window.addEventListener('error', (e) => console.error(e.error ?? e.message));
boot();

// Exposed for debugging in the console.
window.logicSim = { app, view, editor, CircuitError, nameOf };
