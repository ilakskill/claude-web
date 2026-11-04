// Text-to-speech for Talk mode: owns one long-lived sidecar process per engine (src/hub/tts-sidecar.py:
// Kokoro, and Piper as the fallback) and talks line-delimited JSON to it (protocol: see the sidecar's
// docstring). Same lifecycle as stt.js: started lazily by the first request, stopped after
// `idleMinutes` without one, restarted by the next request after a crash. Nothing here throws into
// the server: every failure is a rejected promise whose message is short and safe to show.
//
// Engines are tried in order. An engine that cannot start (missing model, import error) is skipped
// for COOLDOWN_MS so a broken primary does not delay every request by its start timeout.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const noopLog = { info() {}, warn() {}, error() {} };

export const DEFAULT_SIDECAR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-sidecar.py');
export const START_TIMEOUT_MS = 90_000; // model load; nothing is downloaded
export const REQUEST_TIMEOUT_MS = 60_000;
export const COOLDOWN_MS = 5 * 60_000;
// -P: keep src/hub/ off sys.path. Not -I or -s: kokoro-onnx and piper-tts live in the user
// site-packages on this PC (see stt.js PYTHON_ARGS).
export const PYTHON_ARGS = Object.freeze(['-P']);
const STOP_GRACE_MS = 2000;
const STDERR_LINE_MAX = 400;

/**
 * The engines for a validated voice config (config.js normalizeVoice), in the order to try them.
 * 'browser' has none: the page speaks.
 * @returns {{name: string, command: string, args: string[]}[]}
 */
export function enginesFor(voice, { sidecar = DEFAULT_SIDECAR } = {}) {
  if (!voice || voice.ttsEngine === 'browser') return [];
  const python = voice.ttsPython || voice.python;
  const make = (name) => ({
    name,
    command: python,
    args: [...PYTHON_ARGS, sidecar, '--engine', name, '--threads', String(voice.ttsThreads ?? 8), '--voice', String(voice.ttsVoice ?? 'af_heart'),
      ...(name === 'kokoro' ? ['--kokoro-model', voice.kokoroModel, '--kokoro-voices', voice.kokoroVoices] : ['--piper-model', voice.piperModel])],
  });
  const list = [make(voice.ttsEngine)];
  if (voice.ttsFallback === 'piper' && voice.ttsEngine !== 'piper') list.push(make('piper'));
  return list;
}

/** One sidecar process: lazy start, request queue, idle stop, restart after a crash. */
function createWorker({ spec, log, spawnImpl, startTimeoutMs, idleMs, requestTimeoutMs, now }) {
  const lg = log || noopLog;
  let child = null;
  let state = 'stopped'; // 'stopped' | 'starting' | 'ready'
  let info = null;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}: what the sidecar is working on (at most one: it is serial)
  const waiting = []; // accepted, not yet sent. Held here, not in the pipe, so a newer reply can overtake or drop them
  let startTimer = null;
  let idleTimer = null;
  let stopping = null;
  let expectedExit = false;
  let lastError = null;
  let failedAt = 0; // when the engine last failed to start

  function clearIdle() { clearTimeout(idleTimer); idleTimer = null; }
  function armIdle() {
    clearIdle();
    if (!idleMs || !child || pending.size || waiting.length) return;
    idleTimer = setTimeout(() => {
      if (pending.size || waiting.length) return;
      lg.info(`tts ${spec.name}: idle for ${Math.round(idleMs / 1000)} s, stopping the synthesizer`);
      stop().catch(() => {});
    }, idleMs);
    idleTimer.unref?.();
  }
  function failAll(message) {
    const err = new Error(message);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    for (const { reject } of waiting.splice(0)) reject(err);
  }
  function reset() {
    clearTimeout(startTimer); startTimer = null;
    clearIdle();
    child = null; state = 'stopped'; info = null;
  }
  function start() {
    let proc;
    try {
      proc = spawnImpl(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      lastError = `cannot start the ${spec.name} synthesizer: ${e?.message || e}`;
      failedAt = now();
      lg.error(`tts: ${lastError}`);
      return false;
    }
    child = proc; state = 'starting'; lastError = null; expectedExit = false;
    lg.info(`tts ${spec.name}: starting ${spec.command}`);
    const me = proc;
    const wasReady = () => state === 'ready';
    proc.on('error', (e) => {
      if (child !== me) return;
      lastError = `cannot start the ${spec.name} synthesizer: ${e?.message || e}`;
      lg.error(`tts: ${lastError}`);
      if (!wasReady()) failedAt = now();
      failAll(lastError); reset();
    });
    proc.on('exit', (code, signal) => {
      if (child !== me) return;
      const why = `${spec.name} synthesizer exited (${signal || `code ${code}`})`;
      if (expectedExit) lg.info(`tts: ${why}`); else lg.warn(`tts: ${why}${lastError ? `: ${lastError}` : ''}`);
      if (!expectedExit && !wasReady()) failedAt = now();
      failAll(lastError || why); reset();
    });
    proc.stdin?.on('error', () => {});
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => { if (child === me) onLine(line); });
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (line) => {
      const t = String(line).trim();
      if (t) lg.warn(`tts sidecar (${spec.name}): ${t.slice(0, STDERR_LINE_MAX)}`);
    });
    startTimer = setTimeout(() => {
      if (child !== me || state !== 'starting') return;
      lastError = `${spec.name} synthesizer did not become ready within ${Math.round(startTimeoutMs / 1000)} s`;
      lg.error(`tts: ${lastError}`);
      try { me.kill(); } catch { /* gone */ }
    }, startTimeoutMs);
    startTimer.unref?.();
    return true;
  }
  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { lg.warn(`tts: unparseable line from the ${spec.name} sidecar`); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ready') {
      clearTimeout(startTimer); startTimer = null;
      state = 'ready';
      failedAt = 0;
      info = { engine: msg.engine || spec.name, loadMs: msg.loadMs, providers: msg.providers };
      lg.info(`tts: ${spec.name} ready (${Array.isArray(msg.providers) ? msg.providers.join(',') : '?'}, loaded in ${msg.loadMs} ms)`);
      dispatch();
      armIdle();
      return;
    }
    if (msg.t === 'fatal') {
      lastError = `${spec.name} synthesizer failed to start: ${String(msg.error || 'unknown error').slice(0, 300)}`;
      lg.error(`tts: ${lastError}`);
      return; // the exit that follows rejects everything with lastError
    }
    if (msg.t === 'pong') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ ms: Number(msg.ms) || 0, seconds: Number(msg.seconds) || 0, rate: Number(msg.rate) || 0 });
    else p.reject(new Error(`synthesis failed: ${String(msg.error || 'unknown error').slice(0, 300)}`));
    dispatch();
    armIdle();
  }
  function onRequestTimeout(q) {
    if (!pending.has(q.id)) return;
    pending.delete(q.id);
    const secs = Math.round(requestTimeoutMs / 1000);
    q.reject(new Error(`synthesis timed out after ${secs} s; restarting the ${spec.name} synthesizer`));
    lastError = `synthesis timed out after ${secs} s`;
    lg.warn(`tts: request ${q.id} timed out after ${secs} s, killing the ${spec.name} synthesizer`);
    const proc = child;
    failAll(lastError); reset();
    if (proc) { try { proc.kill(); } catch { /* gone */ } }
  }
  function write(q) {
    q.timer = setTimeout(() => onRequestTimeout(q), requestTimeoutMs);
    q.timer.unref?.();
    pending.set(q.id, q);
    clearIdle();
    try {
      child.stdin.write(q.line);
    } catch (e) {
      pending.delete(q.id); clearTimeout(q.timer);
      q.reject(new Error(`synthesizer unavailable: ${e?.message || e}`));
    }
  }
  /** True when a should be sent before b: the lower priority array (element by element), then the earlier arrival. */
  function before(a, b) {
    const n = Math.max(a.priority.length, b.priority.length);
    for (let i = 0; i < n; i++) {
      const x = a.priority[i] ?? 0;
      const y = b.priority[i] ?? 0;
      if (x !== y) return x < y;
    }
    return a.id < b.id;
  }
  /**
   * Sends the best waiting request when the sidecar is free. A request whose turn was replaced by a
   * newer reply (isStale) is dropped here, before it costs any synthesis time.
   */
  function dispatch() {
    if (state !== 'ready' || pending.size || !child) return;
    for (;;) {
      let best = -1;
      for (let i = 0; i < waiting.length; i++) if (best < 0 || before(waiting[i], waiting[best])) best = i;
      if (best < 0) return;
      const [q] = waiting.splice(best, 1);
      let stale = false;
      try { stale = !!q.isStale?.(); } catch { stale = false; }
      if (stale) { q.reject(Object.assign(new Error('superseded by a newer reply'), { superseded: true })); continue; }
      write(q);
      return;
    }
  }
  function request(payload, { priority = [], isStale } = {}) {
    return new Promise((resolve, reject) => {
      if (stopping) { reject(new Error('synthesizer is stopping')); return; }
      if (!child && !start()) { reject(new Error(lastError || 'cannot start the synthesizer')); return; }
      const id = nextId++;
      waiting.push({ id, line: JSON.stringify({ id, op: 'synthesize', ...payload }) + '\n', resolve, reject, priority, isStale });
      clearIdle();
      dispatch();
    });
  }
  /** Starts the process now (model load and warm-up) without a request; a no-op when running. */
  function warm() {
    if (!child && !stopping) start();
  }
  function stop() {
    if (!child) return Promise.resolve();
    if (stopping) return stopping;
    const proc = child;
    if (proc.exitCode !== null || proc.signalCode) return Promise.resolve();
    expectedExit = true;
    failAll('synthesizer stopped');
    stopping = new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, STOP_GRACE_MS);
      t.unref?.();
      proc.once('exit', () => { clearTimeout(t); stopping = null; resolve(); });
      try { proc.stdin.end(JSON.stringify({ op: 'stop' }) + '\n'); } catch { try { proc.kill(); } catch { /* gone */ } }
    });
    return stopping;
  }
  return {
    name: spec.name,
    request,
    warm,
    stop,
    /** True while a start failure is recent enough that trying again is pointless. */
    coolingDown: () => failedAt > 0 && now() - failedAt < COOLDOWN_MS && !child,
    status: () => ({ name: spec.name, state, ...(info || {}), pending: pending.size + waiting.length, lastError }),
  };
}

/**
 * @param {object} o
 * @param {object} o.voice validated voice config (config.js normalizeVoice)
 * @param {{name: string, command: string, args: string[]}[]} [o.engines] default enginesFor(voice); tests pass node and a fake sidecar
 * @param {object} [o.log]
 * @param {Function} [o.spawnImpl]
 * @param {number} [o.startTimeoutMs]
 * @param {number} [o.idleMs] override of voice.idleMinutes
 * @param {number} [o.requestTimeoutMs] override of voice.requestTimeoutSeconds
 * @param {Function} [o.now]
 */
export function createTts({
  voice, engines, log, spawnImpl = nodeSpawn, startTimeoutMs = START_TIMEOUT_MS, idleMs, requestTimeoutMs, now = Date.now,
} = {}) {
  if (!voice) throw new TypeError('voice config is required');
  const lg = log || noopLog;
  const idle = idleMs ?? (voice.idleMinutes > 0 ? voice.idleMinutes * 60_000 : 0);
  const reqTimeout = requestTimeoutMs ?? (voice.requestTimeoutSeconds > 0 ? voice.requestTimeoutSeconds * 1000 : REQUEST_TIMEOUT_MS);
  const specs = engines ?? enginesFor(voice);
  const workers = specs.map((spec) => createWorker({ spec, log: lg, spawnImpl, startTimeoutMs, idleMs: idle, requestTimeoutMs: reqTimeout, now }));

  /**
   * Writes a WAV of `text` to `out`.
   * @param {string} text
   * @param {string} out absolute path chosen by the hub (never from a client)
   * @param {{voice?: string, speed?: number, priority?: number[], isStale?: () => boolean}} [o]
   *   priority: lower arrays are synthesized first (the sidecar does one request at a time).
   *   isStale: asked again when the request's turn comes; true drops it, and the promise rejects
   *   with an error whose .superseded is true (no fallback engine is tried for it).
   * @returns {Promise<{ms: number, seconds: number, engine: string, fellBack: boolean}>}
   */
  async function synthesize(text, out, { voice: name, speed, priority, isStale } = {}) {
    if (!workers.length) throw new Error('no speech synthesizer is configured');
    const payload = { text, out, voice: name ?? voice.ttsVoice, speed: speed ?? voice.ttsSpeed ?? 1 };
    let firstError = null;
    let tried = 0;
    for (const [i, w] of workers.entries()) {
      if (w.coolingDown() && i < workers.length - 1) continue;
      tried++;
      try {
        const r = await w.request(payload, { priority, isStale });
        return { ...r, engine: w.name, fellBack: i > 0 };
      } catch (e) {
        if (e?.superseded) throw e; // not a failure: no fallback engine for it
        firstError ??= e;
        lg.warn(`tts: ${w.name} failed: ${e?.message || e}${i < workers.length - 1 ? '; trying the next engine' : ''}`);
      }
    }
    throw firstError || new Error(tried ? 'speech synthesis failed' : 'no speech synthesizer is available');
  }

  /** Starts the first usable engine in the background, so the first reply does not wait for the model. */
  function warm() {
    const w = workers.find((x) => !x.coolingDown());
    if (w) w.warm(); // every engine recently failed to start: a request still tries, a page poll does not
  }

  return {
    synthesize,
    warm,
    stop: () => Promise.all(workers.map((w) => w.stop())).then(() => {}),
    /** @returns {{state: string, engines: object[]}} state: 'absent' | 'stopped' | 'starting' | 'ready' */
    status() {
      const engs = workers.map((w) => w.status());
      const state = !engs.length ? 'absent' : engs.some((e) => e.state === 'ready') ? 'ready' : engs.some((e) => e.state === 'starting') ? 'starting' : 'stopped';
      return { state, engines: engs };
    },
    get configured() { return workers.length > 0; },
  };
}
