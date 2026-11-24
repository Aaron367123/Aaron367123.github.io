/**
 * Timing diagram: a scrolling waveform of selected signals, drawn on a
 * canvas from the simulator's recorded change history (sim.watch/history).
 */
import { byPosition, nameOf, X } from '../engine/index.js';

const WATCHABLE = ['CLOCK', 'INPUT', 'BUTTON', 'PROBE', 'OUTPUT'];
const ROW_H = 28;
const AXIS_H = 20;
const LABEL_W = 78;

export class TimingPanel {
  constructor(root) {
    this.root = root;
    this.list = root.querySelector('.timing-signals');
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.pxPerTick = 8;
    this.selected = null;       // Set of component ids, null = use defaults
    root.querySelector('[data-zoom="in"]').addEventListener('click', () => { this.pxPerTick = Math.min(32, this.pxPerTick * 1.5); this.draw(); });
    root.querySelector('[data-zoom="out"]').addEventListener('click', () => { this.pxPerTick = Math.max(2, this.pxPerTick / 1.5); this.draw(); });
  }

  get visible() { return !this.root.hidden; }

  /** New simulator or circuit: rebuild the signal list and start watching. */
  setSim(sim, circuit) {
    this.sim = sim;
    this.candidates = [...circuit.components].filter((c) => WATCHABLE.includes(c.type)).sort((a, b) =>
      WATCHABLE.indexOf(a.type) - WATCHABLE.indexOf(b.type) || byPosition(a, b));
    const ids = new Set(this.candidates.map((c) => c.id));
    if (!this.selected || ![...this.selected].some((id) => ids.has(id))) {
      // Default: clocks, switches, probes and LEDs (in that order), at most 8; momentary buttons only if room.
      const pick = [...this.candidates.filter((c) => c.type !== 'BUTTON'), ...this.candidates.filter((c) => c.type === 'BUTTON')].slice(0, 8);
      this.selected = new Set(pick.map((c) => c.id));
    }
    this.list.replaceChildren(...this.candidates.map((c) => {
      const lab = document.createElement('label');
      lab.className = 'sig';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.selected.has(c.id);
      cb.addEventListener('change', () => {
        cb.checked ? this.selected.add(c.id) : this.selected.delete(c.id);
        this.watchSelected();
        this.draw();
      });
      lab.append(cb, document.createTextNode(nameOf(c)));
      return lab;
    }));
    this.watchSelected();
  }

  watchSelected() {
    if (!this.sim) return;
    for (const id of this.selected) {
      try { this.sim.watch(id); } catch { /* not watchable */ }
    }
  }

  rows() {
    return this.candidates.filter((c) => this.selected.has(c.id));
  }

  draw() {
    if (!this.visible || !this.sim) return;
    const rows = this.rows();
    const cssW = this.canvas.clientWidth || 600;
    const cssH = AXIS_H + Math.max(1, rows.length) * ROW_H + 6;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.height = `${cssH}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const C = { bg: col('--bg-alt'), text: col('--muted'), faint: col('--faint'), grid: col('--border'), hi: col('--led'), lo: col('--copper'), x: col('--danger') };
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const plotW = cssW - LABEL_W - 8;
    const span = Math.max(8, Math.floor(plotW / this.pxPerTick));
    const tEnd = this.sim.time;
    const t0 = Math.max(0, tEnd - span);
    const xOf = (t) => LABEL_W + (t - t0) * this.pxPerTick;

    // Time axis + grid every 10 ticks.
    ctx.font = '10px ui-monospace, "IBM Plex Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    const step = this.pxPerTick >= 6 ? 10 : this.pxPerTick >= 3 ? 20 : 50;
    for (let t = Math.ceil(t0 / step) * step; t <= tEnd; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, AXIS_H - 4); ctx.lineTo(x, cssH); ctx.stroke();
      ctx.fillStyle = C.faint;
      ctx.textAlign = 'center';
      ctx.fillText(String(t), x, AXIS_H / 2);
    }

    rows.forEach((c, r) => {
      const top = AXIS_H + r * ROW_H;
      const hiY = top + 6, loY = top + ROW_H - 6;
      ctx.fillStyle = C.text;
      ctx.textAlign = 'left';
      ctx.fillText(nameOf(c).toUpperCase().slice(0, 9), 8, top + ROW_H / 2);
      let hist;
      try { hist = this.sim.history(c.id); } catch { return; }
      // Value at the left edge, then every change inside the window.
      let v = X, i = 0;
      while (i < hist.length && hist[i][0] <= t0) v = hist[i++][1];
      const segs = [];
      let start = t0;
      for (; i < hist.length; i++) {
        const [t, nv] = hist[i];
        if (t > tEnd) break;
        if (nv === v) continue;
        segs.push([start, t, v]); start = t; v = nv;
      }
      segs.push([start, tEnd, v]);

      ctx.lineWidth = 1.6;
      let prevY = null;
      for (const [a, b, val] of segs) {
        const xa = xOf(a), xb = xOf(b);
        if (val === X) {
          ctx.fillStyle = C.x + '33';
          ctx.fillRect(xa, hiY, xb - xa, loY - hiY);
          // Diagonal hatching, clipped to the X band.
          const h = loY - hiY;
          ctx.save();
          ctx.beginPath(); ctx.rect(xa, hiY, xb - xa, h); ctx.clip();
          ctx.strokeStyle = C.x;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          for (let hx = xa - h; hx < xb; hx += 6) { ctx.moveTo(hx, loY); ctx.lineTo(hx + h, hiY); }
          ctx.stroke();
          ctx.restore();
          prevY = null;
          continue;
        }
        const y = val === 1 ? hiY : loY;
        if (val === 1) { ctx.fillStyle = C.hi + '22'; ctx.fillRect(xa, hiY, xb - xa, loY - hiY); }
        ctx.strokeStyle = val === 1 ? C.hi : C.lo;
        ctx.beginPath();
        if (prevY !== null && prevY !== y) { ctx.moveTo(xa, prevY); ctx.lineTo(xa, y); } else ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        prevY = y;
      }
    });
    if (!rows.length) {
      ctx.fillStyle = C.faint;
      ctx.textAlign = 'left';
      ctx.fillText('Pick signals on the left (switches, clocks, LEDs, probes).', LABEL_W, AXIS_H + ROW_H / 2);
    }
  }
}
