// pad.js — the drawing pad. Pointer events cover mouse, touch and pen with one
// code path; strokes are stored as point lists so Undo can drop the last one
// and everything is re-rendered from data.
//
// Two renderings of the same strokes:
//   * the visible canvas, styled for the theme (ink colour, soft glow)
//   * an offscreen "ink" canvas: plain opaque strokes, no effects, whose
//     alpha channel is the ink map fed to the preprocessing pipeline — so the
//     look of the pad can change without changing what the network sees.

export class DrawingPad {
  constructor(canvas, { lineWidth = 28, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lineWidth = lineWidth;
    this.onChange = onChange;
    this.strokes = [];
    this.current = null;
    this.image = null; // a 28×28 test sample shown instead of strokes
    this.ink = document.createElement('canvas');
    this.ink.width = canvas.width;
    this.ink.height = canvas.height;
    this.inkCtx = this.ink.getContext('2d', { willReadFrequently: true });

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('lostpointercapture', (e) => this.up(e));
  }

  get isEmpty() { return this.strokes.length === 0 && !this.current; }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (this.canvas.width / r.width), (e.clientY - r.top) * (this.canvas.height / r.height)];
  }

  down(e) {
    if (e.button !== undefined && e.button > 0) return; // left button / touch / pen tip only
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    if (this.image) { this.image = null; this.strokes = []; }
    this.current = { id: e.pointerId, pts: [this.pos(e)] };
    this.strokes.push(this.current.pts);
    this.render();
    this.onChange('start');
  }

  move(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    // Coalesced events give every sample the hardware reported between frames
    // (pens report at 240 Hz+), which keeps fast strokes smooth.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = this.pos(ev);
      const last = this.current.pts[this.current.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) this.current.pts.push(p);
    }
    this.render();
    this.onChange('draw');
  }

  up(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    this.current = null;
    this.onChange('end');
  }

  undo() {
    if (this.image) { this.clear(); return; }
    this.strokes.pop();
    this.render();
    this.onChange('undo');
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.image = null;
    this.render();
    this.onChange('clear');
  }

  /** Show an MNIST sample (Uint8Array of 784) on the pad. */
  showImage(pixels) {
    this.strokes = [];
    this.current = null;
    this.image = pixels;
    this.render();
  }

  // Smooth curve through the points: quadratic segments between midpoints.
  tracePath(ctx, pts) {
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(pts[0][0], pts[0][1], this.lineWidth / 2, 0, 2 * Math.PI);
      ctx.fill();
      return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }

  drawStrokes(ctx, color, glow) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.lineWidth;
    ctx.strokeStyle = ctx.fillStyle = color;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 14; }
    for (const s of this.strokes) this.tracePath(ctx, s);
    ctx.restore();
  }

  render() {
    const { ctx, canvas } = this;
    const css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.image) {
      // Upscale the 28×28 sample with smoothing, tinted with the ink colour.
      const small = document.createElement('canvas');
      small.width = small.height = 28;
      const sctx = small.getContext('2d');
      const img = sctx.createImageData(28, 28);
      const ink = hexToRgb(css.getPropertyValue('--lcd-ink').trim() || '#e8f0ea');
      for (let i = 0; i < 784; i++) {
        img.data[4 * i] = ink[0]; img.data[4 * i + 1] = ink[1]; img.data[4 * i + 2] = ink[2];
        img.data[4 * i + 3] = this.image[i];
      }
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
      return;
    }
    const dark = (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
    this.drawStrokes(ctx, css.getPropertyValue('--lcd-ink').trim() || '#e8f0ea', dark ? 'rgba(62,224,143,0.45)' : null);
  }

  /** Ink map 0..1 (alpha of the plain offscreen rendering). */
  getInk() {
    const { inkCtx, ink } = this;
    inkCtx.clearRect(0, 0, ink.width, ink.height);
    this.drawStrokes(inkCtx, '#000', null);
    const rgba = inkCtx.getImageData(0, 0, ink.width, ink.height).data;
    const out = new Float32Array(ink.width * ink.height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[4 * i + 3] / 255;
    return out;
  }
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
