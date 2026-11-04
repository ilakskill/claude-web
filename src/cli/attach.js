// Terminal attach client: shows a hub session inside the current console (Windows Terminal).
//
// Input: plain raw mode. On Node 24 setRawMode(true) sets ENABLE_WINDOW_INPUT |
// ENABLE_VIRTUAL_TERMINAL_INPUT, so keys arrive as VT bytes. The session stream turns on
// win32-input-mode (ESC[?9001h) in our console too; from then on every key arrives as a record
// ESC[Vk;Sc;Uc;Kd;Cs;Rc_ (key-ups and modifier-only events included). Records are forwarded
// verbatim: the session's ConPTY decodes them back into the exact key events, so Claude gets the
// same input it would get running natively. Only the detach chord (Ctrl+\) is parsed here.
// Evidence: docs/evidence (attach spike results).
//
// Output: binary frames are written to stdout unchanged; `init` clears the screen and writes the
// hub's serialized screen (which carries Claude's own alt-screen and mode sequences).
import WebSocket from 'ws';
import { COOKIE_NAME } from '../hub/auth.js';

/** Exit codes of attach(). */
export const EXIT_DETACHED = 0;
export const EXIT_UNREACHABLE = 2;
export const EXIT_NOT_TTY = 3;
export const EXIT_NOT_FOUND = 4;

/**
 * Leaves the alt screen and undoes every mode a TUI may have turned on in our console:
 * win32-input-mode (without ?9001l the parent shell would receive key records), focus reports,
 * mouse modes, bracketed paste, cursor visibility. The brief's required sequence is REQUIRED_RESTORE;
 * RESTORE adds SGR reset, the other mouse/theme modes, the kitty keyboard pop and normal cursor/keypad
 * modes (the spike's list) in front of it.
 */
export const REQUIRED_RESTORE = '\x1b[?9001l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l';
export const RESTORE = `\x1b[0m\x1b[?1016l\x1b[?2031l\x1b[<u\x1b[?1l\x1b>${REQUIRED_RESTORE}`;

/** Soft reset, clear, home: the visible screen then equals the hub's once init.data is written. */
export const CLEAR = '\x1b[!p\x1b[2J\x1b[H';

/**
 * Written before CLEAR on a reconnect resync: modes the session may have turned off while we were
 * away must not survive; init.data turns the current ones back on.
 */
export const MODE_RESET = '\x1b[?9001l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l';

const CTRL_BACKSLASH = 0x1c;
const RECORD_RE = /\x1b\[([\d;]*)_/g; // win32-input-mode key record
const PARTIAL_RE = /\x1b(\[[\d;]*)?$/; // a record (or CSI) cut off at the end of a chunk, even right after ESC

/**
 * Parses the parameters of a win32-input-mode record (`Vk;Sc;Uc;Kd;Cs;Rc`, omitted = default).
 * @returns {{vk:number, sc:number, uc:number, kd:number, cs:number, rc:number}}
 */
export function parseRecord(params) {
  const p = String(params).split(';');
  const n = (i, d) => (p[i] === undefined || p[i] === '' ? d : Number(p[i]));
  return { vk: n(0, 0), sc: n(1, 0), uc: n(2, 0), kd: n(3, 0), cs: n(4, 0), rc: n(5, 1) };
}

/** True when `text` holds a key-down record for Ctrl+\ (UnicodeChar 28). */
export function hasDetachRecord(text) {
  for (const m of String(text).matchAll(RECORD_RE)) {
    const r = parseRecord(m[1]);
    if (r.uc === 28 && r.kd === 1) return true;
  }
  return false;
}

/**
 * Splits stdin chunks into bytes to forward and the detach chord.
 * - A chunk that is exactly 0x1C (Ctrl+\ in plain VT input) detaches.
 * - A chunk holding a Ctrl+\ key-down record detaches; the whole chunk is dropped.
 * - A chunk ending in a lone ESC or an unterminated `ESC[digits;…` is held back (at most maxPending
 *   bytes) and joined with the next chunk, so a record split across two reads is still recognized.
 * @returns {{push(chunk:Buffer):{forward:Buffer|null, detach:boolean}, flush():Buffer, pending():number}}
 */
export function createInputFilter({ maxPending = 64 } = {}) {
  let held = Buffer.alloc(0);
  return {
    push(chunk) {
      if (chunk.length === 1 && chunk[0] === CTRL_BACKSLASH) {
        held = Buffer.alloc(0);
        return { forward: null, detach: true };
      }
      const buf = held.length ? Buffer.concat([held, chunk]) : chunk;
      held = Buffer.alloc(0);
      const text = buf.toString('latin1');
      if (hasDetachRecord(text)) return { forward: null, detach: true };
      const m = PARTIAL_RE.exec(text);
      if (m && buf.length - m.index <= maxPending) {
        held = Buffer.from(buf.subarray(m.index));
        const forward = buf.subarray(0, m.index);
        return { forward: forward.length ? forward : null, detach: false };
      }
      return { forward: buf, detach: false };
    },
    flush() {
      const out = held;
      held = Buffer.alloc(0);
      return out;
    },
    pending() {
      return held.length;
    },
  };
}

const realTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
  now: () => Date.now(),
};

const defaultWsFactory = (url, options) => new WebSocket(url, { handshakeTimeout: 5000, ...options });

const OPEN = 1; // WebSocket.OPEN

/**
 * Attaches the given TTY streams to a hub session until detach, session exit or hub loss.
 * Never rejects.
 * @param {object} o
 * @param {string} o.id          session id (8 hex)
 * @param {number} [o.index]     session number, for messages
 * @param {string} o.hubUrl      http://127.0.0.1:<port>
 * @param {string} o.token       login token (sent as a Cookie header, never printed)
 * @param {import('node:stream').Readable & {isTTY?:boolean, setRawMode?:Function}} o.stdin
 * @param {import('node:stream').Writable & {isTTY?:boolean, columns?:number, rows?:number}} o.stdout
 * @param {import('node:stream').Writable} [o.stderr]  for the not-a-TTY refusal (default stdout)
 * @param {Function} [o.wsFactory]  (url, {headers}) => WebSocket-like; injected for tests
 * @param {object} [o.timers]       {setTimeout, clearTimeout, setInterval, clearInterval, now}
 * @param {object} [o.proc]         EventEmitter for the emergency 'exit' restore (default process)
 * @returns {Promise<number>} 0 detached, the session's exit code, 2 hub unreachable, 3 not a TTY,
 *   4 session not found, 1 other errors
 */
export async function attach({
  id, index, hubUrl, token, stdin, stdout, stderr = stdout,
  wsFactory = defaultWsFactory, timers = realTimers, proc = process,
  pingMs = 25_000, deadMs = 60_000, tickMs = 5_000, retryMs = 1_000, retryForMs = 10_000,
  resizeDebounceMs = 50, flushMs = 100, drainMs = 150,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    stderr.write('cw: terminal attach needs an interactive console (stdin and stdout must be a terminal); '
      + 'use --web to open the session in the browser\n');
    return EXIT_NOT_TTY;
  }
  const label = Number.isInteger(index) ? `#${index}` : id;
  const reattach = Number.isInteger(index) ? index : id;
  const wsBase = String(hubUrl).replace(/^http/, 'ws').replace(/\/+$/, '');

  return new Promise((resolve) => {
    const filter = createInputFilter();
    let ws = null;
    let gotInit = false;
    let resync = false; // true once the first init was drawn: later inits are resyncs
    let done = false;
    let screenRestored = false;
    let lastSeen = timers.now();
    let lastPing = timers.now();
    let lostAt = null;
    let retryTimer = null;
    let giveUpTimer = null;
    let resizeTimer = null;
    let flushTimer = null;
    const tick = timers.setInterval(() => guard(onTick), tickMs);

    const write = (s) => { try { stdout.write(s); } catch { /* console gone */ } };
    const size = () => ({ cols: stdout.columns || 120, rows: stdout.rows || 35 });
    const sendControl = (obj) => {
      if (ws && ws.readyState === OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* close follows */ } }
    };
    const sendInput = (buf) => {
      if (ws && ws.readyState === OPEN && gotInit) { try { ws.send(buf, { binary: true }); } catch { /* close follows */ } }
    };
    const clear = (t, clr) => { if (t !== null) clr(t); return null; };

    function guard(fn, ...args) {
      try { fn(...args); } catch (e) { finish(1, `[cw] error: ${e?.message || e}`); }
    }

    function restoreScreen() {
      if (screenRestored) return;
      screenRestored = true;
      write(RESTORE);
    }
    function restoreInput() {
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* console gone */ }
      try { stdin.pause(); } catch { /* ignore */ }
    }
    // Last resort for an exit we did not see coming (uncaught exception elsewhere, process.exit).
    const onProcessExit = () => { restoreScreen(); restoreInput(); };
    // Ctrl+Break (SIGBREAK) and closing the console (SIGHUP) would otherwise end the process with
    // the terminal still in raw/win32-input-mode; beforeExit means the event loop drained while
    // attached (should not happen). All take the normal restore path.
    const onSignal = (sig) => {
      finish(1, `[cw] ${sig}: client stopped; session ${label} keeps running. Reattach: cw attach ${reattach}`);
    };
    const onBeforeExit = () => onSignal('event loop drained');
    const SIGNALS = ['SIGBREAK', 'SIGHUP'];
    const discard = () => {};

    function finish(code, msg) {
      if (done) return;
      done = true;
      timers.clearInterval(tick);
      retryTimer = clear(retryTimer, timers.clearTimeout);
      giveUpTimer = clear(giveUpTimer, timers.clearTimeout);
      resizeTimer = clear(resizeTimer, timers.clearTimeout);
      flushTimer = clear(flushTimer, timers.clearTimeout);
      stdout.off?.('resize', onResize);
      proc.off?.('exit', onProcessExit);
      for (const sig of SIGNALS) proc.off?.(sig, onSignal);
      proc.off?.('beforeExit', onBeforeExit);
      const s = ws;
      ws = null;
      if (s) {
        try {
          if (s.readyState === OPEN) s.close(1000, 'detach');
          else s.terminate?.();
        } catch { /* gone */ }
      }
      stdin.off('data', onData);
      // Keep reading (and dropping) input briefly: key-up records typed before our ?9001l reached
      // the console would otherwise land in the parent shell as `ESC[..;..;.._` garbage.
      stdin.on('data', discard);
      restoreScreen();
      if (msg) write(`\r\n${msg}\r\n`);
      const end = () => {
        stdin.off('data', discard);
        restoreInput();
        resolve(code);
      };
      if (drainMs > 0) timers.setTimeout(end, drainMs);
      else end();
    }

    function banner(text) {
      const { rows } = size();
      // Bottom line, cursor saved/restored; the next init repaints the whole screen anyway.
      write(`\x1b7\x1b[${rows};1H\x1b[0m\x1b[2K${text}\x1b8`);
    }

    function lost() {
      if (done) return;
      gotInit = false;
      if (lostAt === null) {
        lostAt = timers.now();
        banner('[cw] connection lost, retrying…');
        giveUpTimer = timers.setTimeout(() => guard(giveUp), retryForMs);
      }
      if (retryTimer === null) {
        retryTimer = timers.setTimeout(() => { retryTimer = null; guard(connect); }, retryMs);
      }
    }

    function giveUp() {
      giveUpTimer = null;
      finish(EXIT_UNREACHABLE, '[cw] hub unreachable; session may still be running: cw ls');
    }

    function connect() {
      if (done) return;
      const { cols, rows } = size();
      const url = `${wsBase}/ws/session/${encodeURIComponent(id)}?kind=local&cols=${cols}&rows=${rows}`;
      let sock;
      try {
        sock = wsFactory(url, { headers: { cookie: `${COOKIE_NAME}=${token}` } });
      } catch {
        lost();
        return;
      }
      ws = sock;
      lastSeen = timers.now();
      let httpError = null;
      sock.on('message', (data, isBinary) => { if (sock === ws) guard(onMessage, data, isBinary); });
      sock.on('error', (e) => {
        const m = /Unexpected server response: (\d+)/.exec(e?.message || '');
        if (m) httpError = Number(m[1]);
      });
      sock.on('close', (code, reason) => { if (sock === ws) guard(onClose, code, String(reason ?? ''), httpError); });
    }

    function onMessage(data, isBinary) {
      lastSeen = timers.now();
      if (isBinary) {
        write(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg?.t === 'init') {
        gotInit = true;
        if (lostAt !== null) {
          lostAt = null;
          giveUpTimer = clear(giveUpTimer, timers.clearTimeout);
        }
        if (resync) write(MODE_RESET);
        resync = true;
        write(CLEAR);
        if (typeof msg.data === 'string' && msg.data) write(msg.data);
        sendControl({ t: 'resize', ...size() });
      } else if (msg?.t === 'exit') {
        const code = Number.isInteger(msg.code) ? msg.code : 1;
        finish(code, `[cw] session ${label} exited (code ${msg.code ?? 'unknown'})`);
      }
      // 'resize' from the hub: another client owns the size; a console cannot follow it.
      // 'pong': only refreshes lastSeen.
    }

    function onClose(code, reason, httpError) {
      ws = null;
      if (done) return;
      if (code === 4404 || httpError === 404) {
        finish(EXIT_NOT_FOUND, `[cw] session ${label} not found (see: cw ls)`);
      } else if (code === 4401 || httpError === 401) {
        finish(1, '[cw] the hub refused the login token (revoked?); see: cw token ls');
      } else {
        lost();
      }
    }

    function onTick() {
      if (!ws || ws.readyState !== OPEN) return;
      const now = timers.now();
      if (now - lastSeen >= deadMs) {
        const s = ws;
        ws = null;
        try { s.terminate?.(); } catch { /* gone */ }
        lost();
        return;
      }
      if (now - lastPing >= pingMs) {
        lastPing = now;
        sendControl({ t: 'ping' });
      }
    }

    function onResize() {
      resizeTimer = clear(resizeTimer, timers.clearTimeout);
      resizeTimer = timers.setTimeout(() => { resizeTimer = null; sendControl({ t: 'resize', ...size() }); }, resizeDebounceMs);
    }

    function onData(chunk) {
      guard(() => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        flushTimer = clear(flushTimer, timers.clearTimeout);
        const r = filter.push(b);
        if (r.detach) {
          finish(EXIT_DETACHED, `[cw] detached from ${label}; reattach: cw attach ${reattach}`);
          return;
        }
        if (r.forward) sendInput(r.forward);
        if (filter.pending()) {
          flushTimer = timers.setTimeout(() => {
            flushTimer = null;
            const p = filter.flush();
            if (p.length) sendInput(p);
          }, flushMs);
        }
      });
    }

    proc.on?.('exit', onProcessExit);
    for (const sig of SIGNALS) proc.on?.(sig, onSignal);
    proc.on?.('beforeExit', onBeforeExit);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.on?.('resize', onResize);
      connect();
    } catch (e) {
      finish(1, `[cw] error: ${e?.message || e}`);
    }
  });
}
