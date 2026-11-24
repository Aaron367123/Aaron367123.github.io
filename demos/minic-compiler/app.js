// app.js - browser UI for the Mini-C compiler.
//
// The compiler (./compiler/) and the emulator engine (./engine/) are
// byte-identical copies of the code in code/minic-compiler/src and
// code/mips-emulator/src, so the page runs exactly the tested code. This file
// only wires the editor and buttons to compile() and to the emulator's CPU.
//
// URL parameters (handy for embedding and screenshots):
//   ?example=fib        load an example (hello, fib, factorial, primes, sort, gcd, collatz, fizzbuzz, hanoi, expr)
//   ?run=1              compile and run on load
//   ?opt=0              start at -O0 (default -O1)
//   ?tab=ast|tokens     open another view
//   ?line=12            put the cursor on a source line (highlights its assembly)
//   ?theme=light|dark   force a colour theme (handled in index.html)

import { compile } from './compiler/index.js';
import { assemble } from './engine/assembler.js';
import { CPU } from './engine/cpu.js';
import { MipsError } from './engine/errors.js';

const EXAMPLES = [
  { id: 'hello', file: 'hello.mc', title: 'Hello, MIPS' },
  { id: 'fib', file: 'fibonacci.mc', title: 'Fibonacci (recursion + loop)' },
  { id: 'factorial', file: 'factorial.mc', title: 'Factorial and 32-bit wrap' },
  { id: 'primes', file: 'primes.mc', title: 'Prime sieve (global array)' },
  { id: 'sort', file: 'bubblesort.mc', title: 'Bubble sort' },
  { id: 'gcd', file: 'gcd.mc', title: 'GCD and LCM' },
  { id: 'collatz', file: 'collatz.mc', title: 'Collatz 3n + 1' },
  { id: 'fizzbuzz', file: 'fizzbuzz.mc', title: 'FizzBuzz + print_char' },
  { id: 'hanoi', file: 'hanoi.mc', title: 'Towers of Hanoi' },
  { id: 'expr', file: 'expressions.mc', title: 'Precedence and folding' },
];

const MAX_STEPS = 5_000_000;       // stop runaway loops
const MAX_LINK_BYTES = 16 * 1024;  // the emulator accepts ?asm= up to 16 KB
const COMPILE_DELAY = 300;         // ms of quiet typing before recompiling

const $ = (id) => document.getElementById(id);
const el = {
  example: $('example'),
  compile: $('btn-compile'),
  run: $('btn-run'),
  emulator: $('open-emulator'),
  led: $('led'),
  status: $('status'),
  statLines: $('stat-lines'),
  statIns: $('stat-ins'),
  statExec: $('stat-exec'),
  source: $('source'),
  gutter: $('gutter'),
  lineCurrent: $('line-current'),
  lineError: $('line-error'),
  cursorPos: $('cursor-pos'),
  asm: $('asm'),
  ast: $('ast'),
  tokens: $('tokens'),
  viewHint: $('view-hint'),
  diagnostics: $('diagnostics'),
  stdout: $('stdout'),
  runInfo: $('run-info'),
};

const params = new URLSearchParams(location.search);
const state = {
  optimize: params.get('opt') !== '0' && params.get('O') !== '0',
  result: null,          // last compile() result
  cursorLine: 1,
  astMode: 'optimized',
  tab: 'asm',
  timer: 0,
  hasRun: false,         // re-run automatically when -O changes after a run
};

// ---------------------------------------------------------------------------
// Compile and run
// ---------------------------------------------------------------------------

function compileNow() {
  clearTimeout(state.timer);
  const started = performance.now();
  const result = compile(el.source.value, { optimize: state.optimize });
  state.result = result;
  const ms = performance.now() - started;

  renderAsm();
  renderAst();
  renderTokens();
  renderDiagnostics();
  renderEditorMarks();
  updateEmulatorLink();

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.length - errors;
  if (result.ok) {
    const s = result.stats;
    el.statLines.textContent = fmt(s.asmLines);
    el.statIns.textContent = fmt(s.instructions);
    const w = warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
    setStatus(`Compiled at -O${state.optimize ? 1 : 0}: ${fmt(s.instructions)} instructions, ${fmt(s.words)} words of code${w} (${ms.toFixed(1)} ms).`, 'ok');
  } else {
    el.statLines.textContent = '–';
    el.statIns.textContent = '–';
    el.statExec.textContent = '–';
    setStatus(`${errors} error${errors === 1 ? '' : 's'}: see Output. Click an error to jump to it.`, 'error');
  }
  return result;
}

function run() {
  const result = compileNow();
  state.hasRun = true;
  el.stdout.textContent = '';
  if (!result.ok) {
    setRunInfo('Fix the errors above to run the program.', 'error');
    el.statExec.textContent = '–';
    return;
  }
  let program;
  try {
    program = assemble(result.asm);
  } catch (err) {
    if (!(err instanceof MipsError)) throw err;
    setRunInfo(`Assembler error (a compiler bug): ${err.describe()}`, 'error');
    return;
  }
  const cpu = new CPU();
  cpu.load(program);
  const started = performance.now();
  try {
    cpu.run(MAX_STEPS);
    el.stdout.textContent = cpu.output;
    const ms = performance.now() - started;
    const time = ms >= 0.1 ? ` in ${ms.toFixed(1)} ms` : '';
    setRunInfo(`Executed ${fmt(cpu.steps)} instructions${time} · ${cpu.haltReason} · -O${state.optimize ? 1 : 0}`, 'ok');
    setStatus(`Ran on the MIPS emulator: ${fmt(cpu.steps)} instructions executed.`, 'ok');
  } catch (err) {
    if (!(err instanceof MipsError)) throw err;
    el.stdout.textContent = cpu.output;
    const srcLine = err.line ? result.lineMap[err.line - 1] : null;
    const where = srcLine ? ` (Mini-C line ${srcLine})` : '';
    setRunInfo(`Run-time error after ${fmt(cpu.steps)} instructions${where}: ${err.message}`, 'error');
    setStatus(`Run-time error${where}: ${err.message}`, 'error');
    if (srcLine) moveCursor(srcLine, 1, false);
  }
  el.statExec.textContent = fmt(cpu.steps);
}

function scheduleCompile() {
  clearTimeout(state.timer);
  state.timer = setTimeout(compileNow, COMPILE_DELAY);
}

// ---------------------------------------------------------------------------
// Assembly view
// ---------------------------------------------------------------------------

function renderAsm() {
  const { result } = state;
  if (!result.asm) {
    el.asm.innerHTML = '<p class="empty">No assembly: the program has errors (see Output).</p>';
    return;
  }
  const lines = result.asm.replace(/\n$/, '').split('\n');
  el.asm.innerHTML = lines.map((text, i) => {
    const src = result.lineMap[i];
    const attr = src ? ` data-line="${src}"` : '';
    return `<div class="l"${attr}>${highlightAsm(text) || ' '}</div>`;
  }).join('');
  highlightAsmFor(state.cursorLine, false);
}

/** Colour one line of assembly: labels, mnemonics, registers, numbers, comments. */
function highlightAsm(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) {
    const cls = /^#\s*line \d+:/.test(trimmed) ? 'src' : 'hdr';
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }
  let html = '';
  let rest = line;
  const label = /^([A-Za-z_][\w.]*:)/.exec(rest);
  if (label) {
    html += `<span class="lbl">${escapeHtml(label[1])}</span>`;
    rest = rest.slice(label[1].length);
  }
  // Split off a trailing # note (but not a # inside a string literal).
  let code = rest;
  let note = '';
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\' && quoted) i++;
    else if (rest[i] === '"') quoted = !quoted;
    else if (rest[i] === '#' && !quoted) {
      code = rest.slice(0, i);
      note = rest.slice(i);
      break;
    }
  }
  const head = /^(\s*)(\.?[a-z]+)?(.*)$/i.exec(code);
  html += escapeHtml(head[1]);
  if (head[2]) html += `<span class="${head[2].startsWith('.') ? 'dir' : 'op'}">${escapeHtml(head[2])}</span>`;
  html += head[3].replace(/("(?:[^"\\]|\\.)*")|(\$[a-z0-9]+)|(-?\b(?:0x[0-9a-f]+|\d+)\b)|([^"$\d-]+|[\s\S])/gi, (m, str, reg, num) => {
    if (str) return `<span class="str">${escapeHtml(str)}</span>`;
    if (reg) return `<span class="reg">${reg}</span>`;
    if (num) return `<span class="num">${num}</span>`;
    return escapeHtml(m);
  });
  if (note) html += `<span class="note">${escapeHtml(note)}</span>`;
  return html;
}

/** Highlight the assembly generated for one Mini-C line (and scroll to it). */
function highlightAsmFor(line, scroll = true) {
  let first = null;
  for (const row of el.asm.querySelectorAll('.l.hl')) row.classList.remove('hl');
  for (const row of el.asm.querySelectorAll(`.l[data-line="${line}"]`)) {
    row.classList.add('hl');
    first ??= row;
  }
  const count = el.asm.querySelectorAll('.l.hl').length;
  if (state.tab === 'asm') el.viewHint.textContent = count ? `line ${line} → ${count} asm line${count === 1 ? '' : 's'}` : 'click a line → source';
  if (scroll && first) keepVisible(el.asm.parentElement, first);
}

// ---------------------------------------------------------------------------
// AST view: a collapsible tree built from <details> elements
// ---------------------------------------------------------------------------

// Child fields of each node kind, in source order.
const AST_FIELDS = {
  Program: ['globals', 'functions'],
  Function: ['body'],
  Block: ['body'],
  DeclStmt: ['decls'],
  VarDecl: ['init'],
  ArrayDecl: ['size', 'init'],
  Assign: ['target', 'value'],
  ExprStmt: ['expr'],
  If: ['cond', 'then', 'else'],
  While: ['cond', 'body'],
  For: ['init', 'cond', 'update', 'body'],
  Return: ['value'],
  Unary: ['operand'],
  Binary: ['left', 'right'],
  Call: ['args'],
  Index: ['index'],
};

function renderAst() {
  const { result } = state;
  const ast = state.astMode === 'parsed' ? result.ast : (result.optimizedAst ?? result.ast);
  el.ast.textContent = '';
  if (!ast) {
    el.ast.innerHTML = '<p class="empty">No AST: the program has a syntax error (see Output).</p>';
    return;
  }
  el.ast.append(astNode(ast, '', 0));
}

function astNode(node, field, depth) {
  const children = [];
  for (const name of AST_FIELDS[node.kind] ?? []) {
    const value = node[name];
    if (Array.isArray(value)) value.forEach((child, i) => children.push([`${name}[${i}]`, child]));
    else if (value) children.push([name, value]);
  }
  const label = `${field ? `<span class="field">${escapeHtml(field)}: </span>` : ''}${astLabel(node)}`
    + (node.line ? `<span class="pos">${node.line}:${node.col}</span>` : '');
  if (children.length === 0) {
    const leaf = document.createElement('div');
    leaf.className = 'leaf';
    leaf.innerHTML = label;
    return leaf;
  }
  const details = document.createElement('details');
  details.open = depth < 5;
  const summary = document.createElement('summary');
  summary.innerHTML = label;
  details.append(summary);
  for (const [name, child] of children) details.append(astNode(child, name, depth + 1));
  return details;
}

function astLabel(n) {
  const kind = `<span class="kind">${n.kind}</span>`;
  const info = (text) => ` <span class="info">${escapeHtml(text)}</span>`;
  const sym = (text) => ` <span class="sym">→ ${escapeHtml(text)}</span>`;
  const where = (s) => {
    if (!s) return '';
    if (s.kind === 'local') return sym(`${s.isParam ? 'param' : 'local'} ${s.offset}($fp)`);
    if (s.kind === 'global' || s.kind === 'array') return sym(`${s.kind} ${s.label}`);
    if (s.kind === 'builtin') return sym(`syscall ${s.syscall}`);
    return sym(`jal ${s.label}`);
  };
  switch (n.kind) {
    case 'Program': return kind + info(`${n.globals.length} global(s), ${n.functions.length} function(s)`);
    case 'Function': return kind + info(`${n.name}(${n.params.map((p) => p.name).join(', ')})`) + sym(`frame ${n.frameSize ?? '?'} bytes`);
    case 'VarDecl': return kind + info(n.name) + where(n.symbol);
    case 'ArrayDecl': return kind + info(`${n.name}[${n.symbol?.size ?? '?'}]`) + where(n.symbol);
    case 'Assign': return kind + info(n.form ?? n.op);
    case 'Number': return kind + info(n.text && n.text !== String(n.value) ? `${n.value}  (${n.text})` : String(n.value));
    case 'String': return kind + info(JSON.stringify(n.value));
    case 'Identifier': return kind + info(n.name) + where(n.symbol);
    case 'Index': return kind + info(`${n.name}[…]`) + where(n.symbol);
    case 'Unary':
    case 'Binary': return kind + info(n.op);
    case 'Call': return kind + info(`${n.name}()`) + where(n.symbol);
    default: return kind;
  }
}

// ---------------------------------------------------------------------------
// Tokens and diagnostics
// ---------------------------------------------------------------------------

function renderTokens() {
  const tokens = state.result.tokens ?? [];
  el.tokens.innerHTML = tokens.map((t) => {
    const value = t.type === 'int' && t.text !== String(t.value) ? String(t.value)
      : t.type === 'string' ? JSON.stringify(t.value) : '';
    return `<tr><td>${t.line}:${t.col}</td><td class="t-${t.type}">${t.type}</td>`
      + `<td class="t-${t.type}">${escapeHtml(t.text || '(end)')}</td><td>${escapeHtml(value)}</td></tr>`;
  }).join('');
}

function renderDiagnostics() {
  el.diagnostics.textContent = '';
  for (const d of state.result.diagnostics) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `diag ${d.severity}`;
    button.setAttribute('aria-label', `${d.severity} at line ${d.line}, column ${d.col}: ${d.message}. Jump to it.`);
    const context = d.text.split('\n').slice(1).join('\n');
    button.innerHTML = `<span class="where">${d.severity} ${d.line}:${d.col}</span> ${escapeHtml(d.message)}`
      + (context ? `<pre>${escapeHtml(context)}</pre>` : '');
    button.addEventListener('click', () => moveCursor(d.line, d.col, true));
    el.diagnostics.append(button);
  }
  if (!state.result.ok) {
    el.stdout.textContent = '';
    setRunInfo('', '');
  }
}

function setRunInfo(text, kind) {
  el.runInfo.textContent = text;
  el.runInfo.className = `run-info ${kind}`;
}

// ---------------------------------------------------------------------------
// "Open in MIPS emulator": the assembly travels in the URL as base64url
// ---------------------------------------------------------------------------

function updateEmulatorLink() {
  const { result } = state;
  const disable = (why) => {
    el.emulator.setAttribute('aria-disabled', 'true');
    el.emulator.removeAttribute('href');
    el.emulator.title = why;
  };
  if (!result.ok) return disable('Fix the errors first');

  let bytes = new TextEncoder().encode(result.asm);
  if (bytes.length > MAX_LINK_BYTES) bytes = new TextEncoder().encode(compactAsm(result.asm));
  if (bytes.length > MAX_LINK_BYTES) return disable('The program is too large to pass in a link (16 KB)');

  const query = new URLSearchParams({ asm: base64url(bytes) });
  const theme = params.get('theme');
  if (theme) query.set('theme', theme);
  el.emulator.href = `../mips-emulator/index.html?${query}`;
  el.emulator.removeAttribute('aria-disabled');
  el.emulator.title = 'Open the generated assembly in the MIPS emulator to step through it';
}

/** Drop comment lines and trailing notes (never inside a .asciiz string). */
function compactAsm(asm) {
  return asm.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => (line.includes('"') ? line : line.replace(/\s+#.*$/, '')))
    .join('\n');
}

function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Editor: line numbers, cursor line, error marker
// ---------------------------------------------------------------------------

function lineHeight() {
  return parseFloat(getComputedStyle(el.source).lineHeight) || 20;
}

function paddingTop() {
  return parseFloat(getComputedStyle(el.source).paddingTop) || 0;
}

function buildGutter() {
  const count = el.source.value.split('\n').length;
  if (el.gutter.childElementCount !== count) {
    const rows = [];
    for (let i = 1; i <= count; i++) rows.push(`<div>${i}</div>`);
    el.gutter.innerHTML = rows.join('');
  }
  renderEditorMarks();
}

function errorLines() {
  return (state.result?.diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => d.line);
}

function renderEditorMarks() {
  const scroll = el.source.scrollTop;
  const lh = lineHeight();
  const top = paddingTop();
  const place = (marker, line) => {
    marker.hidden = !line;
    if (line) marker.style.transform = `translateY(${top + (line - 1) * lh - scroll}px)`;
  };
  const errors = errorLines();
  place(el.lineCurrent, state.cursorLine);
  place(el.lineError, errors[0] ?? null);
  el.gutter.style.transform = `translateY(${-scroll}px)`;
  for (const row of el.gutter.querySelectorAll('.current, .error')) row.className = '';
  el.gutter.children[state.cursorLine - 1]?.classList.add('current');
  for (const line of errors) el.gutter.children[line - 1]?.classList.add('error');
}

function onCursor() {
  const before = el.source.value.slice(0, el.source.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  el.cursorPos.textContent = `Ln ${line}, Col ${col}`;
  if (line !== state.cursorLine) {
    state.cursorLine = line;
    highlightAsmFor(line);
  }
  renderEditorMarks();
}

/** Put the cursor at line:col and make it visible. */
function moveCursor(line, col, focus) {
  const lines = el.source.value.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  offset += Math.max(0, Math.min(col - 1, (lines[line - 1] ?? '').length));
  if (focus) el.source.focus({ preventScroll: true });
  el.source.setSelectionRange(offset, offset);
  const y = paddingTop() + (line - 1) * lineHeight();
  const view = el.source;
  if (y < view.scrollTop || y + lineHeight() > view.scrollTop + view.clientHeight) {
    view.scrollTop = Math.max(0, y - view.clientHeight / 3);
  }
  onCursor();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.parentElement.className = `status ${kind === 'ok' ? 'success' : kind}`;
  el.led.className = `led ${kind}`;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Scroll `container` (not the page) so that `child` is visible. */
function keepVisible(container, child) {
  const box = container.getBoundingClientRect();
  const item = child.getBoundingClientRect();
  if (item.top < box.top || item.bottom > box.bottom) {
    container.scrollTop += item.top - box.top - container.clientHeight / 3;
  }
}

function selectTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  if (name === 'asm') highlightAsmFor(state.cursorLine, false);
  else if (name === 'ast') el.viewHint.textContent = state.astMode === 'parsed' ? 'as parsed' : `after the -O${state.optimize ? 1 : 0} optimiser`;
  else el.viewHint.textContent = `${fmt(state.result?.tokens?.length ?? 0)} tokens`;
}

function pressOne(selector, pressed) {
  for (const button of document.querySelectorAll(selector)) button.setAttribute('aria-pressed', String(button === pressed));
}

async function loadExample(id) {
  const example = EXAMPLES.find((e) => e.id === id || e.file === id || e.file === `${id}.mc`) ?? EXAMPLES[1];
  el.example.value = example.id;
  try {
    const response = await fetch(`examples/${example.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    el.source.value = (await response.text()).replace(/\r\n/g, '\n');
  } catch (err) {
    setStatus(`Could not load examples/${example.file} (${err.message}). Serve this folder over HTTP.`, 'error');
    return false;
  }
  el.source.scrollTop = 0;
  state.cursorLine = 1;
  el.stdout.textContent = '';
  setRunInfo('', '');
  el.statExec.textContent = '–';
  state.hasRun = false;
  compileNow();
  buildGutter();
  return true;
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function wireEvents() {
  el.compile.addEventListener('click', compileNow);
  el.run.addEventListener('click', run);
  el.example.addEventListener('change', () => loadExample(el.example.value));

  el.source.addEventListener('input', () => {
    buildGutter();
    onCursor();
    scheduleCompile();
    if (el.runInfo.textContent) setRunInfo('Source changed: press Run to execute the new version.', '');
  });
  for (const type of ['click', 'keyup', 'select', 'focus']) el.source.addEventListener(type, onCursor);
  el.source.addEventListener('scroll', renderEditorMarks);
  el.source.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) run();
      else compileNow();
    }
  });

  // Click an assembly line to jump to the Mini-C line that produced it.
  el.asm.addEventListener('click', (event) => {
    const row = event.target.closest('.l[data-line]');
    if (row) moveCursor(Number(row.dataset.line), 1, false);
  });

  for (const button of document.querySelectorAll('[data-opt]')) {
    button.addEventListener('click', () => {
      state.optimize = button.dataset.opt === '1';
      pressOne('[data-opt]', button);
      if (state.hasRun) run();
      else compileNow();
      if (state.tab === 'ast') selectTab('ast');
    });
  }
  for (const button of document.querySelectorAll('[data-ast]')) {
    button.addEventListener('click', () => {
      state.astMode = button.dataset.ast;
      pressOne('[data-ast]', button);
      renderAst();
      selectTab('ast');
    });
  }
  $('ast-expand').addEventListener('click', () => el.ast.querySelectorAll('details').forEach((d) => { d.open = true; }));
  $('ast-collapse').addEventListener('click', () => el.ast.querySelectorAll('details').forEach((d) => { d.open = false; }));

  // Tabs: click, or arrow keys between them (WAI-ARIA tabs pattern).
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      selectTab(next.id.slice(4));
    });
  });

  new ResizeObserver(renderEditorMarks).observe(el.source);
}

async function start() {
  for (const example of EXAMPLES) el.example.append(new Option(example.title, example.id));
  pressOne('[data-opt]', document.querySelector(`[data-opt="${state.optimize ? 1 : 0}"]`));
  wireEvents();

  const ok = await loadExample(params.get('example') || 'fib');
  if (!ok) return;
  const tab = params.get('tab');
  if (tab === 'ast' || tab === 'tokens') selectTab(tab);
  if (params.get('run') === '1') run();
  const line = Number(params.get('line'));
  if (line > 0) moveCursor(line, 1, false);
}

start();
