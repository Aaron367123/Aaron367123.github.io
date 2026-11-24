/**
 * SVG drawings for every component type, as markup strings in the
 * component's local coordinates (origin = comp.x, comp.y).
 *
 * Gates use the ANSI/IEEE distinctive shapes; flip-flops, displays and
 * chips are drawn as IC packages (body, notch, pin stubs, silkscreen pin
 * names). Anything that changes with the simulation carries a class the
 * view toggles (.knob, .lamp, .seg-*, .probe-val), so values never force a
 * re-render.
 */
import { withDefaults } from '../engine/index.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const stub = (x1, y1, x2, y2) => `<line class="stub" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
const silk = (x, y, text, anchor = 'middle', cls = '') =>
  `<text class="silk ${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`;

/** x of a quadratic back curve "M x0,top Q x0+12,mid x0,bottom" at height y. */
const backCurveX = (x0, top, bottom, y) => {
  const t = (y - top) / (bottom - top);
  return x0 + 24 * t * (1 - t);
};

function gateBody(type, geo) {
  const { top, bottom, mid } = geo;
  const h = bottom - top;
  const base = type.replace(/^N(?=AND|OR)/, '').replace(/^XN/, 'X'); // NAND->AND, NOR->OR, XNOR->XOR
  const bubble = type === 'NAND' || type === 'NOR' || type === 'XNOR';
  const inputs = Object.entries(geo.pins).filter(([, p]) => p.side === 'in');
  let s = '';
  for (const [, p] of inputs) {
    const end = base === 'AND' ? 15 : base === 'OR' ? backCurveX(15, top, bottom, p.y) : backCurveX(13, top, bottom, p.y);
    s += stub(0, p.y, end, p.y);
  }
  s += stub(bubble ? 73 : 65, mid, 80, mid);
  if (base === 'AND') {
    s += `<path class="body" d="M15,${top} H35 A30,${h / 2} 0 0 1 35,${bottom} H15 Z"/>`;
  } else if (base === 'OR') {
    s += `<path class="body" d="M15,${top} Q45,${top} 65,${mid} Q45,${bottom} 15,${bottom} Q27,${mid} 15,${top} Z"/>`;
  } else {
    s += `<path class="body" d="M21,${top} Q49,${top} 65,${mid} Q49,${bottom} 21,${bottom} Q33,${mid} 21,${top} Z"/>`;
    s += `<path class="body-line" d="M13,${top} Q25,${mid} 13,${bottom}"/>`;
  }
  if (bubble) s += `<circle class="body" cx="69" cy="${mid}" r="4"/>`;
  return s;
}

function inverter(type) {
  let s = stub(0, 0, 15, 0);
  if (type === 'NOT') {
    s += stub(55, 0, 60, 0);
    s += '<path class="body" d="M15,-14 L47,0 L15,14 Z"/><circle class="body" cx="51" cy="0" r="4"/>';
  } else {
    s += stub(50, 0, 60, 0);
    s += '<path class="body" d="M15,-14 L50,0 L15,14 Z"/>';
  }
  return s;
}

/** IC package rectangle with a pin-1 notch. */
const icBody = (x, y, w, h, cls = '') =>
  `<rect class="ic ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>` +
  `<path class="notch" d="M${x + w / 2 - 6},${y} A6,6 0 0 0 ${x + w / 2 + 6},${y}"/>`;

/** A segment of a 7-segment digit, as a hexagon. */
function segment(name, horizontal, a, b, c, t = 6) {
  const h = t / 2;
  const pts = horizontal
    ? [[a, c], [a + h, c - h], [b - h, c - h], [b, c], [b - h, c + h], [a + h, c + h]]
    : [[c, a], [c + h, a + h], [c + h, b - h], [c, b], [c - h, b - h], [c - h, a + h]];
  return `<polygon class="seg seg-${name}" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
}

function sevenSegment() {
  const L = 46, R = 74, T = 20, M = 50, B = 80;
  return (
    `<rect class="seg-window" x="34" y="10" width="52" height="80" rx="3"/>` +
    segment('a', true, L + 3, R - 3, T) + segment('g', true, L + 3, R - 3, M) + segment('d', true, L + 3, R - 3, B) +
    segment('f', false, T + 3, M - 3, L) + segment('b', false, T + 3, M - 3, R) +
    segment('e', false, M + 3, B - 3, L) + segment('c', false, M + 3, B - 3, R) +
    `<circle class="seg seg-dp" cx="${R + 6}" cy="${B}" r="2"/>`
  );
}

const LED_COLORS = ['led', 'warn', 'danger', 'signal'];

/** Inner SVG markup for a component. */
export function componentMarkup(comp, geo) {
  const props = withDefaults(comp);
  const label = comp.label ?? '';
  switch (comp.type) {
    case 'INPUT':
      return stub(40, 0, 60, 0) +
        '<rect class="body" x="0" y="-15" width="40" height="30" rx="5"/>' +
        '<rect class="track" x="7" y="-6" width="26" height="12" rx="6"/><circle class="knob" cx="13" cy="0" r="4.5"/>' +
        silk(-8, 4, label || comp.id, 'end', 'lbl');
    case 'BUTTON':
      return stub(40, 0, 60, 0) +
        '<rect class="body" x="0" y="-15" width="40" height="30" rx="5"/>' +
        '<circle class="btn-ring" cx="20" cy="0" r="10"/><circle class="btn-cap" cx="20" cy="0" r="7"/>' +
        silk(-8, 4, label || comp.id, 'end', 'lbl');
    case 'CLOCK':
      return stub(40, 0, 60, 0) +
        '<rect class="body" x="0" y="-15" width="40" height="30" rx="5"/>' +
        '<path class="wave" d="M7,5 H13 V-5 H20 V5 H27 V-5 H33"/>' +
        silk(-8, 4, label || 'CLK', 'end', 'lbl') + silk(20, 26, `T=${props.period}`, 'middle', 'small');
    case 'CONST':
      return stub(20, 0, 40, 0) +
        '<rect class="body" x="0" y="-10" width="20" height="20" rx="3"/>' +
        `<text class="const-val" x="10" y="4" text-anchor="middle">${props.value ? 1 : 0}</text>`;
    case 'OUTPUT': {
      const color = LED_COLORS.includes(props.color) ? props.color : 'led';
      return stub(0, 0, 17, 0) +
        `<circle class="lamp-ring" cx="28" cy="0" r="12"/><circle class="lamp lamp-${color}" cx="28" cy="0" r="9"/>` +
        '<circle class="lamp-glint" cx="25" cy="-3" r="2.4"/>' +
        silk(46, 4, label || comp.id, 'start', 'lbl');
    }
    case 'PROBE':
      return stub(0, 0, 10, 0) +
        '<path class="tag" d="M10,0 L18,-10 H64 V10 H18 Z"/>' +
        silk(22, 4, (label || 'PROBE').slice(0, 6), 'start', 'small tag-lbl') +
        '<text class="probe-val" x="59" y="4" text-anchor="end">X</text>';
    case 'NOT': case 'BUF':
      return inverter(comp.type) + (label ? silk(30, -20, label, 'middle', 'small') : '');
    case 'DFF':
      return stub(0, 20, 20, 20) + stub(0, 40, 20, 40) + stub(0, 60, 20, 60) + stub(80, 20, 100, 20) + stub(80, 60, 100, 60) +
        icBody(20, 0, 60, 80) +
        silk(26, 24, 'D', 'start', 'pin') + '<path class="clk-tri" d="M20,34 L28,40 L20,46"/>' + silk(26, 64, 'R', 'start', 'pin') +
        silk(74, 24, 'Q', 'end', 'pin') + silk(74, 64, 'Q', 'end', 'pin') + '<line class="overbar" x1="66" y1="54" x2="74" y2="54"/>' +
        silk(50, -6, label || 'DFF');
    case 'SEG7':
      return [20, 40, 60, 80].map((y) => stub(0, y, 20, y)).join('') +
        icBody(20, 0, 80, 100) + sevenSegment() +
        ['1', '2', '4', '8'].map((t, i) => silk(25, 23 + 20 * i, t, 'start', 'pin tiny')).join('') +
        silk(60, -6, label || 'HEX');
    case 'SUBCIRCUIT': {
      const w = geo.bodyW, h = geo.box.h;
      let s = '';
      for (const [name, p] of Object.entries(geo.pins)) {
        if (p.side === 'in') s += stub(0, p.y, 20, p.y) + silk(26, p.y + 3.5, name, 'start', 'pin');
        else s += stub(20 + w, p.y, w + 40, p.y) + silk(14 + w, p.y + 3.5, name, 'end', 'pin');
      }
      return icBody(20, 0, w, h, geo.missing ? 'missing' : '') + s +
        silk(20 + w / 2, -6, (label || props.chip || '?').toUpperCase());
    }
    default:
      return gateBody(comp.type, geo) + (label ? silk(40, geo.top - 6, label, 'middle', 'small') : '');
  }
}

/** Pin pads (+ larger invisible hit targets) for every pin of a component. */
export function pinMarkup(geo) {
  let s = '';
  for (const [name, p] of Object.entries(geo.pins)) {
    s += `<circle class="pad pad-${p.side}" data-pin="${esc(name)}" cx="${p.x}" cy="${p.y}" r="3.2"/>`;
    s += `<circle class="pin-hit" data-pin="${esc(name)}" data-side="${p.side}" cx="${p.x}" cy="${p.y}" r="9"/>`;
  }
  return s;
}
