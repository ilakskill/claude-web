// Speech-to-text for /ws/voice: owns one long-lived sidecar process (src/hub/stt-sidecar.py,
// faster-whisper) and talks line-delimited JSON to it (protocol: see the sidecar's docstring).
// Started lazily by the first request, stopped after `idleMinutes` without one, restarted by the
// next request after a crash. Nothing here throws into the server: every failure is a rejected
// promise whose message is short and safe to show to the browser.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const noopLog = { info() {}, warn() {}, error() {} };

export const DEFAULT_SIDECAR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stt-sidecar.py');
export const START_TIMEOUT_MS = 180_000; // the first run may download the model
export const REQUEST_TIMEOUT_MS = 60_000; // default; config voice.requestTimeoutSeconds
// -P: do not put the script's directory (src/hub/) on sys.path. Not -I or -s: on this PC
// faster-whisper lives in the user site-packages, which those flags hide (review fix 2).
export const PYTHON_ARGS = Object.freeze(['-P']);
export const WARM_COOLDOWN_MS = 5 * 60_000; // a sidecar that failed to start is not warmed again for this long (a request still tries)
const STOP_GRACE_MS = 2000;
const STDERR_LINE_MAX = 400;

/**
 * @param {object} o
 * @param {object} o.voice validated voice config (config.js normalizeVoice): python, model, device,
 *   language, idleMinutes, requestTimeoutSeconds
 * @param {string} [o.sidecar] sidecar script (default src/hub/stt-sidecar.py)
 * @param {string} [o.command] interpreter (default voice.python); tests pass node and a fake sidecar
 * @param {string[]} [o.commandArgs] arguments placed before the sidecar path (default: PYTHON_ARGS
 *   for voice.python, none for a custom command)
 * @param {object} [o.log]
 * @param {Function} [o.spawnImpl] child_process.spawn replacement (tests)
 * @param {number} [o.startTimeoutMs] time allowed to reach `ready` (default 180 s)
 * @param {number} [o.idleMs] override of voice.idleMinutes (tests)
 * @param {number} [o.requestTimeoutMs] override of voice.requestTimeoutSeconds (tests)
 */
export function createStt({
  voice, sidecar = DEFAULT_SIDECAR, command, commandArgs, log, spawnImpl = nodeSpawn,
  startTimeoutMs = START_TIMEOUT_MS, idleMs, requestTimeoutMs, now = Date.now,
} = {}) {
  if (!voice) throw new TypeError('voice config is required');
  const lg = log || noopLog;
  const idle = idleMs ?? (voice.idleMinutes > 0 ? voice.idleMinutes * 60_000 : 0);
  const requestTimeout = requestTimeoutMs ?? (voice.requestTimeoutSeconds > 0 ? voice.requestTimeoutSeconds * 1000 : REQUEST_TIMEOUT_MS);
  const exe = command || voice.python;
  const exeArgs = commandArgs ?? (command ? [] : [...PYTHON_ARGS]);

  let child = null; // the sidecar process
  let state = 'stopped'; // 'stopped' | 'starting' | 'ready'
  let info = null; // the ready line (model, device, compute, loadMs)
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const queued = []; // requests received while starting: {line, resolve, reject, id}
  const outbox = []; // lines accepted but not yet written (stdin backpressure)
  let draining = false; // waiting for stdin 'drain'
  let startTimer = null;
  let idleTimer = null;
  let stopping = null; // Promise while stop() runs
  let expectedExit = false; // stop() asked the child to exit: its exit is not a crash
  let lastError = null;
  let failedAt = 0; // when the sidecar last failed before it was ready: warm() leaves it alone for WARM_COOLDOWN_MS

  function clearIdle() { clearTimeout(idleTimer); idleTimer = null; }
  function armIdle() {
    clearIdle();
    if (!idle || !child || pending.size) return;
    idleTimer = setTimeout(() => {
      if (pending.size) return;
      lg.info(`stt: idle for ${Math.round(idle / 1000)} s, stopping the transcriber`);
      stop().catch(() => {});
    }, idle);
    idleTimer.unref?.();
  }

  function failAll(message) {
    const err = new Error(message);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    outbox.length = 0;
    for (const { reject } of queued.splice(0)) reject(err);
  }

  function reset() {
    clearTimeout(startTimer); startTimer = null;
    clearIdle();
    child = null;
    state = 'stopped';
    info = null;
    draining = false;
    outbox.length = 0;
  }

  function start() {
    const args = [...exeArgs, sidecar, '--model', String(voice.model), '--device', String(voice.device), '--language', String(voice.language)];
    let proc;
    try {
      proc = spawnImpl(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      lastError = `cannot start the transcriber: ${e?.message || e}`;
      lg.error(`stt: ${lastError}`);
      return false;
    }
    child = proc;
    state = 'starting';
    lastError = null;
    expectedExit = false;
    lg.info(`stt: starting ${exe} ${args.join(' ')}`);
    const me = proc;
    proc.on('error', (e) => {
      if (child !== me) return;
      lastError = `cannot start the transcriber: ${e?.message || e}`;
      lg.error(`stt: ${lastError} (${exe})`);
      if (state !== 'ready') failedAt = now();
      failAll(lastError);
      reset();
    });
    proc.on('exit', (code, signal) => {
      if (child !== me) return;
      const why = `transcriber exited (${signal || `code ${code}`})`;
      if (expectedExit) lg.info(`stt: ${why}`);
      else lg.warn(`stt: ${why}${lastError ? `: ${lastError}` : ''}`);
      if (!expectedExit && state !== 'ready') failedAt = now();
      failAll(lastError || why);
      reset();
    });
    proc.stdin?.on('error', () => {}); // EPIPE after an exit: the exit handler reports it
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => { if (child === me) onLine(line); });
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (line) => {
      const t = String(line).trim();
      if (t) lg.warn(`stt sidecar: ${t.slice(0, STDERR_LINE_MAX)}`);
    });
    startTimer = setTimeout(() => {
      if (child !== me || state !== 'starting') return;
      lastError = `transcriber did not become ready within ${Math.round(startTimeoutMs / 1000)} s`;
      lg.error(`stt: ${lastError}`);
      try { me.kill(); } catch { /* gone */ }
    }, startTimeoutMs);
    startTimer.unref?.();
    return true;
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { lg.warn(`stt: unparseable line from the sidecar: ${String(line).slice(0, 120)}`); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ready') {
      clearTimeout(startTimer); startTimer = null;
      state = 'ready';
      failedAt = 0;
      info = { model: msg.model, device: msg.device, compute: msg.compute, loadMs: msg.loadMs };
      lg.info(`stt: ready (model ${msg.model}, ${msg.device}/${msg.compute}, loaded in ${msg.loadMs} ms)`);
      for (const q of queued.splice(0)) write(q);
      armIdle();
      return;
    }
    if (msg.t === 'fatal') {
      lastError = `transcriber failed to start: ${String(msg.error || 'unknown error').slice(0, 300)}`;
      lg.error(`stt: ${lastError}`);
      return; // the exit that follows rejects everything with lastError
    }
    if (msg.t === 'pong') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ text: typeof msg.text === 'string' ? msg.text : '', language: msg.language || '', ms: Number(msg.ms) || 0 });
    else p.reject(new Error(`transcription failed: ${String(msg.error || 'unknown error').slice(0, 300)}`));
    armIdle();
  }

  /**
   * A request that gets no reply within requestTimeout: the sidecar is wedged (or the GPU is), so
   * it is killed; its exit rejects every other pending request and the next request restarts it.
   * The idle timer is therefore never suppressed for longer than one request timeout.
   */
  function onRequestTimeout(q) {
    if (!pending.has(q.id)) return;
    pending.delete(q.id);
    const secs = Math.round(requestTimeout / 1000);
    q.reject(new Error(`transcription timed out after ${secs} s; restarting the transcriber`));
    lastError = `transcription timed out after ${secs} s`;
    lg.warn(`stt: request ${q.id} timed out after ${secs} s, killing the transcriber`);
    const proc = child;
    // Torn down now, not when the exit event arrives: the state is 'stopped' at once and the next
    // request starts a fresh process; the old one's exit is ignored (child !== me).
    failAll(lastError);
    reset();
    if (proc) { try { proc.kill(); } catch { /* gone */ } }
  }

  /** Accepts a request: pending from now on, written to stdin as backpressure allows. */
  function write(q) {
    q.timer = setTimeout(() => onRequestTimeout(q), requestTimeout);
    q.timer.unref?.();
    pending.set(q.id, q);
    clearIdle();
    outbox.push(q);
    pump();
  }

  /** Writes queued lines until stdin asks to wait ('drain'); one 5 MB line can fill the pipe. */
  function pump() {
    if (draining || !child) return;
    while (outbox.length) {
      const q = outbox.shift();
      if (!pending.has(q.id)) continue; // timed out while waiting its turn
      let ok;
      try {
        ok = child.stdin.write(q.line);
      } catch (e) {
        pending.delete(q.id);
        clearTimeout(q.timer);
        q.reject(new Error(`transcriber unavailable: ${e?.message || e}`));
        continue;
      }
      if (!ok) {
        draining = true;
        child.stdin.once('drain', () => { draining = false; pump(); });
        return;
      }
    }
  }

  /**
   * @param {Buffer|Uint8Array} pcm PCM16 LE mono 16 kHz
   * @param {{language?: string}} [o]
   * @returns {Promise<{text: string, language: string, ms: number}>}
   */
  function transcribe(pcm, { language } = {}) {
    return new Promise((resolve, reject) => {
      if (stopping) { reject(new Error('transcriber is stopping')); return; }
      if (!child && !start()) { reject(new Error(lastError || 'cannot start the transcriber')); return; }
      const id = nextId++;
      const line = JSON.stringify({ id, op: 'transcribe', pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'), language: language || voice.language }) + '\n';
      const q = { id, line, resolve, reject };
      if (state === 'ready') write(q);
      else queued.push(q);
    });
  }

  /**
   * Starts the sidecar now (import and model load) without a request, so the first utterance does
   * not wait for it. A no-op while it runs or is starting; a start that failed is reported by the
   * next transcribe(), not thrown. Also re-arms the idle timer, so a page that has Talk on keeps it.
   * @returns {boolean} true when a process is running or starting afterwards
   */
  function warm() {
    if (stopping) return false;
    if (!child) return failedAt > 0 && now() - failedAt < WARM_COOLDOWN_MS ? false : start();
    if (state === 'ready') armIdle();
    return true;
  }

  /** Asks the sidecar to exit, kills it after a grace period. Resolves once it is gone. */
  function stop() {
    if (!child) return Promise.resolve();
    if (stopping) return stopping;
    const proc = child;
    if (proc.exitCode !== null || proc.signalCode) return Promise.resolve(); // its exit handler is already queued
    expectedExit = true;
    failAll('transcriber stopped');
    stopping = new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, STOP_GRACE_MS);
      t.unref?.();
      proc.once('exit', () => { clearTimeout(t); stopping = null; resolve(); });
      try { proc.stdin.end(JSON.stringify({ op: 'stop' }) + '\n'); } catch { try { proc.kill(); } catch { /* gone */ } }
    });
    return stopping;
  }

  return {
    transcribe,
    warm,
    stop,
    /** @returns {{state: string, model?: string, device?: string, compute?: string, pending: number, lastError: string|null}} */
    status() {
      return { state, ...(info || {}), pending: pending.size + queued.length, unsent: outbox.length, lastError };
    },
  };
}
