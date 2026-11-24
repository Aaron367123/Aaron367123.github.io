/**
 * BoardView: renders a circuit into an SVG "PCB" and paints simulation
 * values onto it. Structure (render) and values (paint) are separate so a
 * running simulation only toggles classes on existing elements.
 */
import { X } from '../engine/index.js';
import { geometry } from './geometry.js';
import { routeAll, pathFor } from './route.js';
import { componentMarkup, pinMarkup } from './shapes.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const valueClass = (v) => (v === 0 ? 'v0' : v === 1 ? 'v1' : v === X ? 'vx' : 'vz');

export class BoardView {
  constructor(svg) {
    this.svg = svg;
    this.view = { x: 0, y: 0, k: 1 };
    svg.innerHTML = `
      <defs>
        <pattern id="pcb-dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle class="grid-dot" cx="0" cy="0" r="0.9"/>
        </pattern>
        <pattern id="pcb-vias" width="200" height="200" patternUnits="userSpaceOnUse">
          <circle class="via" cx="50" cy="70" r="3"/><circle class="via" cx="150" cy="30" r="2.4"/>
          <circle class="via" cx="130" cy="150" r="3"/><circle class="via" cx="20" cy="180" r="2.4"/>
          <path class="ghost-trace" d="M50,70 H90 L110,90 V150 H130"/>
        </pattern>
      </defs>
      <g class="world">
        <rect class="board-bg" x="-20000" y="-20000" width="40000" height="40000" fill="url(#pcb-vias)"/>
        <rect class="board-bg" x="-20000" y="-20000" width="40000" height="40000" fill="url(#pcb-dots)"/>
        <g class="layer-wires"></g>
        <g class="layer-comps"></g>
        <g class="layer-overlay"></g>
      </g>`;
    this.world = svg.querySelector('.world');
    this.wiresLayer = svg.querySelector('.layer-wires');
    this.compsLayer = svg.querySelector('.layer-comps');
    this.overlay = svg.querySelector('.layer-overlay');
    this.geoms = new Map();
    this.compEls = new Map();
    this.wireEls = [];
    this.selection = { comps: new Set(), wires: new Set() };
  }

  /* ---------------- structure ---------------- */

  render(circuit) {
    this.circuit = circuit;
    const lib = circuit.chips ?? {};
    this.geoms = new Map(circuit.components.map((c) => [c.id, geometry(c, lib)]));

    // Wires (one <g> each: glow halo, copper core, spark overlay, wide hit area).
    this.wiresLayer.replaceChildren();
    this.wireEls = [];
    const { wires, junctions } = routeAll(circuit, this.geoms);
    for (const r of wires) {
      const d = pathFor(r.points);
      const g = el('g', { class: 'wire vz', 'data-wire': r.index });
      g.append(el('path', { class: 'halo', d }), el('path', { class: 'core', d }),
        el('path', { class: 'spark', d }), el('path', { class: 'hit', d }));
      this.wiresLayer.append(g);
      this.wireEls[r.index] = { g, from: r.from, spark: g.children[2], len: null };
    }
    this.junctionEls = junctions.map((j) => {
      const c = el('circle', { class: 'junction vz', cx: j.x, cy: j.y, r: 3.4 });
      this.wiresLayer.append(c);
      return { el: c, from: j.from };
    });

    // Components.
    this.compsLayer.replaceChildren();
    this.compEls = new Map();
    for (const c of circuit.components) {
      const geo = this.geoms.get(c.id);
      const g = el('g', { class: `comp t-${c.type}`, 'data-id': c.id, transform: `translate(${c.x},${c.y})` });
      const b = geo.box;
      g.innerHTML = `<rect class="sel-outline" x="${b.x - 6}" y="${b.y - 6}" width="${b.w + 12}" height="${b.h + 12}" rx="6"/>` +
        `<rect class="hit-box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>` +
        componentMarkup(c, geo) + pinMarkup(geo);
      this.compsLayer.append(g);
      this.compEls.set(c.id, { g, comp: c, pads: [...g.querySelectorAll('.pad')] });
    }
    this.applySelection();
    this.netCache = null;
  }

  /** Move one component's element without a full re-render (during drags). */
  moveComponent(id, x, y) {
    const e = this.compEls.get(id);
    if (e) e.g.setAttribute('transform', `translate(${x},${y})`);
  }

  /* ---------------- values ---------------- */

  /** Bind element -> net index for a freshly built simulator. */
  bind(sim) {
    this.sim = sim;
    if (!sim) { this.netCache = null; return; }
    const net = (ref) => { try { return sim.netOf(ref); } catch { return undefined; } };
    this.netCache = {
      wires: this.wireEls.map((w) => (w ? net(w.from) : undefined)),
      junctions: this.junctionEls.map((j) => net(j.from)),
      pads: [...this.compEls.values()].flatMap(({ comp, pads }) => pads.map((p) => ({ p, n: net(`${comp.id}.${p.dataset.pin}`) }))),
    };
  }

  /** Paint every net value (cheap: class toggles only). */
  paint() {
    const sim = this.sim;
    const val = (n) => (n === undefined || !sim ? undefined : sim.flat.nets[n].driver < 0 ? undefined : sim.values[n]);
    const setV = (node, v) => {
      const cls = valueClass(v);
      if (node.dataset.v !== cls) {
        node.classList.remove('v0', 'v1', 'vx', 'vz');
        node.classList.add(cls);
        node.dataset.v = cls;
      }
    };
    if (!this.netCache) return;
    this.wireEls.forEach((w, i) => w && setV(w.g, val(this.netCache.wires[i])));
    this.junctionEls.forEach((j, i) => setV(j.el, val(this.netCache.junctions[i])));
    for (const { p, n } of this.netCache.pads) setV(p, val(n));

    for (const { g, comp } of this.compEls.values()) {
      const readIn = (pin) => { try { return sim.read(`${comp.id}.${pin}`); } catch { return X; } };
      switch (comp.type) {
        case 'INPUT': case 'BUTTON':
          g.classList.toggle('on', readIn('out') === 1); break;
        case 'CLOCK':
          g.classList.toggle('on', readIn('out') === 1); break;
        case 'OUTPUT': {
          const v = readIn('in');
          g.classList.toggle('on', v === 1);
          g.classList.toggle('unknown', v === X);
          break;
        }
        case 'PROBE': {
          const v = readIn('in');
          const t = g.querySelector('.probe-val');
          const s = v === X ? 'X' : String(v);
          if (t.textContent !== s) t.textContent = s;
          setV(g, v);
          break;
        }
        case 'SEG7': {
          let shown = null;
          try { shown = sim.display(comp.id); } catch { /* not top-level */ }
          const lit = shown ? shown.segments : '';
          for (const s of 'abcdefg') g.querySelector(`.seg-${s}`).classList.toggle('lit', lit.includes(s));
          g.classList.toggle('unknown', !shown);
          break;
        }
        default: break;
      }
    }
  }

  /** Animate a short spark along every wire whose net changed this tick. */
  flash(changedNets, durationMs) {
    if (!this.netCache || !changedNets.length || durationMs < 30) return;
    const set = new Set(changedNets);
    this.wireEls.forEach((w, i) => {
      if (!w || !set.has(this.netCache.wires[i])) return;
      if (w.len === null) w.len = w.spark.getTotalLength();
      const len = w.len;
      w.spark.style.strokeDasharray = `14 ${len + 20}`;
      w.spark.animate([{ strokeDashoffset: 14, opacity: 1 }, { strokeDashoffset: -len, opacity: 0.85 }],
        { duration: durationMs, easing: 'linear' });
    });
  }

  /* ---------------- selection & overlay ---------------- */

  setSelection(comps, wires) {
    this.selection = { comps: new Set(comps), wires: new Set(wires) };
    this.applySelection();
  }

  applySelection() {
    for (const [id, { g }] of this.compEls) g.classList.toggle('selected', this.selection.comps.has(id));
    this.wireEls.forEach((w, i) => w && w.g.classList.toggle('selected', this.selection.wires.has(i)));
  }

  /** Temporary path (wire being drawn, marquee). */
  setOverlay(markup) {
    this.overlay.innerHTML = markup ?? '';
  }

  /* ---------------- pan / zoom ---------------- */

  setView(x, y, k) {
    this.view = { x, y, k };
    this.world.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
  }

  /** Screen (client) coordinates -> world coordinates. */
  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
  }

  zoomAt(clientX, clientY, factor) {
    this.userMoved = true;
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(3, Math.max(0.2, this.view.k * factor));
    const px = clientX - r.left, py = clientY - r.top;
    const wx = (px - this.view.x) / this.view.k, wy = (py - this.view.y) / this.view.k;
    this.setView(px - wx * k, py - wy * k, k);
  }

  /** Bounding box of all components in world coordinates. */
  contentBox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of this.circuit?.components ?? []) {
      const b = this.geoms.get(c.id).box;
      const labelPad = ['INPUT', 'BUTTON', 'CLOCK'].includes(c.type) ? 50 : 0;
      const rightPad = c.type === 'OUTPUT' ? 50 : 0;
      x0 = Math.min(x0, c.x + b.x - labelPad); y0 = Math.min(y0, c.y + b.y - 14);
      x1 = Math.max(x1, c.x + b.x + b.w + rightPad); y1 = Math.max(y1, c.y + b.y + b.h + 14);
    }
    for (const w of this.wiresLayer.querySelectorAll('.core')) {
      const bb = w.getBBox();
      x0 = Math.min(x0, bb.x); y0 = Math.min(y0, bb.y); x1 = Math.max(x1, bb.x + bb.width); y1 = Math.max(y1, bb.y + bb.height);
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Zoom and centre so the whole circuit fits, with a margin. */
  fit(margin = 40, maxK = 1.6) {
    const r = this.svg.getBoundingClientRect();
    const b = this.contentBox();
    this.userMoved = false;
    if (!b || !r.width) { this.setView(r.width / 2 - 200, r.height / 2 - 150, 1); return; }
    // Space covered by overlays (status bar, phone bottom sheet) is not usable.
    const inset = parseFloat(getComputedStyle(this.svg).getPropertyValue('--fit-bottom')) || 0;
    const h = r.height - inset;
    const m = Math.min(margin, r.width * 0.04);
    const k = Math.min(maxK, (r.width - 2 * m) / b.w, (h - 2 * m) / b.h);
    const kk = Math.max(0.2, k);
    this.setView(r.width / 2 - (b.x + b.w / 2) * kk, h / 2 - (b.y + b.h / 2) * kk, kk);
  }
}
