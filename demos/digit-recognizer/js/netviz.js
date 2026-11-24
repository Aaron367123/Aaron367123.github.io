// netviz.js — draws the network as a circuit board: the input as a 28×28 LED
// matrix, each hidden layer as a column of pads (neurons) whose glow is the
// neuron's activation, and the 10 outputs. Copper traces light up along the
// strongest contributions to the predicted digit:
//
//   output p  ←  hidden-2 unit j   weight of the trace ∝ a₂[j] · W₃[j, p]
//   hidden-2 j ← hidden-1 unit i   weight of the trace ∝ a₁[i] · W₂[i, j]
//
// i.e. how much each neuron actually pushed the winning logit up for this
// particular input — not just how big the weight is.

const SHOW = 32; // neurons displayed per hidden layer

export class NetViz {
  constructor(canvas, net) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dense = net.layers.filter((l) => l.type === 'dense');
    const [, d1, d2] = this.dense;
    // Show the most influential units: largest L2 norm of outgoing weights.
    this.show1 = topByRowNorm(d1.W, d1.inSize, d1.outSize, SHOW);
    this.show2 = topByRowNorm(d2.W, d2.inSize, d2.outSize, SHOW);
    this.sizes = this.dense.map((d) => d.outSize);
    this.target = null;      // latest activations
    this.shown = { a1: new Float32Array(SHOW), a2: new Float32Array(SHOW), p: new Float32Array(10) };
    this.input = new Float32Array(784);
    this.inputShown = new Float32Array(784);
    this.traces = [];
    this.pred = -1;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.readColors();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    this.c = {
      bg: v('--bg-alt'), surface2: v('--surface-2'), border: v('--border'), borderStrong: v('--border-strong'),
      text: v('--text'), muted: v('--muted'), faint: v('--faint'), copper: v('--copper'),
      copperBright: v('--copper-bright'), led: v('--led'), signal: v('--signal'),
      dark: (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark',
    };
    this.dirty = true;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
    this.dirty = true;
  }

  layout() {
    const { w, h } = this;
    const narrow = w < 560;
    const top = 30, bottom = h - 14;
    const grid = Math.min(narrow ? 0.22 * w : 0.17 * w, h * 0.5, 170);
    this.grid = { x: 8, y: (top + bottom) / 2 - grid / 2, size: grid };
    const x1 = grid + 16 + (w - grid) * (narrow ? 0.2 : 0.22);
    const x2 = grid + 16 + (w - grid) * (narrow ? 0.52 : 0.55);
    const x3 = w - (narrow ? 46 : 92);
    const col = (x, n) => Array.from({ length: n }, (_, i) => ({ x, y: top + ((bottom - top) * (i + 0.5)) / n }));
    this.pos1 = col(x1, SHOW);
    this.pos2 = col(x2, SHOW);
    const outTop = top + (bottom - top) * 0.08, outBottom = bottom - (bottom - top) * 0.08;
    this.pos3 = Array.from({ length: 10 }, (_, i) => ({ x: x3, y: outTop + ((outBottom - outTop) * (i + 0.5)) / 10 }));
    this.r1 = Math.max(2.5, Math.min(6, ((bottom - top) / SHOW) * 0.42));
    this.r3 = Math.max(6, Math.min(11, ((outBottom - outTop) / 10) * 0.3));
    this.labels = [
      { x: grid / 2 + 8, t: 'INPUT 784' },
      { x: x1, t: narrow ? 'H1 256' : 'HIDDEN 1 · 256' },
      { x: x2, t: narrow ? 'H2 128' : 'HIDDEN 2 · 128' },
      { x: x3, t: 'OUTPUT' },
    ];
  }

  /** @param trace result of net.trace(); input the 784 floats fed in (or null to idle) */
  update(trace, input) {
    if (!trace) {
      this.target = null;
      this.traces = [];
      this.pred = -1;
      this.input.fill(0);
      this.dirty = true;
      return;
    }
    const acts = trace.activations; // dense, relu, dense, relu, dense
    const a1 = acts[1].values, a2 = acts[3].values, p = trace.probs;
    const [, d1, d2] = this.dense;
    const pred = argmaxArr(p);
    const t1 = norm(this.show1.map((i) => a1[i]), maxOf(a1));
    const t2 = norm(this.show2.map((j) => a2[j]), maxOf(a2));
    this.target = { a1: t1, a2: t2, p: Float32Array.from(p) };
    this.input.set(input);
    this.pred = pred;

    // --- traces: hidden-2 → output, hidden-1 → hidden-2, input → hidden-1
    const traces = [];
    const c2 = this.show2.map((j, s) => ({ s, v: a2[j] * d2.W[j * 10 + pred] })).filter((c) => c.v > 0).sort((a, b) => b.v - a.v).slice(0, 9);
    const max2 = c2[0]?.v || 1;
    for (const c of c2) traces.push({ from: this.pos2[c.s], to: this.pos3[pred], k: c.v / max2, layer: 2 });
    const hot1 = new Set();
    for (const c of c2.slice(0, 6)) {
      const j = this.show2[c.s];
      const c1 = this.show1.map((i, s) => ({ s, v: a1[i] * d1.W[i * d1.outSize + j] })).filter((q) => q.v > 0).sort((a, b) => b.v - a.v).slice(0, 3);
      const m1 = c1[0]?.v || 1;
      for (const q of c1) { traces.push({ from: this.pos1[q.s], to: this.pos2[c.s], k: (q.v / m1) * (0.4 + 0.6 * c.v / max2), layer: 1 }); hot1.add(q.s); }
    }
    for (const s of hot1) {
      const g = this.grid;
      const k = t1[s];
      traces.push({ from: { x: g.x + g.size, y: g.y + g.size * (0.15 + 0.7 * ((s + 0.5) / SHOW)) }, to: this.pos1[s], k: 0.35 + 0.65 * k, layer: 0 });
    }
    this.traces = traces;
    this.dirty = true;
  }

  loop(now) {
    // Ease displayed activations toward their targets (≈120 ms), so the
    // network visibly "settles" as you draw.
    const s = this.shown;
    let moving = false;
    const ease = (cur, tgt) => {
      for (let i = 0; i < cur.length; i++) {
        const t = tgt ? tgt[i] : 0;
        const d = t - cur[i];
        if (Math.abs(d) > 0.002) { cur[i] += d * (this.reduceMotion ? 1 : 0.25); moving = true; } else cur[i] = t;
      }
    };
    ease(s.a1, this.target?.a1);
    ease(s.a2, this.target?.a2);
    ease(s.p, this.target?.p);
    ease(this.inputShown, this.input);
    const flowing = this.traces.length > 0 && !this.reduceMotion && !document.hidden;
    if (moving || flowing || this.dirty) this.draw(now);
    this.dirty = false;
    requestAnimationFrame(this.loop);
  }

  draw(now = 0) {
    const { ctx, w, h, c } = this;
    ctx.clearRect(0, 0, w, h);

    // layer labels (silkscreen)
    ctx.font = '600 10px ui-monospace, "IBM Plex Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = c.faint;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px'; // ≈ .12em silkscreen spacing
    for (const l of this.labels) ctx.fillText(l.t, l.x, 14);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // idle bus lines: each neuron has a short stub into a vertical bus
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    for (const col of [this.pos1, this.pos2]) {
      const bx = col[0].x + 16;
      ctx.beginPath();
      ctx.moveTo(bx, col[0].y); ctx.lineTo(bx, col[col.length - 1].y);
      for (const p of col) { ctx.moveTo(p.x, p.y); ctx.lineTo(bx, p.y); }
      ctx.stroke();
    }
    ctx.beginPath();
    const ob = this.pos3[0].x - 18;
    ctx.moveTo(ob, this.pos3[0].y); ctx.lineTo(ob, this.pos3[9].y);
    for (const p of this.pos3) { ctx.moveTo(ob, p.y); ctx.lineTo(p.x, p.y); }
    ctx.stroke();

    // active traces
    for (const t of this.traces) {
      ctx.lineWidth = 1 + 1.6 * t.k;
      ctx.strokeStyle = withAlpha(t.layer === 2 ? c.led : c.copper, 0.25 + 0.6 * t.k);
      pcbPath(ctx, t.from, t.to);
      ctx.stroke();
      if (!this.reduceMotion) {
        // current flowing along the trace
        ctx.save();
        ctx.setLineDash([3, 13]);
        ctx.lineDashOffset = -now / 28;
        ctx.strokeStyle = withAlpha(c.dark ? '#ffffff' : c.led, (c.dark ? 0.55 : 0.8) * t.k);
        ctx.lineWidth = 1.2 + t.k;
        pcbPath(ctx, t.from, t.to);
        ctx.stroke();
        ctx.restore();
      }
    }

    this.drawInput();
    this.drawColumn(this.pos1, this.shown.a1, this.r1);
    this.drawColumn(this.pos2, this.shown.a2, this.r1);
    this.drawOutputs();
  }

  drawInput() {
    const { ctx, c, grid: g } = this;
    const cell = g.size / 28;
    ctx.fillStyle = c.bg;
    roundRect(ctx, g.x - 3, g.y - 3, g.size + 6, g.size + 6, 5);
    ctx.fill();
    ctx.strokeStyle = c.borderStrong;
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let y = 0; y < 28; y++) {
      for (let x = 0; x < 28; x++) {
        const v = this.inputShown[y * 28 + x];
        if (v < 0.02) continue;
        ctx.fillStyle = withAlpha(c.led, Math.min(1, v));
        ctx.fillRect(g.x + x * cell + 0.3, g.y + y * cell + 0.3, cell - 0.6, cell - 0.6);
      }
    }
  }

  drawColumn(pos, acts, r) {
    const { ctx, c } = this;
    for (let i = 0; i < pos.length; i++) {
      const a = acts[i];
      const { x, y } = pos[i];
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, 2 * Math.PI);
      ctx.fillStyle = c.surface2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = a > 0.05 ? withAlpha(c.copper, 0.4 + 0.6 * a) : c.borderStrong;
      ctx.stroke();
      if (a > 0.02) {
        ctx.save();
        if (c.dark && a > 0.3) { ctx.shadowColor = c.led; ctx.shadowBlur = 10 * a; }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = withAlpha(c.led, 0.15 + 0.85 * a);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  drawOutputs() {
    const { ctx, c, r3 } = this;
    ctx.font = '600 12px ui-monospace, "IBM Plex Mono", Consolas, monospace';
    for (let d = 0; d < 10; d++) {
      const { x, y } = this.pos3[d];
      const p = this.shown.p[d];
      const win = d === this.pred;
      ctx.beginPath();
      ctx.arc(x, y, r3 + 2, 0, 2 * Math.PI);
      ctx.fillStyle = c.surface2;
      ctx.fill();
      ctx.lineWidth = win ? 2 : 1;
      ctx.strokeStyle = win ? c.led : c.borderStrong;
      ctx.stroke();
      if (p > 0.01) {
        ctx.save();
        if (c.dark && win) { ctx.shadowColor = c.led; ctx.shadowBlur = 18; }
        ctx.beginPath();
        ctx.arc(x, y, r3 * (0.35 + 0.65 * Math.sqrt(p)), 0, 2 * Math.PI);
        ctx.fillStyle = withAlpha(c.led, 0.25 + 0.75 * p);
        ctx.fill();
        ctx.restore();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = win ? c.led : c.muted;
      ctx.fillText(String(d), x + r3 + 8, y + 4);
      if (this.w >= 560) {
        ctx.fillStyle = win ? c.text : c.faint;
        ctx.font = '500 11px ui-monospace, "IBM Plex Mono", Consolas, monospace';
        ctx.fillText(this.pred < 0 ? '' : `${(100 * p).toFixed(p >= 0.995 ? 0 : 1)}%`, x + r3 + 24, y + 4);
        ctx.font = '600 12px ui-monospace, "IBM Plex Mono", Consolas, monospace';
      }
    }
  }
}

// PCB-style trace: horizontal, a 45° diagonal, horizontal again.
function pcbPath(ctx, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ady = Math.abs(dy);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  if (ady < dx * 0.8) {
    const mid = a.x + dx / 2;
    ctx.lineTo(mid - ady / 2, a.y);
    ctx.lineTo(mid + ady / 2, b.y);
  } else {
    // too steep for 45°: go out a little, then straight there
    ctx.lineTo(a.x + dx * 0.1, a.y);
    ctx.lineTo(b.x - dx * 0.1, b.y);
  }
  ctx.lineTo(b.x, b.y);
}

function topByRowNorm(W, rows, cols, n) {
  const norms = [];
  for (let r = 0; r < rows; r++) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += W[r * cols + c] ** 2;
    norms.push({ r, s });
  }
  return norms.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.r).sort((a, b) => a - b);
}

const argmaxArr = (v) => v.reduce((b, x, i) => (x > v[b] ? i : b), 0);
const maxOf = (v) => v.reduce((m, x) => (x > m ? x : m), 0) || 1;
// normalise by the layer's max, then sqrt so mid-level activations stay visible
const norm = (vals, max) => Float32Array.from(vals, (v) => Math.sqrt(Math.min(1, Math.max(0, v) / max)));

function withAlpha(color, a) {
  const alpha = Math.max(0, Math.min(1, a));
  if (color.startsWith('#')) {
    const h = color.length === 4 ? color.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : color;
    return `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${alpha})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) { const [r, g, b] = m[1].split(',').map((s) => s.trim()); return `rgba(${r},${g},${b},${alpha})`; }
  return color;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
