/**
 * visuals.js - small animated drawings of each plant on a canvas.
 * Pure drawing: every function gets the current plant state and the theme palette.
 *
 * s = { def, x (state vector), y, sp, u, d (disturbance value), phi (visual angle), t }
 */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function label(ctx, text, x, y, color, align = 'left', size = 10) {
  ctx.font = `${size}px ui-monospace, "IBM Plex Mono", Consolas, monospace`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* -------- DC motor: body + shaft + disc with a marker ------------------------------ */
function motor(ctx, w, h, s, pal, position) {
  const cy = h / 2 + 4;
  const r = Math.min(h * 0.36, w * 0.24);
  const cx = w * 0.62;
  // motor body
  const bw = w * 0.26, bh = r * 1.15;
  const bx = cx - r - bw - 14;
  roundRect(ctx, bx, cy - bh / 2, bw, bh, 6);
  ctx.fillStyle = pal.surface2; ctx.fill(); ctx.strokeStyle = pal.borderStrong; ctx.stroke();
  for (let i = 1; i < 7; i++) {           // copper windings
    ctx.strokeStyle = pal.copper; ctx.globalAlpha = 0.35 + 0.65 * clamp(Math.abs(s.u) / 12, 0, 1);
    ctx.beginPath(); ctx.moveTo(bx + (bw * i) / 7, cy - bh / 2 + 5); ctx.lineTo(bx + (bw * i) / 7, cy + bh / 2 - 5); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.faint; ctx.fillRect(bx + bw, cy - 3, cx - bx - bw, 6);   // shaft
  label(ctx, `${s.u >= 0 ? '+' : ''}${s.u.toFixed(1)} V`, bx + bw / 2, cy + bh / 2 + 12, pal.copperBright, 'center');

  // disc
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = pal.surface2; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = pal.borderStrong; ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i < 36; i++) {          // encoder ticks
    const a = (i / 36) * TAU;
    ctx.strokeStyle = i % 9 === 0 ? pal.muted : pal.border;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
    ctx.lineTo(cx + Math.cos(a) * r * 0.98, cy + Math.sin(a) * r * 0.98); ctx.stroke();
  }
  const ang = position ? -s.y : -s.phi;    // screen y points down: negate for CCW-positive
  if (position) {                          // setpoint ghost marker
    const a = -s.sp;
    ctx.strokeStyle = pal.signal; ctx.setLineDash([4, 3]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = pal.led; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * r * 0.8, cy + Math.sin(ang) * r * 0.8); ctx.stroke();
  ctx.lineCap = 'butt'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * r * 0.8, cy + Math.sin(ang) * r * 0.8, 4, 0, TAU);
  ctx.fillStyle = pal.led; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, TAU); ctx.fillStyle = pal.copper; ctx.fill();

  if (s.d) {                               // load torque brake pad
    ctx.fillStyle = pal.danger; ctx.globalAlpha = 0.8;
    ctx.fillRect(cx + r + 4, cy - 12, 8, 24); ctx.globalAlpha = 1;
    label(ctx, 'LOAD', cx + r + 8, cy - 22, pal.danger, 'center');
  }
  if (position) {
    label(ctx, `θ ${(s.y * 180 / Math.PI).toFixed(1)}°`, 10, 16, pal.led);
    label(ctx, `SP ${(s.sp * 180 / Math.PI).toFixed(1)}°`, 10, 30, pal.signal);
  } else {
    label(ctx, `${(s.y * 60 / TAU).toFixed(0)} rpm`, 10, 16, pal.led);
    label(ctx, 'disc drawn at 1/20 speed', 10, h - 12, pal.faint, 'left', 9);
  }
}

/* -------- Quadcopter on an altitude scale ------------------------------------------ */
function drone(ctx, w, h, s, pal) {
  const top = 16, bottom = h - 30, x0 = 40;
  const zMax = 10;
  const Y = (z) => bottom - (clamp(z, 0, zMax * 1.05) / zMax) * (bottom - top);
  // scale
  for (let z = 0; z <= zMax; z += 2) {
    ctx.strokeStyle = pal.border; ctx.beginPath(); ctx.moveTo(x0, Y(z) + 0.5); ctx.lineTo(w - 10, Y(z) + 0.5); ctx.stroke();
    label(ctx, `${z} m`, x0 - 6, Y(z) - (z === 0 ? 6 : 0), pal.faint, 'right');
  }
  ctx.fillStyle = pal.surface2; ctx.fillRect(0, bottom, w, h - bottom);        // ground
  ctx.strokeStyle = pal.borderStrong; ctx.beginPath(); ctx.moveTo(0, bottom + 0.5); ctx.lineTo(w, bottom + 0.5); ctx.stroke();
  // setpoint
  ctx.strokeStyle = pal.signal; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(x0, Y(s.sp) + 0.5); ctx.lineTo(w - 10, Y(s.sp) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  label(ctx, 'SP', w - 12, Y(s.sp) - 8, pal.signal, 'right');

  const cx = x0 + (w - x0) * 0.5, cy = Y(s.y) - 12;
  const thrust = s.x[2] / 20;              // actual rotor thrust, 0..1
  // arms + body
  ctx.strokeStyle = pal.muted; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx - 34, cy); ctx.lineTo(cx + 34, cy); ctx.stroke(); ctx.lineWidth = 1;
  roundRect(ctx, cx - 13, cy - 6, 26, 12, 4); ctx.fillStyle = pal.surface2; ctx.fill();
  ctx.strokeStyle = pal.copper; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, TAU); ctx.fillStyle = pal.led; ctx.fill();
  // rotors: blurred ellipses, wider and brighter with thrust
  for (const sx of [-34, 34]) {
    const rw = 10 + 10 * thrust;
    ctx.globalAlpha = 0.25 + 0.6 * thrust;
    ctx.fillStyle = pal.copperBright;
    ctx.beginPath(); ctx.ellipse(cx + sx, cy - 6, rw, 2.5, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.muted; ctx.fillRect(cx + sx - 1, cy - 6, 2, 6);
  }
  // downwash
  if (thrust > 0.05) {
    ctx.strokeStyle = pal.signal; ctx.globalAlpha = 0.25 * thrust + 0.1;
    for (const sx of [-34, 34]) for (let k = 0; k < 3; k++) {
      const off = ((s.t * 40 + k * 8) % 24);
      ctx.beginPath(); ctx.moveTo(cx + sx - 6 + k * 6, cy + 2 + off); ctx.lineTo(cx + sx - 6 + k * 6, cy + 8 + off); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (s.d) {                               // down-draft arrows
    ctx.strokeStyle = pal.danger; ctx.fillStyle = pal.danger;
    for (const sx of [-60, 0, 60]) {
      const ax = cx + sx, ay = cy - 40 + ((s.t * 30) % 12);
      ctx.beginPath(); ctx.moveTo(ax, ay - 12); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax - 4, ay - 4); ctx.lineTo(ax, ay + 2); ctx.lineTo(ax + 4, ay - 4); ctx.fill();
    }
  }
  label(ctx, `${s.y.toFixed(2)} m`, cx + 46, cy, pal.led);
  label(ctx, `thrust ${s.x[2].toFixed(1)} N`, x0, h - 14, pal.copperBright);
}

/* -------- Heater block with glow ---------------------------------------------------- */
function heaterColor(T, pal) {
  // 20 C -> steel, 60 C -> copper, 100 C -> hot red
  const f = clamp((T - 20) / 80, 0, 1);
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const c0 = [70, 88, 80], c1 = [224, 164, 88], c2 = [255, 107, 94];
  const [a, b, t] = f < 0.5 ? [c0, c1, f * 2] : [c1, c2, (f - 0.5) * 2];
  return `rgb(${lerp(a[0], b[0], t)},${lerp(a[1], b[1], t)},${lerp(a[2], b[2], t)})`;
}

function heater(ctx, w, h, s, pal) {
  const T = s.y;
  const bx = w * 0.14, by = 28, bw = w * 0.5, bh = h * 0.46;
  const col = heaterColor(T, pal);
  // glow
  const g = ctx.createRadialGradient(bx + bw / 2, by + bh / 2, 10, bx + bw / 2, by + bh / 2, bw * 0.9);
  g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.18 + 0.5 * clamp((T - 20) / 80, 0, 1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w * 0.8, h); ctx.globalAlpha = 1;
  // block
  roundRect(ctx, bx, by, bw, bh, 6); ctx.fillStyle = col; ctx.fill();
  ctx.strokeStyle = pal.borderStrong; ctx.stroke();
  for (let i = 1; i < 6; i++) {           // fins
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.moveTo(bx + (bw * i) / 6, by + 6); ctx.lineTo(bx + (bw * i) / 6, by + bh - 6); ctx.stroke();
  }
  label(ctx, `${T.toFixed(1)} °C`, bx + bw / 2, by + bh / 2, '#07110c', 'center', 14);
  // heating coil, brightness = commanded power
  const p = clamp(s.u / 100, 0, 1);
  ctx.strokeStyle = p > 0.02 ? pal.danger : pal.faint; ctx.lineWidth = 3; ctx.globalAlpha = 0.35 + 0.65 * p;
  ctx.beginPath();
  const cy = by + bh + 18;
  for (let i = 0; i <= 40; i++) {
    const x = bx + (bw * i) / 40;
    const y = cy + Math.sin(i * 1.4) * 5;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
  label(ctx, `heater ${s.u.toFixed(0)} %`, bx, cy + 18, pal.copperBright);
  label(ctx, `dead time ${s.def.params.L} s → sensor`, bx, h - 10, pal.faint, 'left', 9);

  // thermometer: 20..100 C with setpoint tick
  const tx = w * 0.8, ty0 = 18, ty1 = h - 28;
  const TY = (v) => ty1 - (clamp(v, 10, 100) - 10) / 90 * (ty1 - ty0);
  roundRect(ctx, tx - 6, ty0, 12, ty1 - ty0, 6); ctx.fillStyle = pal.surface2; ctx.fill(); ctx.strokeStyle = pal.borderStrong; ctx.stroke();
  ctx.fillStyle = col; ctx.fillRect(tx - 3, TY(T), 6, ty1 - TY(T));
  ctx.beginPath(); ctx.arc(tx, ty1 + 6, 8, 0, TAU); ctx.fill();
  for (let v = 20; v <= 100; v += 20) label(ctx, `${v}`, tx + 12, TY(v), pal.faint);
  ctx.strokeStyle = pal.signal; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(tx - 12, TY(s.sp)); ctx.lineTo(tx + 8, TY(s.sp)); ctx.stroke(); ctx.lineWidth = 1;
  label(ctx, 'SP', tx - 14, TY(s.sp), pal.signal, 'right');
  if (s.d) {                               // draft lines
    ctx.strokeStyle = pal.signal; ctx.globalAlpha = 0.7;
    for (let k = 0; k < 3; k++) {
      const x = ((s.t * 8 + k * 30) % (w * 0.6));
      ctx.beginPath(); ctx.moveTo(x, by - 12 + k * 4); ctx.lineTo(x + 18, by - 12 + k * 4); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    label(ctx, 'DRAFT', 8, 12, pal.signal);
  }
}

/* -------- Ball on beam ------------------------------------------------------------- */
function ballBeam(ctx, w, h, s, pal) {
  const cx = w / 2, cy = h * 0.58;
  const L = w * 0.4;                        // half length in px for 0.5 m
  const alpha = s.x[2];
  const vis = alpha * 1.6;                  // exaggerate the tilt so small angles are visible
  // pivot
  ctx.fillStyle = pal.surface2; ctx.strokeStyle = pal.borderStrong;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - 18, cy + 46); ctx.lineTo(cx + 18, cy + 46); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-vis);
  ctx.fillStyle = pal.copper; ctx.fillRect(-L - 6, -3, 2 * L + 12, 6);
  ctx.fillStyle = pal.muted; ctx.fillRect(-L - 8, -12, 4, 12); ctx.fillRect(L + 4, -12, 4, 12);   // end stops
  for (let m = -0.4; m <= 0.41; m += 0.1) {
    ctx.fillStyle = pal.faint; ctx.fillRect((m / 0.5) * L - 0.5, 3, 1, 4);
  }
  const spx = (s.sp / 0.5) * L;
  ctx.strokeStyle = pal.signal; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(spx, -24); ctx.lineTo(spx, 0); ctx.stroke(); ctx.setLineDash([]);
  const bx = (s.y / 0.5) * L, br = 9;
  ctx.beginPath(); ctx.arc(bx, -3 - br, br, 0, TAU); ctx.fillStyle = pal.led; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  const roll = -s.y / 0.009;                // rolling marker
  ctx.beginPath(); ctx.moveTo(bx, -3 - br); ctx.lineTo(bx + Math.cos(roll) * br, -3 - br + Math.sin(roll) * br); ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, TAU); ctx.fillStyle = pal.copperBright; ctx.fill();
  label(ctx, `x ${(s.y * 100).toFixed(1)} cm`, 10, 16, pal.led);
  label(ctx, `beam ${(alpha * 180 / Math.PI).toFixed(1)}°`, 10, 30, pal.copperBright);
  label(ctx, 'tilt drawn ×1.6', 10, h - 12, pal.faint, 'left', 9);
  if (s.d) label(ctx, 'PUSH →', w - 10, 16, pal.danger, 'right');
}

export function drawPlant(ctx, w, h, s, pal) {
  ctx.clearRect(0, 0, w, h);
  switch (s.def.id) {
    case 'motor-speed': return motor(ctx, w, h, s, pal, false);
    case 'motor-position': return motor(ctx, w, h, s, pal, true);
    case 'drone': return drone(ctx, w, h, s, pal);
    case 'heater': return heater(ctx, w, h, s, pal);
    case 'ball-beam': return ballBeam(ctx, w, h, s, pal);
    default: return undefined;
  }
}
