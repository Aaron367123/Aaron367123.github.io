/**
 * Component geometry: where each pin sits relative to the component's
 * origin (comp.x, comp.y), and the body box used for hit-testing and
 * selection. All pins land on the 20 px grid so wires route cleanly.
 */
import { componentPins, chipInterface, findChip, withDefaults } from '../engine/index.js';

export const G = 20;

export const snap = (v) => Math.round(v / G) * G;

/** Input pin y offsets for an n-input gate (outputs centred between them). */
export function gateInputYs(n) {
  if (n === 2) return [0, 40];
  if (n === 3) return [0, 20, 40];
  return [0, 20, 60, 80];
}

/** Width of a chip body, enough for the pin labels on both sides. */
function chipWidth(iface) {
  const longest = (list) => list.reduce((m, p) => Math.max(m, p.label.length), 0);
  const need = (longest(iface.inputs) + longest(iface.outputs)) * 7 + 24;
  return Math.max(60, Math.ceil(need / G) * G);
}

/**
 * geometry(comp, library) -> {
 *   pins: { name: { x, y, side: 'in'|'out' } },   // relative to origin
 *   box: { x, y, w, h },                           // relative body box
 *   ...type specific extras (gate top/bottom, chip width, ...)
 * }
 */
export function geometry(comp, library = {}) {
  const props = withDefaults(comp);
  const pins = {};
  const pin = (name, x, y, side) => { pins[name] = { x, y, side }; };

  switch (comp.type) {
    case 'INPUT': case 'BUTTON': case 'CLOCK':
      pin('out', 60, 0, 'out');
      return { pins, box: { x: 0, y: -15, w: 60, h: 30 } };
    case 'CONST':
      pin('out', 40, 0, 'out');
      return { pins, box: { x: 0, y: -10, w: 40, h: 20 } };
    case 'OUTPUT':
      pin('in', 0, 0, 'in');
      return { pins, box: { x: 0, y: -14, w: 44, h: 28 } };
    case 'PROBE':
      pin('in', 0, 0, 'in');
      return { pins, box: { x: 0, y: -10, w: 64, h: 20 } };
    case 'NOT': case 'BUF':
      pin('in', 0, 0, 'in');
      pin('out', 60, 0, 'out');
      return { pins, box: { x: 0, y: -15, w: 60, h: 30 } };
    case 'DFF':
      pin('d', 0, 20, 'in'); pin('clk', 0, 40, 'in'); pin('rst', 0, 60, 'in');
      pin('q', 100, 20, 'out'); pin('qn', 100, 60, 'out');
      return { pins, box: { x: 0, y: 0, w: 100, h: 80 } };
    case 'SEG7':
      for (let i = 0; i < 4; i++) pin(`d${i}`, 0, 20 + 20 * i, 'in');
      return { pins, box: { x: 0, y: 0, w: 100, h: 100 } };
    case 'SUBCIRCUIT': {
      const def = findChip(props.chip, [library]);
      const iface = def ? chipInterface(def) : { inputs: [], outputs: [] };
      const w = chipWidth(iface);
      const rows = Math.max(2, iface.inputs.length, iface.outputs.length);
      iface.inputs.forEach((p, i) => pin(p.label, 0, G * (i + 1), 'in'));
      iface.outputs.forEach((p, i) => pin(p.label, w + 40, G * (i + 1), 'out'));
      return { pins, box: { x: 0, y: 0, w: w + 40, h: G * (rows + 1) }, bodyW: w, iface, missing: !def };
    }
    default: {
      // AND / OR / XOR / NAND / NOR / XNOR
      const ys = gateInputYs(props.inputs ?? 2);
      ys.forEach((y, i) => pin(`in${i}`, 0, y, 'in'));
      const mid = (ys[0] + ys[ys.length - 1]) / 2;
      pin('out', 80, mid, 'out');
      const top = ys[0] - 10, bottom = ys[ys.length - 1] + 10;
      return { pins, box: { x: 0, y: top, w: 80, h: bottom - top }, top, bottom, mid };
    }
  }
}

/** Absolute pin position for a 'compId.pin' reference. */
export function pinPosition(circuit, geoms, ref) {
  const dot = ref.lastIndexOf('.');
  const id = ref.slice(0, dot), name = ref.slice(dot + 1);
  const comp = circuit.components.find((c) => c.id === id);
  const g = comp && geoms.get(id);
  const p = g?.pins[name];
  return p ? { x: comp.x + p.x, y: comp.y + p.y } : null;
}

/** Pin names by side, for the editor (wiring rules). */
export function pinSides(comp, library) {
  return componentPins(comp, [library]);
}
