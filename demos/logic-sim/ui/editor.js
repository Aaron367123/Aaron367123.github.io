/**
 * Editor: all pointer / keyboard interaction on the board.
 *
 *   drag palette item      -> place component (tap item, then tap board, on touch)
 *   drag from a pin        -> new wire (output -> input, either direction)
 *   click / drag component -> select / move (shift = add to selection)
 *   click switch / button  -> toggle / press
 *   drag background        -> pan;  shift + drag -> box select
 *   wheel / pinch          -> zoom around the pointer
 *   Delete, Ctrl+Z, Ctrl+Y, Ctrl+A, Esc
 *
 * The editor never edits the circuit behind the app's back: structural
 * changes go through app.commit(fn), moves through app.beginMove/endMove.
 */
import { snap, geometry } from './geometry.js';
import { pathFor, previewPoints } from './route.js';

const DRAG_THRESHOLD = 5;

export class Editor {
  constructor(app, view) {
    this.app = app;
    this.view = view;
    this.svg = view.svg;
    this.gesture = null;
    this.pointers = new Map();
    this.armed = null;             // { type, props } waiting for a tap on the board
    this.selection = { comps: new Set(), wires: new Set() };

    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onUp(e, true));
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      this.view.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });
    this.svg.addEventListener('dblclick', (e) => {
      const id = e.target.closest('.comp')?.dataset.id;
      if (id) this.app.focusInspector?.(id);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /* ---------------- selection ---------------- */

  select(comps = [], wires = []) {
    this.selection = { comps: new Set(comps), wires: new Set(wires) };
    this.view.setSelection(this.selection.comps, this.selection.wires);
    this.app.onSelectionChange?.(this.selection);
  }

  deleteSelection() {
    const { comps, wires } = this.selection;
    if (!comps.size && !wires.size) return;
    this.app.commit((c) => {
      c.wires = c.wires.filter((w, i) => !wires.has(i) &&
        !comps.has(w.from.slice(0, w.from.lastIndexOf('.'))) && !comps.has(w.to.slice(0, w.to.lastIndexOf('.'))));
      c.components = c.components.filter((x) => !comps.has(x.id));
    });
    this.select();
  }

  /* ---------------- placing ---------------- */

  arm(item) {
    this.armed = item;
    this.svg.classList.toggle('placing', !!item);
    this.app.onArmChange?.(item);
  }

  /** Add a component centred near world point p. */
  place(item, p) {
    const c = this.app.circuit;
    const prefix = (item.type === 'SUBCIRCUIT' ? item.props.chip.replace(/[^\w]/g, '').slice(0, 6) || 'chip' : item.type.toLowerCase());
    let n = 1;
    while (c.components.some((x) => x.id === `${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    const comp = { id, type: item.type, x: 0, y: 0 };
    if (item.props && Object.keys(item.props).length) comp.props = { ...item.props };
    if (['INPUT', 'BUTTON', 'OUTPUT', 'PROBE'].includes(item.type)) comp.label = this.nextLabel(item.type);
    if (item.type === 'CLOCK') comp.label = 'CLK';
    const box = geometry(comp, c.chips ?? {}).box;
    comp.x = snap(p.x - box.x - box.w / 2);
    comp.y = snap(p.y - box.y - box.h / 2);
    this.app.commit((circ) => { circ.components.push(comp); });
    this.select([id]);
    return id;
  }

  nextLabel(type) {
    const base = { INPUT: 'IN', BUTTON: 'BTN', OUTPUT: 'OUT', PROBE: 'P' }[type];
    const used = new Set(this.app.circuit.components.map((c) => c.label));
    let n = 0;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /** Called by the palette on pointerdown: drag a ghost, or arm on a simple tap. */
  beginPaletteDrag(item, e, ghost) {
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
        dragging = true;
        ghost.hidden = false;
      }
      if (dragging) ghost.style.transform = `translate(${ev.clientX - 22}px, ${ev.clientY - 22}px)`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.hidden = true;
      if (!dragging) { this.arm(this.armed?.key === item.key ? null : item); return; }
      const r = this.svg.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        this.place(item, this.view.toWorld(ev.clientX, ev.clientY));
      }
      this.arm(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---------------- pointer gestures ---------------- */

  onDown(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.svg.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) { this.startPinch(); return; }
    if (this.pointers.size > 2) return;

    const t = e.target;
    const world = this.view.toWorld(e.clientX, e.clientY);
    const compEl = t.closest('.comp');
    const pinEl = t.closest('.pin-hit');
    const wireEl = t.closest('.wire');

    if (this.armed && !pinEl) {
      this.gesture = { kind: 'place', start: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (pinEl && compEl) {
      const id = compEl.dataset.id, pin = pinEl.dataset.pin, side = pinEl.dataset.side;
      const comp = this.app.circuit.components.find((c) => c.id === id);
      const p = geometry(comp, this.app.circuit.chips ?? {}).pins[pin];
      this.gesture = { kind: 'wire', id, pin, side, a: { x: comp.x + p.x, y: comp.y + p.y } };
      return;
    }
    if (compEl) {
      const id = compEl.dataset.id;
      const comp = this.app.circuit.components.find((c) => c.id === id);
      if (e.shiftKey) {
        const s = new Set(this.selection.comps);
        s.has(id) ? s.delete(id) : s.add(id);
        this.select([...s], [...this.selection.wires]);
      } else if (!this.selection.comps.has(id)) {
        this.select([id]);
      }
      if (comp.type === 'BUTTON') this.app.setInput(id, 1);
      const moving = [...this.selection.comps].map((cid) => this.app.circuit.components.find((c) => c.id === cid)).filter(Boolean);
      this.gesture = {
        kind: 'move', id, comp, start: world, client: { x: e.clientX, y: e.clientY }, moved: false,
        items: moving.map((c) => ({ c, x: c.x, y: c.y })),
      };
      return;
    }
    if (wireEl) {
      const i = Number(wireEl.dataset.wire);
      this.select(e.shiftKey ? [...this.selection.comps] : [], [i]);
      this.gesture = { kind: 'none' };
      return;
    }
    // Background.
    if (e.shiftKey) this.gesture = { kind: 'marquee', start: world };
    else this.gesture = { kind: 'pan', client: { x: e.clientX, y: e.clientY }, view: { ...this.view.view }, moved: false };
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') { this.updatePinch(); return; }
    const world = this.view.toWorld(e.clientX, e.clientY);

    if (g.kind === 'pan') {
      const dx = e.clientX - g.client.x, dy = e.clientY - g.client.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) g.moved = true;
      if (g.moved) { this.view.setView(g.view.x + dx, g.view.y + dy, g.view.k); this.view.userMoved = true; this.svg.classList.add('panning'); }
    } else if (g.kind === 'move') {
      if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) <= DRAG_THRESHOLD) return;
      if (!g.moved) { g.moved = true; this.app.beginMove(); }
      const dx = snap(world.x - g.start.x), dy = snap(world.y - g.start.y);
      for (const it of g.items) { it.c.x = it.x + dx; it.c.y = it.y + dy; }
      this.app.liveRender();
    } else if (g.kind === 'wire') {
      const target = this.pinUnder(e.clientX, e.clientY);
      const b = target && target.side !== g.side ? target.pos : world;
      const pts = g.side === 'out' ? previewPoints(g.a, b) : previewPoints(b, g.a);
      this.view.setOverlay(`<path class="wire-preview ${target && target.side !== g.side ? 'ok' : ''}" d="${pathFor(pts)}"/>`);
    } else if (g.kind === 'marquee') {
      const x = Math.min(g.start.x, world.x), y = Math.min(g.start.y, world.y);
      const w = Math.abs(world.x - g.start.x), h = Math.abs(world.y - g.start.y);
      g.rect = { x, y, w, h };
      this.view.setOverlay(`<rect class="marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
    }
  }

  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g?.kind === 'pinch') { if (this.pointers.size < 2) this.gesture = null; return; }
    this.gesture = null;
    this.svg.classList.remove('panning');
    if (!g || cancelled) { this.view.setOverlay(''); return; }
    const world = this.view.toWorld(e.clientX, e.clientY);

    if (g.kind === 'place') {
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 12) {
        this.place(this.armed, world);
        if (!e.shiftKey) this.arm(null);
      }
    } else if (g.kind === 'pan') {
      if (!g.moved) this.select();
    } else if (g.kind === 'move') {
      if (g.comp.type === 'BUTTON') this.app.setInput(g.id, 0);
      if (g.moved) this.app.endMove();
      else if (g.comp.type === 'INPUT' && !e.shiftKey) this.app.toggleInput(g.id);
    } else if (g.kind === 'wire') {
      this.view.setOverlay('');
      const target = this.pinUnder(e.clientX, e.clientY);
      if (target && target.side !== g.side && target.id !== undefined) {
        const from = g.side === 'out' ? `${g.id}.${g.pin}` : `${target.id}.${target.pin}`;
        const to = g.side === 'out' ? `${target.id}.${target.pin}` : `${g.id}.${g.pin}`;
        this.app.commit((c) => {
          c.wires = c.wires.filter((w) => w.to !== to);  // one driver per input: replace
          c.wires.push({ from, to });
        });
      }
    } else if (g.kind === 'marquee') {
      this.view.setOverlay('');
      const r = g.rect;
      if (r) {
        const ids = this.app.circuit.components.filter((c) => {
          const b = this.view.geoms.get(c.id).box;
          return c.x + b.x >= r.x && c.y + b.y >= r.y && c.x + b.x + b.w <= r.x + r.w && c.y + b.y + b.h <= r.y + r.h;
        }).map((c) => c.id);
        this.select([...new Set([...this.selection.comps, ...ids])]);
      }
    }
  }

  /** Nearest pin within reach of a screen point (generous for touch). */
  pinUnder(clientX, clientY) {
    const w = this.view.toWorld(clientX, clientY);
    const reach = 14 / this.view.view.k;
    let best = null;
    for (const c of this.app.circuit.components) {
      const geo = this.view.geoms.get(c.id);
      if (!geo) continue;
      for (const [pin, p] of Object.entries(geo.pins)) {
        const pos = { x: c.x + p.x, y: c.y + p.y };
        const d = Math.hypot(pos.x - w.x, pos.y - w.y);
        if (d <= reach && (!best || d < best.d)) best = { id: c.id, pin, side: p.side, pos, d };
      }
    }
    return best;
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.view.setOverlay('');
    this.gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), k0: this.view.view.k, view: { ...this.view.view }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  updatePinch() {
    const g = this.gesture;
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.view.setView(g.view.x + mid.x - g.mid.x, g.view.y + mid.y - g.mid.y, g.view.k);
    this.view.zoomAt(mid.x, mid.y, (g.k0 * (d / g.d0)) / this.view.view.k);
  }

  /* ---------------- keyboard ---------------- */

  onKey(e) {
    if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) { e.preventDefault(); this.deleteSelection(); }
    else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.app.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.app.redo(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.select(this.app.circuit.components.map((c) => c.id)); }
    else if (e.key === 'Escape') { this.arm(null); this.select(); this.view.setOverlay(''); this.app.closeModals?.(); }
    else if (e.key === ' ' && !mod) { e.preventDefault(); this.app.toggleRun(); }
    else if (e.key === '.' || e.key === 'ArrowRight') { e.preventDefault(); this.app.stepOnce(); }
    else if (e.key.toLowerCase() === 'f' && !mod) { this.view.fit(); }
  }
}

