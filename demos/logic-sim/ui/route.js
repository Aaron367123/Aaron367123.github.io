/**
 * Orthogonal (Manhattan) wire routing with rounded corners.
 *
 * Wires leaving the same output pin form one net and share a vertical trunk,
 * so a fan-out reads as a tree with junction dots. Trunks of different nets
 * are spread over free grid columns so they never overlap (a tiny version
 * of channel routing). Wires that go backwards (feedback) detour through a
 * horizontal channel below the components, unless a `route` hint says where.
 */
import { G, snap, pinPosition } from './geometry.js';

/** Do two closed intervals overlap, with a little clearance? */
const overlaps = (a0, a1, b0, b1, pad = 6) => Math.min(a0, a1) - pad <= Math.max(b0, b1) && Math.max(a0, a1) + pad >= Math.min(b0, b1);

/**
 * routeAll(circuit, geoms) -> {
 *   wires: [{ index, points }], junctions: [{ x, y, from }]
 * }
 */
export function routeAll(circuit, geoms) {
  const groups = new Map();
  circuit.wires.forEach((w, index) => {
    const p1 = pinPosition(circuit, geoms, w.from);
    const p2 = pinPosition(circuit, geoms, w.to);
    if (!p1 || !p2) return;
    if (!groups.has(w.from)) groups.set(w.from, { p1, items: [] });
    groups.get(w.from).items.push({ index, w, p2 });
  });

  const used = [];   // vertical segments already placed: { x, y0, y1, from }
  const out = [];
  const junctions = [];
  // Component bodies are obstacles for vertical trunks.
  const boxes = circuit.components.map((c) => {
    const b = geoms.get(c.id).box;
    return { x0: c.x + b.x + 4, x1: c.x + b.x + b.w - 4, y0: c.y + b.y, y1: c.y + b.y + b.h };
  });
  const hitsBody = (x, y0, y1) => boxes.some((b) => x > b.x0 && x < b.x1 && overlaps(b.y0, b.y1, y0, y1, -2));
  const isFree = (x, y0, y1, from) =>
    !hitsBody(x, y0, y1) && !used.some((s) => s.from !== from && s.x === x && overlaps(s.y0, s.y1, y0, y1));
  const claim = (x, y0, y1, from) => used.push({ x, y0, y1, from });

  // Hinted wires first so automatic trunks avoid them.
  for (const [from, g] of groups) {
    for (const it of g.items) {
      const r = it.w.route;
      if (r?.y !== undefined) {
        const x1 = r.x1 ?? g.p1.x + G, x2 = r.x2 ?? it.p2.x - G;
        claim(x1, g.p1.y, r.y, from);
        claim(x2, r.y, it.p2.y, from);
      } else if (r?.x !== undefined) {
        claim(r.x, g.p1.y, it.p2.y, from);
      }
    }
  }

  const sorted = [...groups.entries()].sort((a, b) => a[1].p1.x - b[1].p1.x || a[1].p1.y - b[1].p1.y);
  for (const [from, { p1, items }] of sorted) {
    const forward = items.filter((it) => !it.w.route && it.p2.x >= p1.x + 2 * G);
    // Pick one trunk column for all automatic forward wires of this net.
    let trunk = null;
    const needTrunk = forward.filter((it) => it.p2.y !== p1.y);
    if (needTrunk.length) {
      const minX2 = Math.min(...forward.map((it) => it.p2.x));
      const ys = [p1.y, ...needTrunk.map((it) => it.p2.y)];
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const lo = p1.x + G, hi = minX2 - G;
      const ideal = Math.min(hi, Math.max(lo, snap((p1.x + minX2) / 2)));
      trunk = ideal;
      for (let k = 0; k < 40; k++) {
        const cand = ideal + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * G;
        if (cand < lo || cand > hi) continue;
        if (isFree(cand, y0, y1, from)) { trunk = cand; break; }
      }
      claim(trunk, y0, y1, from);
      // Junction dots where three or more segments meet on the trunk.
      const sinkYs = needTrunk.map((it) => it.p2.y);
      const straight = forward.some((it) => it.p2.y === p1.y);
      for (const y of new Set([p1.y, ...sinkYs])) {
        const deg = (y > y0 ? 1 : 0) + (y < y1 ? 1 : 0) + (y === p1.y ? 1 + (straight ? 1 : 0) : 0) + (sinkYs.includes(y) ? 1 : 0);
        if (deg >= 3) junctions.push({ x: trunk, y, from });
      }
    }

    for (const it of items) {
      const { p2, w } = it;
      const r = w.route;
      let pts;
      if (r?.y !== undefined) {
        const x1 = r.x1 ?? p1.x + G, x2 = r.x2 ?? p2.x - G;
        pts = [p1, { x: x1, y: p1.y }, { x: x1, y: r.y }, { x: x2, y: r.y }, { x: x2, y: p2.y }, p2];
      } else if (r?.x !== undefined) {
        pts = [p1, { x: r.x, y: p1.y }, { x: r.x, y: p2.y }, p2];
      } else if (p2.x >= p1.x + 2 * G) {
        pts = p2.y === p1.y ? [p1, p2] : [p1, { x: trunk, y: p1.y }, { x: trunk, y: p2.y }, p2];
      } else {
        // Feedback: out to the right, down below both pins, back left, up into the pin.
        const fromComp = circuit.components.find((c) => c.id === w.from.slice(0, w.from.lastIndexOf('.')));
        const toComp = circuit.components.find((c) => c.id === w.to.slice(0, w.to.lastIndexOf('.')));
        const bottom = (c) => (c ? c.y + geoms.get(c.id).box.y + geoms.get(c.id).box.h : 0);
        const dy = snap(Math.max(bottom(fromComp), bottom(toComp), p1.y, p2.y) + G);
        const x1 = p1.x + G, x2 = p2.x - G;
        pts = [p1, { x: x1, y: p1.y }, { x: x1, y: dy }, { x: x2, y: dy }, { x: x2, y: p2.y }, p2];
      }
      out.push({ index: it.index, points: simplify(pts), from });
    }

    // Branch dot where several wires of this net leave a shared first leg.
    const firstLegs = items.map((it) => out.find((o) => o.index === it.index).points[1]).filter(Boolean);
    const xs = new Map();
    for (const p of firstLegs) if (p.y === p1.y) xs.set(p.x, (xs.get(p.x) ?? 0) + 1);
    const distinct = [...xs.keys()].sort((a, b) => a - b);
    if (distinct.length > 1) for (const x of distinct.slice(0, -1)) {
      if (!junctions.some((j) => j.x === x && j.y === p1.y)) junctions.push({ x, y: p1.y, from });
    }
  }
  return { wires: out, junctions };
}

/** Drop repeated and collinear points. */
function simplify(pts) {
  const res = [];
  for (const p of pts) {
    const last = res[res.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (res.length >= 2) {
      const a = res[res.length - 2], b = last;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { res[res.length - 1] = p; continue; }
    }
    res.push(p);
  }
  return res;
}

/** Polyline -> SVG path with rounded corners of radius r. */
export function pathFor(points, r = 7) {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const p = { x: b.x - ((b.x - a.x) / l1) * k, y: b.y - ((b.y - a.y) / l1) * k };
    const q = { x: b.x + ((c.x - b.x) / l2) * k, y: b.y + ((c.y - b.y) / l2) * k };
    d += ` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  const last = points[points.length - 1];
  return d + ` L${last.x},${last.y}`;
}

/** Preview route while dragging a new wire from (x1,y1) to the cursor. */
export function previewPoints(a, b) {
  const mx = snap((a.x + b.x) / 2);
  return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
}
