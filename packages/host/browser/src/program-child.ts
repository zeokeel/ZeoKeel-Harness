import { spawn as spawnProcess } from 'node:child_process'
import { createPtcProgramRuntime } from './program-ptc.ts'
import type { ProgramRuntime } from './program.ts'

/**
 * Child-process bootstrap for the restricted executor (2026-10-23, decision B).
 *
 * The child is a normal Node process (so the VM is the only barrier): this source
 * builds a vm context with a context-realm bridge exactly like
 * `program-restricted.ts`, and talks to the host over the JSON-line protocol in
 * `program-ptc.ts` (`{type:'call'|'console'|'result'|'error'}`). The host callback
 * is a CHILD-realm function that is placed in a temporary global and deleted by
 * the bootstrap before user code runs, so the context never sees it.
 * @module @zeokeel/dsh-browser
 */

/**
 * Build the bootstrap source the host spawns with `node -e`.
 * @param helperNames - bridge helper names exposed as `browser.*`.
 * @returns a self-contained JavaScript program reading JSON lines from stdin.
 */
export function childBootstrapSource(helperNames: readonly string[]): string {
  return `'use strict';
const vm = require('node:vm');
const pending = new Map();
let invite = 0;
const write = (message) => { process.stdout.write(JSON.stringify(message) + '\\n'); };
const callHelper = (helper, args) => new Promise((resolve, reject) => {
  const id = ++invite;
  pending.set(id, { resolve, reject });
  write({ type: 'call', id, tool: helper, args });
});
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
context['__hostInvoke'] = (kind, payload, level) => {
  if (kind === '__console__') { write({ type: 'console', text: payload }); return Promise.resolve('null'); }
  return callHelper(kind, JSON.parse(payload)).then(
    (value) => JSON.stringify({ value: value === undefined ? null : value }),
    (error) => {
      const readString = (v, fallback) => { try { return typeof v === 'string' ? v : fallback; } catch { return fallback; } };
      let code = 'error', message = 'unknown error';
      try { code = readString(error && error.code, 'error'); message = readString(error && error.message, 'unknown error'); } catch {}
      return JSON.stringify({ __error: true, code, message });
    },
  );
};
vm.runInContext(\`(() => {
  const host = globalThis['__hostInvoke'];
  delete globalThis['__hostInvoke'];
  const serialize = (value) => { try { return JSON.stringify(value); } catch { return '"<unserializable>"'; } };
  const log = (level) => (...args) => { void host('__console__', args.map(serialize).join(' '), level); };
  const consoleObj = Object.freeze({ log: log('log'), error: log('error'), warn: log('warn'), info: log('info') });
  const browser = {};
  for (const name of ${JSON.stringify([...helperNames])}) {
    browser[name] = async (...args) => {
      const raw = await host(name, JSON.stringify(args.length === 0 ? [] : args));
      const envelope = JSON.parse(raw);
      if (envelope !== null && typeof envelope === 'object' && envelope.__error === true) {
        const error = new Error(String(envelope.message));
        error.code = String(envelope.code);
        throw error;
      }
      return envelope === null || typeof envelope !== 'object' ? null : envelope.value;
    };
  }
  Object.freeze(browser);
  Object.defineProperty(globalThis, 'browser', { value: browser, enumerable: false, configurable: false, writable: false });
  Object.defineProperty(globalThis, 'console', { value: consoleObj, enumerable: false, configurable: false, writable: false });
})()\`, context, { timeout: 1000 });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'program' && typeof message.program === 'string') {
      void executeProgram(message.program);
      continue;
    }
    const item = pending.get(message.id);
    if (item === undefined) continue;
    pending.delete(message.id);
    if (message.error !== undefined) {
      const error = new Error(String(message.error));
      if (typeof message.code === 'string') error.code = message.code;
      item.reject(error);
    } else {
      item.resolve(message.result);
    }
  }
});
process.stdin.on('end', () => { write({ type: 'error', message: 'browser_run: the host closed the bridge' }); });
// The program arrives as the FIRST stdin line (never argv: argv is visible in
// ps and bounded by ARG_MAX). Everything else on stdin is a bridge response.
const executeProgram = async (source) => {
  try {
    const value = await vm.runInContext('(async () => {' + String.fromCharCode(10) + source + String.fromCharCode(10) + '})()', context, { timeout: 120000, displayErrors: false });
    write({ type: 'result', result: value === undefined ? null : value });
  } catch (cause) {
    let message = 'program failed';
    try { message = cause instanceof Error ? cause.message : String(cause); } catch { /* keep default */ }
    write({ type: 'error', message });
  }
};
`
}

/**
 * The production wiring for `browser_run`: a restricted executor running in a
 * real Node child (decision B). The host callback surface is the program bridge
 * handed to `execute`, so helpers reach the runtime through the normal path.
 * @param helperNames - helper names the child exposes as `browser.*`.
 * @returns a ProgramRuntime backed by the restricted child bootstrap.
 */
export function createRestrictedProgramRuntime(
  helperNames: readonly string[],
): ProgramRuntime {
  const source = childBootstrapSource(helperNames)
  return createPtcProgramRuntime({
    spawn: () => {
      const child = spawnProcess(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
      const exit = new Promise<number>((resolve) => { child.on('exit', code => resolve(code ?? 0)) })
      return { stdin: child.stdin, stdout: child.stdout, kill: () => { child.kill('SIGKILL') }, exit }
    },
  })
}
