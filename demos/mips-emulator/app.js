// app.js - the browser UI for the MIPS emulator.
//
// All of the real work (assembling, memory, executing) happens in the engine
// modules in ./engine/ - the same files as src/ in the mips-emulator repo.
// This file only wires buttons to the engine and draws its state.
//
// URL parameters (handy for embedding and screenshots):
//   ?example=factorial   load another example on start (swap, sum, factorial, strlen)
//   ?autorun=1           assemble and run to completion on load
//   ?steps=12            assemble and execute 12 instructions on load
//   ?theme=light|dark    force a colour theme (handled in index.html)
//   ?asm=<base64url>     load this UTF-8 source instead of an example (max 16 KB);
//                        used by the Mini-C compiler's "Open in MIPS emulator" link

import { assemble } from './engine/assembler.js';
import { CPU } from './engine/cpu.js';
import { MipsError, hex32 } from './engine/errors.js';
import { disassemble, labelsByAddress } from './engine/disassembler.js';
import { REGISTER_NAMES, TEXT_BASE, DATA_BASE, STACK_TOP } from './engine/isa.js';
import { toPrintable } from './engine/memory.js';

const EXAMPLES = [
  { id: 'swap', file: 'swap.asm', title: 'Swap two arrays (course program)' },
  { id: 'sum', file: 'sum.asm', title: 'Sum of an array' },
  { id: 'factorial', file: 'factorial.asm', title: 'Recursive factorial (jal / jr)' },
  { id: 'strlen', file: 'strlen.asm', title: 'String length + upper-case (lb / sb)' },
];

// Slider positions -> instructions per second.
const SPEEDS = [1, 2, 5, 10, 25, 60, 150, 500, 2000, Infinity];
const MAX_UI_STEPS = 5_000_000; // safety net for infinite loops
const MAX_SHARED_BYTES = 16 * 1024; // largest program accepted through ?asm=

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  example: $('example'),
  assemble: $('btn-assemble'),
  step: $('btn-step'),
  run: $('btn-run'),
  runLabel: $('run-label'),
  reset: $('btn-reset'),
  speed: $('speed'),
  speedLabel: $('speed-label'),
  status: $('status'),
  pc: $('pc-value'),
  steps: $('step-count'),
  source: $('source'),
  gutter: $('gutter'),
  lineCurrent: $('line-current'),
  lineError: $('line-error'),
  editorHint: $('editor-hint'),
  listing: $('listing'),
  listingTable: document.querySelector('.listing'),
  listingScroll: $('listing-scroll'),
  listingEmpty: $('listing-empty'),
  registers: $('registers'),
  memory: $('memory'),
  console: $('console'),
  clear: $('btn-clear'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const cpu = new CPU();
cpu.onOutput = (text) => appendOutput(text);

const state = {
  program: null,          // result of assemble(), or null
  dirty: true,            // source edited since the last assemble
  running: false,
  frame: 0,               // requestAnimationFrame id
  stepsOwed: 0,           // fractional steps carried between animation frames
  lastTime: 0,
  skipBreakpoint: false,  // let Run leave the breakpoint it is sitting on
  breakpoints: new Set(), // instruction addresses
  labelNames: new Map(),  // address -> label, for the disassembly
  rows: new Map(),        // address -> <tr> in the listing
  regCells: [],           // register value elements
  shownRegs: null,        // register values at the last render (for change highlights)
  written: new Set(),     // byte addresses stored to since the last render
  region: 'data',
  format: 'hex',
  bytesPerRow: 16,
  errorLine: null,
  shownLine: null,
  outputBlock: null,
};

// ---------------------------------------------------------------------------
// Assemble / step / run / reset
// ---------------------------------------------------------------------------

/** Assemble the editor contents and load the program into the CPU. */
function assembleSource() {
  stopRunning();
  state.errorLine = null;
  try {
    state.program = assemble(el.source.value);
  } catch (err) {
    state.program = null;
    state.dirty = false;
    buildListing();
    if (!(err instanceof MipsError)) throw err;
    reportError(err, 'Assembly failed');
    render();
    return false;
  }
  state.dirty = false;
  state.labelNames = labelsByAddress(state.program.labels);
  state.breakpoints.clear(); // addresses may have moved
  cpu.load(state.program);
  buildListing();
  forgetHighlights();

  const words = state.program.text.length;
  const bytes = state.program.data.length;
  setStatus(`Assembled ${words} instruction${words === 1 ? '' : 's'} and ${bytes} data byte${bytes === 1 ? '' : 's'}. Press Step or Run.`);
  log(`Assembled: ${words} words of code at ${hex32(TEXT_BASE)}, ${bytes} bytes of data at ${hex32(DATA_BASE)}.`);
  render();
  return true;
}

/** Make sure there is a loaded program that can still execute. */
function ready() {
  if (!state.program || state.dirty) return assembleSource();
  if (cpu.halted) {
    setStatus('The program has finished. Press Reset to run it again.');
    return false;
  }
  return true;
}

/** Execute one instruction. Returns false when the CPU stopped (halt or error). */
function stepOnce() {
  try {
    cpu.step();
  } catch (err) {
    if (!(err instanceof MipsError)) throw err;
    state.running = false;
    reportError(err, 'Run-time error');
    return false;
  }
  if (cpu.lastWrite) {
    for (let i = 0; i < cpu.lastWrite.size; i++) state.written.add(cpu.lastWrite.address + i);
  }
  if (cpu.halted) {
    state.running = false;
    finish();
    return false;
  }
  if (cpu.steps >= MAX_UI_STEPS) {
    state.running = false;
    cpu.halt('step limit');
    reportError(new MipsError(`Stopped after ${MAX_UI_STEPS.toLocaleString()} instructions (infinite loop?)`, { line: cpu.lineForAddress.get(cpu.pc) ?? null }), 'Run stopped');
    return false;
  }
  return true;
}

function finish() {
  const message = `Finished after ${cpu.steps} instructions: ${cpu.haltReason}.`;
  setStatus(message, 'success');
  log(message, 'success');
}

function onStep() {
  if (state.running) return;
  if (!ready()) return;
  if (stepOnce()) {
    const line = cpu.lineForAddress.get(cpu.pc);
    setStatus(`Paused at ${hex32(cpu.pc)}${line ? ` (line ${line})` : ''}. Next: ${disassemble(cpu.memory.readWord(cpu.pc), cpu.pc, state.labelNames)}`);
  }
  render();
}

function onRun() {
  if (state.running) {
    stopRunning();
    pausedStatus('Paused');
    render();
    return;
  }
  if (!ready()) return;
  state.running = true;
  state.skipBreakpoint = true;
  state.stepsOwed = 1; // execute the first instruction right away
  state.lastTime = performance.now();
  setStatus('Running…', 'running');
  updateButtons();
  state.frame = requestAnimationFrame(runFrame);
}

/** One animation frame of a run: execute as many instructions as the speed allows. */
function runFrame(now) {
  if (!state.running) return;
  const rate = SPEEDS[Number(el.speed.value)];
  let budget;
  if (rate === Infinity) {
    budget = 100_000;
  } else {
    state.stepsOwed += (rate * Math.min(now - state.lastTime, 250)) / 1000;
    budget = Math.floor(state.stepsOwed);
    state.stepsOwed -= budget;
  }
  state.lastTime = now;

  let executed = 0;
  for (let i = 0; i < budget; i++) {
    if (!state.skipBreakpoint && state.breakpoints.has(cpu.pc)) {
      state.running = false;
      pausedStatus('Breakpoint');
      break;
    }
    state.skipBreakpoint = false;
    executed++;
    if (!stepOnce()) break;
  }

  // Only redraw when something happened, so change highlights stay visible
  // between instructions at slow speeds.
  if (executed > 0 || !state.running) render();
  if (state.running) state.frame = requestAnimationFrame(runFrame);
}

function stopRunning() {
  state.running = false;
  cancelAnimationFrame(state.frame);
}

function pausedStatus(prefix) {
  const line = cpu.lineForAddress.get(cpu.pc);
  setStatus(`${prefix} at ${hex32(cpu.pc)}${line ? ` (line ${line})` : ''} after ${cpu.steps} instructions.`);
}

function onReset() {
  stopRunning();
  if (state.dirty || !state.program) {
    assembleSource();
    return;
  }
  state.errorLine = null;
  cpu.load(state.program);
  forgetHighlights();
  setStatus('Reset: registers cleared, memory reloaded. Press Step or Run.');
  log('Reset.');
  render();
}

function reportError(err, title) {
  state.errorLine = err.line;
  const text = `${title}: ${err.describe()}`;
  setStatus(text, 'error');
  log(text, 'error');
  scrollEditorTo(err.line);
}

/** Treat the current state as "seen" so nothing is highlighted as changed. */
function forgetHighlights() {
  state.shownRegs = registerValues();
  state.written.clear();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderRegisters();
  renderListing();
  renderMemory();
  renderEditorMarkers();
  el.pc.textContent = hex32(cpu.pc);
  el.steps.textContent = cpu.steps.toLocaleString('en-US');
  updateButtons();
}

function updateButtons() {
  const canExecute = state.dirty || !state.program || !cpu.halted;
  el.step.disabled = state.running || !canExecute;
  el.run.disabled = !state.running && !canExecute;
  el.run.classList.toggle('running', state.running);
  el.runLabel.textContent = state.running ? 'Pause' : 'Run';
  el.run.setAttribute('aria-label', state.running ? 'Pause the program' : 'Run the program');
  el.listingTable.classList.toggle('stale', state.dirty);
  el.editorHint.textContent = state.dirty && state.program ? 'Edited: press Assemble' : 'MIPS assembly';
  el.editorHint.classList.toggle('stale', state.dirty && !!state.program);
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

// ---- registers ----

/** [pc, hi, lo, $zero ... $ra] */
function registerValues() {
  return [cpu.pc, cpu.hi, cpu.lo, ...cpu.regs];
}

function buildRegisters() {
  const names = [['pc', 'special'], ['hi', 'special'], ['lo', 'special'], ...REGISTER_NAMES.map((n) => [n, ''])];
  el.registers.innerHTML = '';
  state.regCells = names.map(([name, kind], i) => {
    const cell = document.createElement('div');
    cell.className = `reg ${kind}`;
    const number = i >= 3 ? `<small>${i - 3}</small>` : '';
    cell.innerHTML = `<span class="name">${name}${number}</span><span class="value">0x00000000</span>`;
    el.registers.append(cell);
    return cell;
  });
}

function renderRegisters() {
  const values = registerValues();
  values.forEach((value, i) => {
    const cell = state.regCells[i];
    const changed = i !== 0 && state.shownRegs !== null && state.shownRegs[i] !== value; // PC always changes
    cell.classList.toggle('changed', changed);
    cell.classList.toggle('zero', value === 0);
    const signed = value | 0;
    cell.lastChild.textContent = state.format === 'dec' && i !== 0 ? String(signed) : hex32(value);
    cell.title = `${hex32(value)} = ${value >>> 0} (signed ${signed})`;
  });
  state.shownRegs = values;
}

// ---- machine-code listing ----

function buildListing() {
  el.listing.innerHTML = '';
  state.rows.clear();
  const entries = state.program ? state.program.listing : [];
  el.listingEmpty.hidden = entries.length > 0;
  el.listingEmpty.textContent = state.program ? 'Assemble a program to see its machine code.' : 'Fix the error and assemble again.';

  for (const entry of entries) {
    const row = document.createElement('tr');
    const label = state.labelNames.get(entry.address);
    const labelHtml = label && entry.address < DATA_BASE ? `<span class="label">${escapeHtml(label)}:</span>` : '';
    const pseudoHtml = entry.pseudo ? `<span class="pseudo" title="from pseudo-instruction">${entry.pseudo}</span>` : '';
    row.innerHTML =
      `<td class="mark"><button type="button" class="bp" aria-pressed="false" aria-label="Toggle breakpoint at ${hex32(entry.address)}"></button></td>` +
      `<td class="addr">${hex(entry.address, 4)}</td>` +
      `<td class="word">${hex(entry.word, 8)}</td>` +
      `<td class="inst">${labelHtml}${escapeHtml(disassemble(entry.word, entry.address, state.labelNames))}${pseudoHtml}</td>` +
      `<td class="col-line">${entry.line}</td>`;
    row.querySelector('.bp').addEventListener('click', (event) => toggleBreakpoint(entry.address, event.currentTarget));
    el.listing.append(row);
    state.rows.set(entry.address, row);
  }
}

function toggleBreakpoint(address, button) {
  if (state.breakpoints.has(address)) state.breakpoints.delete(address);
  else state.breakpoints.add(address);
  button.setAttribute('aria-pressed', String(state.breakpoints.has(address)));
}

function renderListing() {
  for (const row of el.listing.querySelectorAll('tr.current, tr.executed')) {
    row.classList.remove('current', 'executed');
  }
  if (!state.program) return;
  const last = cpu.lastStep ? state.rows.get(cpu.lastStep.pc) : null;
  if (last) last.classList.add('executed');
  const current = cpu.halted ? null : state.rows.get(cpu.pc);
  if (current) {
    current.classList.add('current');
    keepVisible(el.listingScroll, current, 30);
  }
}

/** Scroll `container` (not the page) so that `child` is visible. */
function keepVisible(container, child, topPadding = 0) {
  const box = container.getBoundingClientRect();
  const item = child.getBoundingClientRect();
  if (item.top < box.top + topPadding || item.bottom > box.bottom) {
    container.scrollTop += item.top - box.top - container.clientHeight / 3;
  }
}

// ---- memory view ----

function memoryWindow() {
  const program = state.program;
  const roundUp = (n) => Math.ceil(n / 16) * 16;
  if (state.region === 'code') {
    const size = program ? roundUp(program.codeEnd - TEXT_BASE) : 0;
    return { start: TEXT_BASE, length: clamp(size, 256, 4096) };
  }
  if (state.region === 'stack') {
    return { start: STACK_TOP + 4 - 256, length: 256 };
  }
  const size = program ? roundUp(program.data.length) : 0;
  return { start: DATA_BASE, length: clamp(size, 256, 4096) };
}

function renderMemory() {
  const { start, length } = memoryWindow();
  const perRow = state.bytesPerRow;
  const sp = cpu.regs[29];
  const pc = cpu.halted ? -1 : cpu.pc;
  const parts = [];

  // column header: byte offsets within the row
  const offsets = [];
  for (let i = 0; i < perRow; i++) offsets.push(`<span${i % 4 === 3 ? ' class="gap"' : ''}>+${i.toString(16).toUpperCase()}</span>`);
  parts.push(`<div class="mem-row head" aria-hidden="true"><span class="mem-addr">${'addr'.padEnd(7)}</span><span class="mem-bytes">${offsets.join('')}</span><span class="mem-ascii">ascii</span></div>`);

  for (const row of cpu.memory.rows(start, length, perRow)) {
    const bytes = [];
    const ascii = [];
    row.bytes.forEach((byte, i) => {
      const address = row.address + i;
      const classes = [];
      if (byte === 0) classes.push('z');
      if (state.written.has(address)) classes.push('w');
      if (address >= sp && address < sp + 4 && state.region === 'stack') classes.push('sp');
      if (address >= pc && address < pc + 4 && state.region === 'code') classes.push('pc');
      if (i % 4 === 3) classes.push('gap');
      bytes.push(`<span class="${classes.join(' ')}">${hex(byte, 2)}</span>`);
      const char = escapeHtml(toPrintable(byte));
      ascii.push(state.written.has(address) ? `<span class="w">${char}</span>` : char);
    });
    parts.push(
      `<div class="mem-row" role="row"><span class="mem-addr" role="rowheader">${hex(row.address, 6)}:</span>` +
      `<span class="mem-bytes" role="cell">${bytes.join('')}</span>` +
      `<span class="mem-ascii" role="cell">${ascii.join('')}</span></div>`,
    );
  }
  el.memory.innerHTML = parts.join('');
  state.written.clear();
}

// ---- editor: line numbers and markers ----

function lineHeight() {
  return parseFloat(getComputedStyle(el.source).lineHeight) || 20;
}

function paddingTop() {
  return parseFloat(getComputedStyle(el.source).paddingTop) || 0;
}

function buildGutter() {
  const count = el.source.value.split('\n').length;
  if (el.gutter.childElementCount === count) return;
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(`<div>${i}</div>`);
  el.gutter.innerHTML = lines.join('');
}

/** The source line to highlight: the next instruction, or the last one once halted. */
function currentLine() {
  if (!state.program || state.dirty) return null;
  if (!cpu.halted) return cpu.lineForAddress.get(cpu.pc) ?? null;
  return cpu.lastStep && !cpu.error ? cpu.lastStep.line : null;
}

function renderEditorMarkers() {
  const line = currentLine();
  if (line !== state.shownLine && line !== null) scrollEditorTo(line);
  state.shownLine = line;
  positionMarkers();
}

function positionMarkers() {
  const line = state.shownLine;
  const scroll = el.source.scrollTop;
  const lh = lineHeight();
  const top = paddingTop();
  placeMarker(el.lineCurrent, line, top + (line - 1) * lh - scroll);
  el.lineCurrent.classList.toggle('done', cpu.halted);
  placeMarker(el.lineError, state.errorLine, top + (state.errorLine - 1) * lh - scroll);
  el.gutter.style.transform = `translateY(${-scroll}px)`;

  for (const marked of el.gutter.querySelectorAll('.current, .error')) marked.className = '';
  if (line) el.gutter.children[line - 1]?.classList.add('current');
  if (state.errorLine) el.gutter.children[state.errorLine - 1]?.classList.add('error');
}

function placeMarker(marker, line, y) {
  marker.hidden = !line;
  if (line) marker.style.transform = `translateY(${y}px)`;
}

/** Scroll the textarea so `line` is visible (without moving the page). */
function scrollEditorTo(line) {
  if (!line) return;
  const lh = lineHeight();
  const y = paddingTop() + (line - 1) * lh;
  const view = el.source;
  if (y < view.scrollTop || y + lh > view.scrollTop + view.clientHeight) {
    view.scrollTop = Math.max(0, y - view.clientHeight / 3);
  }
}

// ---- console ----

function log(text, kind = 'info') {
  const line = document.createElement('div');
  line.className = `log ${kind}`;
  line.textContent = text;
  addToConsole(line);
  state.outputBlock = null;
}

function appendOutput(text) {
  if (!state.outputBlock) {
    state.outputBlock = document.createElement('div');
    state.outputBlock.className = 'log output';
    addToConsole(state.outputBlock);
  }
  state.outputBlock.textContent += text;
  el.console.parentElement.scrollTop = el.console.parentElement.scrollHeight;
}

function addToConsole(node) {
  el.console.append(node);
  while (el.console.childElementCount > 300) el.console.firstElementChild.remove();
  el.console.parentElement.scrollTop = el.console.parentElement.scrollHeight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(value, digits) {
  return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function updateSpeedLabel() {
  const rate = SPEEDS[Number(el.speed.value)];
  const text = rate === Infinity ? 'Max' : `${rate}/s`;
  el.speedLabel.textContent = text;
  el.speed.setAttribute('aria-valuetext', rate === Infinity ? 'maximum speed' : `${rate} instructions per second`);
}

async function loadExample(id) {
  const example = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
  el.example.value = example.id;
  try {
    const response = await fetch(`examples/${example.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    el.source.value = (await response.text()).replace(/\r\n/g, '\n');
  } catch (err) {
    setStatus(`Could not load examples/${example.file} (${err.message}).`, 'error');
    return false;
  }
  el.source.scrollTop = 0;
  state.dirty = true;
  buildGutter();
  log(`Loaded ${example.file}: ${example.title}.`);
  return assembleSource();
}

/** Load a program passed in the URL as ?asm=<base64url of the UTF-8 source>. */
function loadShared(encoded) {
  let text;
  try {
    if (encoded.length > Math.ceil((MAX_SHARED_BYTES * 4) / 3) + 4) throw new Error('it is larger than 16 KB');
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length > MAX_SHARED_BYTES) throw new Error('it is larger than 16 KB');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    let reason = err.message;
    if (err.name === 'InvalidCharacterError') reason = 'it is not valid base64url';
    else if (err instanceof TypeError) reason = 'it is not valid UTF-8 text';
    const message = `Could not load the program from the link: ${reason}.`;
    setStatus(message, 'error');
    log(message, 'error');
    return false;
  }
  const option = new Option('Program from link', '', true, true);
  option.disabled = true; // pick an example to leave the linked program
  el.example.prepend(option);
  el.source.value = text.replace(/\r\n/g, '\n');
  el.source.scrollTop = 0;
  state.dirty = true;
  buildGutter();
  log(`Loaded a ${text.length.toLocaleString('en-US')}-character program from the link.`);
  return assembleSource();
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function wireEvents() {
  el.assemble.addEventListener('click', assembleSource);
  el.step.addEventListener('click', onStep);
  el.run.addEventListener('click', onRun);
  el.reset.addEventListener('click', onReset);
  el.clear.addEventListener('click', () => { el.console.innerHTML = ''; state.outputBlock = null; });
  el.example.addEventListener('change', () => { stopRunning(); loadExample(el.example.value); });
  el.speed.addEventListener('input', updateSpeedLabel);

  el.source.addEventListener('input', () => {
    if (!state.dirty && state.program) setStatus('Source edited. Press Assemble (or Step / Run) to load the changes.');
    state.dirty = true;
    state.errorLine = null;
    buildGutter();
    renderEditorMarkers();
    updateButtons();
  });
  el.source.addEventListener('scroll', positionMarkers);
  el.source.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      assembleSource();
    }
  });

  for (const button of document.querySelectorAll('[data-format]')) {
    button.addEventListener('click', () => {
      state.format = button.dataset.format;
      pressOne('[data-format]', button);
      renderRegisters();
    });
  }
  for (const button of document.querySelectorAll('[data-region]')) {
    button.addEventListener('click', () => {
      state.region = button.dataset.region;
      pressOne('[data-region]', button);
      renderMemory();
    });
  }

  // 8 bytes per memory row when the panel is narrow (phones).
  const memoryPanel = el.memory.closest('.panel');
  new ResizeObserver(() => {
    const perRow = memoryPanel.clientWidth < 560 ? 8 : 16;
    if (perRow !== state.bytesPerRow) {
      state.bytesPerRow = perRow;
      renderMemory();
    }
  }).observe(memoryPanel);
}

function pressOne(selector, pressed) {
  for (const button of document.querySelectorAll(selector)) {
    button.setAttribute('aria-pressed', String(button === pressed));
  }
}

async function start() {
  for (const example of EXAMPLES) {
    el.example.append(new Option(example.title, example.id));
  }
  buildRegisters();
  updateSpeedLabel();
  wireEvents();
  render();

  const params = new URLSearchParams(location.search);
  const ok = params.has('asm') ? loadShared(params.get('asm')) : await loadExample(params.get('example') || 'swap');
  if (!ok) return;

  if (params.get('autorun') === '1') {
    // Run to completion in one go; highlights then show everything that changed.
    while (stepOnce()) { /* keep going */ }
    render();
  } else if (Number(params.get('steps')) > 0) {
    const count = Math.min(Number(params.get('steps')), 100_000);
    for (let i = 1; i < count && stepOnce(); i++) { /* keep going */ }
    render();             // remember this state...
    onStep();             // ...so only the last instruction's changes are highlighted
  }
}

start();
