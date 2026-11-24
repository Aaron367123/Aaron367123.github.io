/**
 * plot.js - small canvas line-plot used for the scrolling live charts and the compare
 * overlay. HiDPI aware, theme colours passed in per draw, autoscale that expands
 * immediately and shrinks smoothly (so the axis doesn't jitter with noise).
 */

/** "Nice" tick step (1, 2, 2.5, 5 x 10^n) for roughly `count` ticks over `span`. */
export function niceStep(span, count = 5) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const m = n < 1.5 ? 1 : n < 2.25 ? 2 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10;
  return m * mag;
}

function fmtTick(v, step) {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const s = v.toFixed(Math.min(d + (step / 10 ** Math.floor(Math.log10(step)) === 2.5 ? 1 : 0), 4));
  return s === '-0' ? '0' : s;
}

export class Plot {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [o] { padL, padR, padT, padB, minSpan }
   */
  constructor(canvas, o = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = { padL: 48, padR: 12, padT: 24, padB: 22, ...o };
    this.lo = null; this.hi = null;
    this.w = 0; this.h = 0;
    this.resize();
    this.onResize = null;          // set by the app to repaint immediately after a resize
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { if (this.resize()) this.onResize?.(); }).observe(canvas);
    }
  }

  /** Match the backing store to the CSS size. Assigning canvas.width clears the bitmap,
   *  so only do it when the size really changed, and flag the plot for a redraw. */
  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, r.width), h = Math.max(10, r.height);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (pw === this.c.width && ph === this.c.height && w === this.w && h === this.h) return false;
    this.w = w; this.h = h;
    this.c.width = pw; this.c.height = ph;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
    return true;
  }

  resetScale() { this.lo = this.hi = null; }

  /** Autoscale: expand at once, contract 12 % of the way per frame. */
  scale(lo, hi, minSpan) {
    if (!(hi > lo)) { hi = lo + (minSpan || 1); }
    const span = Math.max(hi - lo, minSpan || 0);
    const mid = (hi + lo) / 2;
    lo = mid - span / 2 - span * 0.08; hi = mid + span / 2 + span * 0.08;
    if (this.lo === null || lo < this.lo || hi > this.hi) {
      this.lo = this.lo === null ? lo : Math.min(lo, this.lo);
      this.hi = this.hi === null ? hi : Math.max(hi, this.hi);
    }
    this.lo += (lo - this.lo) * 0.12;
    this.hi += (hi - this.hi) * 0.12;
    return [this.lo, this.hi];
  }

  /**
   * @param {object} d
   * @param {number} d.x0, d.x1 x range (seconds)
   * @param {number[]} d.y y range [lo, hi]
   * @param {object} d.pal colours {grid, text, faint, border}
   * @param {Array} d.series [{x, y, from, to, color, width, dash, step, alpha, satMask, satColor}]
   * @param {Array} [d.bands] [{y0, y1, color, x0?}] horizontal shaded bands
   * @param {Array} [d.hlines] [{y, color, dash, label}]
   * @param {string} [d.xUnit='s']
   */
  draw(d) {
    const { ctx, w, h } = this;
    const { padL, padR, padT, padB } = this.o;
    const pw = w - padL - padR, ph = h - padT - padB;
    const [ylo, yhi] = d.y;
    this.dirty = false;
    const X = (x) => padL + ((x - d.x0) / (d.x1 - d.x0)) * pw;
    const Y = (y) => padT + (1 - (y - ylo) / (yhi - ylo)) * ph;
    ctx.clearRect(0, 0, w, h);

    // grid + ticks
    ctx.font = '10px ui-monospace, "IBM Plex Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const ys = niceStep(yhi - ylo, Math.max(2, Math.round(ph / 42)));
    ctx.strokeStyle = d.pal.grid; ctx.fillStyle = d.pal.faint;
    ctx.textAlign = 'right';
    for (let v = Math.ceil(ylo / ys) * ys; v <= yhi + 1e-9; v += ys) {
      const py = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.fillText(fmtTick(v, ys), padL - 6, py);
    }
    const xs = niceStep(d.x1 - d.x0, Math.max(2, Math.round(pw / 90)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(d.x0 / xs) * xs; v <= d.x1 + 1e-9; v += xs) {
      const px = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, h - padB); ctx.stroke();
      ctx.fillText(fmtTick(v, xs) + (d.xUnit ?? 's'), px, h - padB + 5);
    }
    ctx.strokeStyle = d.pal.border;
    ctx.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1);

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    for (const b of d.bands || []) {
      ctx.fillStyle = b.color;
      const y0 = Y(Math.max(b.y0, ylo)), y1 = Y(Math.min(b.y1, yhi));
      const bx = b.x0 !== undefined ? Math.max(padL, X(b.x0)) : padL;   // optional start time
      ctx.fillRect(bx, Math.min(y0, y1), padL + pw - bx, Math.abs(y1 - y0));
    }
    for (const l of d.hlines || []) {
      ctx.strokeStyle = l.color; ctx.setLineDash(l.dash || [4, 4]);
      const py = Math.round(Y(l.y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.setLineDash([]);
      if (l.label) {
        ctx.fillStyle = l.color; ctx.textAlign = 'left'; ctx.textBaseline = l.below ? 'top' : 'bottom';
        ctx.fillText(l.label, padL + 4, py + (l.below ? 3 : -2));
      }
    }
    for (const s of d.series) this.line(s, X, Y);
    ctx.restore();
  }

  line(s, X, Y) {
    const { ctx } = this;
    const from = s.from ?? 0, to = s.to ?? s.x.length;
    if (to - from < 1) return;
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.lineWidth = s.width ?? 1.6;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash || []);
    // Decimate to ~2 points per pixel column for long series.
    const n = to - from;
    const stride = Math.max(1, Math.floor(n / (this.w * 2)));
    const path = (mask) => {
      ctx.beginPath();
      let pen = false, prevY = 0;
      for (let i = from; i < to; i += stride) {
        if (mask && !mask[i]) { pen = false; continue; }
        const px = X(s.x[i]), py = Y(s.y[i]);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else {
          if (s.step) ctx.lineTo(px, prevY);
          ctx.lineTo(px, py);
        }
        prevY = py;
      }
      ctx.stroke();
    };
    ctx.strokeStyle = s.color;
    path(null);
    if (s.satMask) {                       // overdraw saturated samples
      ctx.strokeStyle = s.satColor; ctx.lineWidth = (s.width ?? 1.6) + 1.2;
      path(s.satMask);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}
