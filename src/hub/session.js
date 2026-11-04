// One PTY-backed session: node-pty (ConPTY) child + @xterm/headless screen state + attached
// clients with a single size owner (see resize-policy.js). No networking here; the server
// (Task 3) owns sockets and maps clientIds to them.
import crypto from 'node:crypto';
import { pickOwner, createResizer } from './resize-policy.js';
import { createModeTracker } from './modes.js';
import { buildSpawnEnv, DEFAULT_STRIP_ENV } from './spawn-env.js';
import { SNIPPET_KEEP, OSC52_LABEL, parseOsc52 } from './snippets.js';

export const MIN_COLS = 20;
export const MIN_ROWS = 5;
// Upper bounds guard the headless terminal against absurd allocations from a buggy client.
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const KILL_TIMEOUT_MS = 3000;
const CTRL_C_GAP_MS = 100; // Claude needs two separate Ctrl+C presses to exit
const HARD_KILL_GRACE_MS = 2000; // after pty.kill(), give up waiting for the exit event

export function validSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols >= MIN_COLS && rows >= MIN_ROWS && cols <= MAX_COLS && rows <= MAX_ROWS;
}

// Bytes a terminal emulator sends on its own, not typed by a person: focus reports (mode 1004),
// DA1/DA2 replies, cursor position reports, DSR status replies (ESC[0n, ESC[?..n), DECRQM mode
// replies (ESC[?N;M$y and ESC[N;M$y), kitty keyboard flag replies, DCS replies (XTVERSION
// ESC P>|..., DECRQSS ESC P1$r..., XTGETTCAP ESC P1+r..., all ending in ST) and OSC replies.
// Spike A/B: every attached tab emits these, so they must not count as user activity.
const PASSIVE_RE = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*[cR]|\x1b\[\??[\d;]*n|\x1b\[\??[\d;]*\$y|\x1b\[\?[\d;]*u|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

/** True if the input consists only of terminal-generated reports/replies (not user keystrokes). */
export function isPassiveInput(bytes) {
  if (bytes == null) return false;
  const s = typeof bytes === 'string' ? bytes
    : Buffer.isBuffer(bytes) ? bytes.toString('latin1') : Buffer.from(bytes).toString('latin1');
  return s.length > 0 && PASSIVE_RE.test(s);
}

export const NOTIFY_GRACE_MS = 3000;

/**
 * A terminal title worth showing, or null. ConPTY itself sets the title to the running program's
 * path (`C:\nvm4w\nodejs\node.exe`), which says nothing: paths and *.exe/.cmd/.bat names are dropped.
 */
export function cleanTermTitle(t) {
  if (typeof t !== 'string') return null;
  const s = t.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^[A-Za-z]:[\\/]/.test(s) || /^[\\/]/.test(s) || /\.(exe|cmd|bat|com)(\s|$)/i.test(s)) return null;
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

let ptyModule = null;
/** Default ptyFactory: node-pty's spawn, loaded lazily so unit tests never load the native module. */
export async function defaultPtyFactory(command, args, opts) {
  ptyModule ??= await import('node-pty');
  const spawn = ptyModule.spawn ?? ptyModule.default?.spawn;
  return spawn(command, args, opts);
}

let xtermModules = null;
/**
 * Default termFactory: @xterm/headless Terminal (scrollback 5000, allowProposedApi) with the
 * serialize addon. Returns {write, resize, serialize, flush, onReply, onNotify, onTitle, onClipboard, dispose}. The terminal's own
 * replies to queries (onReply) reach the PTY only when the Session has answerQueries enabled.
 */
export async function defaultTermFactory({ cols, rows }) {
  xtermModules ??= await Promise.all([import('@xterm/headless'), import('@xterm/addon-serialize')]);
  const [headless, serialize] = xtermModules;
  const Terminal = headless.Terminal ?? headless.default.Terminal;
  const SerializeAddon = serialize.SerializeAddon ?? serialize.default.SerializeAddon;
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  // Notifications the program asks for: BEL, and the OSC 9 (iTerm2/ConEmu), 777 (rxvt `notify`)
  // and 99 (kitty) escapes. The parser knows a BEL that ends an OSC string from a real bell, which
  // a byte scan would not. Handlers return true so the sequences are consumed (nothing to render).
  // The text is the program's (untrusted); it only leaves as the opt-in push body (server.js).
  const notifyCbs = [];
  const titleCbs = [];
  const emit = (kind, text) => { for (const cb of notifyCbs) { try { cb({ kind, text: String(text ?? '') }); } catch { /* a listener must not break parsing */ } } };
  term.onBell(() => emit('bell', ''));
  term.parser.registerOscHandler(9, (data) => {
    // ConEmu's OSC 9;<n>;... (progress bars 9;4, cwd 9;9, ...) is not a notification.
    if (!/^\d{1,2}(?:;|$)/.test(data)) emit('osc', data);
    return true;
  });
  term.parser.registerOscHandler(777, (data) => {
    const m = /^notify;([^;]*)(?:;([\s\S]*))?$/.exec(data);
    if (m) emit('osc', m[2] || m[1]);
    return true;
  });
  term.parser.registerOscHandler(99, (data) => {
    const i = data.indexOf(';');
    emit('osc', i >= 0 ? data.slice(i + 1) : '');
    return true;
  });
  term.onTitleChange((t) => { for (const cb of titleCbs) { try { cb(t); } catch { /* ignore */ } } });
  // OSC 52 clipboard writes (`52;<selection>;<base64>`, BEL or ST): the raw payload goes to the
  // Session, which keeps real writes as snippets (snippets.js parseOsc52 drops the `?` query). Only
  // this headless copy consumes it; clients still get the PTY bytes unchanged.
  const clipboardCbs = [];
  term.parser.registerOscHandler(52, (data) => {
    for (const cb of clipboardCbs) { try { cb(data); } catch { /* a listener must not break parsing */ } }
    return true;
  });
  return {
    onNotify: (cb) => { notifyCbs.push(cb); },
    onTitle: (cb) => { titleCbs.push(cb); },
    onClipboard: (cb) => { clipboardCbs.push(cb); },
    write: (data, cb) => term.write(data, cb),
    resize: (c, r) => term.resize(c, r),
    serialize: () => serializer.serialize(),
    // The text of the bottom `n` rows of the screen, top to bottom (trailing spaces trimmed). The
    // Focus view (codex-focus.js) looks for an approval prompt there.
    screenLines: (n) => {
      const b = term.buffer.active;
      const end = b.baseY + term.rows;
      const out = [];
      for (let y = Math.max(0, end - n); y < end; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
      return out;
    },
    // Resolves once xterm has parsed everything written so far (its write queue is async).
    flush: () => new Promise((resolve) => term.write('', resolve)),
    onReply: (cb) => term.onData(cb),
    dispose: () => term.dispose(),
  };
}

const noop = () => {};

export class Session {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {number} o.index
   * @param {string} o.cwd
   * @param {string} o.command
   * @param {string[]} [o.args]
   * @param {number} [o.cols] initial size (default 120x30; invalid sizes fall back to the default)
   * @param {number} [o.rows]
   * @param {object} [o.env] base environment (default process.env); stripped via buildSpawnEnv
   * @param {number} o.hubPort required; exported to the child as CW_HUB_PORT (throws if not 1-65535)
   * @param {string[]} [o.stripEnv] env names to strip (default DEFAULT_STRIP_ENV; `X_*` = prefix)
   * @param {Function} [o.ptyFactory] (command, args, opts) => pty (may be async)
   * @param {Function} [o.termFactory] ({cols, rows}) => {write, resize, serialize, flush?} (may be async)
   * @param {(bytes:Buffer)=>void} [o.onData]
   * @param {(code:number|null)=>void} [o.onExit]
   * @param {(cols:number, rows:number, ownerId:string)=>void} [o.onResize] only on a real size change
   * @param {boolean} [o.answerQueries] write the headless terminal's query replies (DA1 etc.) to the
   *   PTY. ConPTY holds back all child output until its startup DA1 query (ESC[c) is answered, so
   *   without this a session shows nothing until a client attaches and replies (verified in Task 2).
   * @param {(snippet:object, session:Session)=>void} [o.onSnippet] a snippet was added (addSnippet or OSC 52)
   */
  constructor({
    id, index, cwd, command, args = [], cols, rows, env = process.env, hubPort, stripEnv = DEFAULT_STRIP_ENV,
    answerQueries = false, userTitle = null, spawn = null, harness = null, model = null,
    ptyFactory = null, termFactory = null, onData = noop, onExit = noop, onResize = noop,
    onNotify = noop, onChange = noop, onSnippet = noop, notifyGraceMs = NOTIFY_GRACE_MS,
    now = Date.now, setTimeoutImpl, clearTimeoutImpl, resizeDelayMs = 50, killTimeoutMs = KILL_TIMEOUT_MS,
  } = {}) {
    if (!id) throw new TypeError('id is required');
    if (!command) throw new TypeError('command is required');
    if (!cwd) throw new TypeError('cwd is required');
    // Required: hooks in the child reach the hub via CW_HUB_PORT; omitting it silently would break
    // notifications for any hub not on the default port.
    if (!Number.isInteger(hubPort) || hubPort < 1 || hubPort > 65535) {
      throw new TypeError('hubPort is required (integer 1-65535)');
    }
    this.id = id;
    this.index = index;
    this.cwd = cwd;
    this.command = command;
    this.args = [...args];
    this.startedAt = null;
    this.endedAt = null;
    this.state = 'running';
    this.exitCode = null;
    this.claudeSessionId = null;
    // Which preset started this (src/shared/harnesses.js id) and with which model; the harness's
    // own session id (Codex, reported by its hook) for exact resume; the title the program set on
    // the terminal (OSC 0/2), used only when there is no better one.
    this.harness = typeof harness === 'string' ? harness : null;
    this.model = typeof model === 'string' ? model : null;
    this.harnessSessionId = null;
    this.termTitle = null;
    this.needsInput = false;
    // Transcript metadata (hub-maintained, see transcripts.js): null/false until known.
    this.title = null;
    this.firstPrompt = null;
    this.hasTranscript = false;
    // The user's own name (set via rename); transcript refreshes never touch it.
    this.userTitle = typeof userTitle === 'string' ? userTitle : null;
    this._lastActivityMs = null; // last PTY output or user input
    /** Text to copy on the phone (snippets.js), oldest first, at most SNIPPET_KEEP; memory only. */
    this.snippets = [];
    const ok = validSize(cols, rows);
    this.cols = ok ? cols : DEFAULT_COLS;
    this.rows = ok ? rows : DEFAULT_ROWS;
    /** @type {Map<string,{id:string, cols:number|null, rows:number|null, lastActivity:number, name:any, kind:any}>} */
    this.clients = new Map();
    this.sizeOwner = null;
    this.pty = null;
    this.term = null;

    this._env = env;
    this._hubPort = hubPort;
    this._stripEnv = stripEnv;
    this._ptyFactory = ptyFactory;
    this._spawn = spawn && spawn.file ? { file: spawn.file, args: typeof spawn.args === 'string' ? spawn.args : [...(spawn.args || [])] } : null;
    this._termFactory = termFactory;
    this._onData = onData;
    this._onExit = onExit;
    this._onResize = onResize;
    this._onNotify = onNotify;
    this._onChange = onChange;
    this._onSnippet = onSnippet;
    this._notifyGraceMs = notifyGraceMs;
    this._notifyAfter = 0; // bells before this time (ms) are shell banners, not requests for attention
    this._now = now;
    this._st = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
    this._ct = clearTimeoutImpl || ((h) => clearTimeout(h));
    this._killTimeoutMs = killTimeoutMs;
    this._answerQueries = answerQueries;
    this._modes = createModeTracker();
    this._resizer = createResizer({
      applyResize: (c, r) => this._ptyResize(c, r),
      delayMs: resizeDelayMs,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    this._lastStamp = 0;
    this._writeSeq = 0;
    this._killPromise = null;
    this._killTimers = [];
    /** Resolves when the session has exited (for any reason). */
    this.exited = new Promise((resolve) => { this._resolveExited = resolve; });
  }

  /** Creates the headless terminal, then spawns the PTY. Resolves once spawned; rejects if spawn fails. */
  async start() {
    if (this.startedAt !== null) throw new Error('session already started');
    this.startedAt = new Date().toISOString();
    try {
      this.term = await (this._termFactory ?? defaultTermFactory)({ cols: this.cols, rows: this.rows });
      if (this.state === 'exited') return; // killed while starting
      const env = buildSpawnEnv(this._env, { sessionId: this.id, hubPort: this._hubPort, strip: this._stripEnv });
      // `spawn` (from launch.js) is what node-pty runs when it differs from the recorded command,
      // e.g. node.exe + an npm shim's script. The record keeps `command` and `args` as requested.
      this.pty = await (this._ptyFactory ?? defaultPtyFactory)(this._spawn?.file ?? this.command, this._spawn?.args ?? this.args, {
        name: 'xterm-256color', cwd: this.cwd, cols: this.cols, rows: this.rows, useConptyDll: true, env,
      });
    } catch (e) {
      // Spawn failure: mark exited without onExit — the caller gets the rejection instead.
      this.state = 'exited';
      this.endedAt = new Date().toISOString();
      this._resolveExited();
      throw e;
    }
    if (this.state === 'exited') { try { this.pty.kill(); } catch { /* gone */ } return; }
    this._notifyAfter = this._now() + this._notifyGraceMs;
    this.term.onNotify?.((n) => this._handleNotify(n));
    this.term.onTitle?.((t) => this._handleTitle(t));
    this.term.onClipboard?.((data) => this._handleClipboard(data));
    this.pty.onData((d) => this._handleData(d));
    this.pty.onExit((e) => this._markExited(e && typeof e.exitCode === 'number' ? e.exitCode : null));
    if (this._answerQueries && typeof this.term.onReply === 'function') {
      this.term.onReply((d) => this._safeWrite(d));
    }
  }

  /**
   * A bell / OSC notification from the program. Ignored right after spawn. Otherwise the owner of
   * the policy (`onNotify`, server.js) decides: returning false means "not wanted" (config
   * notifyBell, a harness with hooks); anything else marks the session as waiting for the user until
   * the next real keystroke (write()).
   */
  _handleNotify(n) {
    if (this.state !== 'running' || this._now() < this._notifyAfter) return;
    let wanted;
    try { wanted = this._onNotify(n, this); } catch { wanted = false; }
    if (wanted === false) return;
    if (!this.needsInput) {
      this.needsInput = true;
      this._onChange();
    }
  }

  /** The terminal title the program set (OSC 0/2), unless it is the shell's own path/exe name. */
  _handleTitle(t) {
    const title = cleanTermTitle(t);
    if (title === this.termTitle) return;
    this.termTitle = title;
    this._onChange();
  }

  /**
   * Adds a snippet (text the user may want to copy; the caller validated it, see snippets.js) and
   * keeps only the newest SNIPPET_KEEP. Announced through onSnippet (server.js broadcasts it).
   * @returns {{id:string, label:string|null, text:string, at:string, source:string}}
   */
  addSnippet({ text, label = null, source = 'api' }) {
    const snippet = { id: crypto.randomBytes(4).toString('hex'), label, text, at: new Date().toISOString(), source };
    this.snippets.push(snippet);
    if (this.snippets.length > SNIPPET_KEEP) this.snippets.splice(0, this.snippets.length - SNIPPET_KEEP);
    try { this._onSnippet(snippet, this); } catch { /* a listener must not break the caller */ }
    return snippet;
  }

  /** An OSC 52 clipboard write from the program: a snippet labelled "clipboard" (queries ignored). */
  _handleClipboard(data) {
    if (this.state !== 'running') return;
    const text = parseOsc52(data);
    if (text !== null) this.addSnippet({ text, label: OSC52_LABEL, source: 'osc52' });
  }

  _handleData(d) {
    this._writeSeq++;
    this._lastActivityMs = Date.now();
    this.term?.write(d);
    this._modes.feed(d);
    this._onData(Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8'));
  }

  // Strictly increasing activity stamps, so two events in the same millisecond still order correctly.
  _stamp() {
    const t = this._now();
    this._lastStamp = t > this._lastStamp ? t : this._lastStamp + 1;
    return this._lastStamp;
  }

  /**
   * Adds (or replaces) a client. A size below MIN_COLS x MIN_ROWS (or missing) is ignored: the client
   * is attached but cannot own the size until it reports a valid one via resizeFrom().
   */
  attach(clientId, { cols, rows, name = null, kind = null } = {}) {
    const ok = validSize(cols, rows);
    this.clients.set(clientId, {
      id: clientId, cols: ok ? cols : null, rows: ok ? rows : null, lastActivity: this._stamp(), name, kind,
    });
    this._recomputeOwner();
    return this.clients.get(clientId);
  }

  /** @returns {boolean} whether the client was attached */
  detach(clientId) {
    const had = this.clients.delete(clientId);
    if (had) this._recomputeOwner();
    return had;
  }

  /**
   * Writes input to the PTY. User input (anything but terminal-generated reports, see
   * isPassiveInput) bumps the client's activity, clears needsInput, and may move size ownership.
   * @returns {boolean} false if the session is not running
   */
  write(bytes, clientId) {
    if (this.state !== 'running' || !this.pty) return false;
    this.pty.write(bytes);
    if (!isPassiveInput(bytes)) {
      this._lastActivityMs = Date.now();
      const c = this.clients.get(clientId);
      if (c) c.lastActivity = this._stamp();
      this.needsInput = false;
      this._recomputeOwner();
    }
    return true;
  }

  /**
   * Records a client's size. Applies it only if that client is (or thereby becomes) the size owner.
   * Invalid/too-small sizes are ignored. Does not count as activity.
   * @returns {boolean} true if this client is the size owner afterwards
   */
  resizeFrom(clientId, cols, rows) {
    const c = this.clients.get(clientId);
    if (!c || !validSize(cols, rows)) return false;
    c.cols = cols;
    c.rows = rows;
    this._recomputeOwner();
    return this.sizeOwner === clientId;
  }

  // Owner = most recently active client among those with a valid size.
  _recomputeOwner() {
    const eligible = [];
    for (const c of this.clients.values()) if (c.cols !== null) eligible.push(c);
    const owner = pickOwner(eligible);
    this.sizeOwner = owner ? owner.id : null;
    if (owner) this._applySize(owner.cols, owner.rows, owner.id);
  }

  _applySize(cols, rows, ownerId) {
    if (this.state !== 'running') return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try { this.term?.resize(cols, rows); } catch { /* headless resize failure is non-fatal */ }
    this._resizer.request(cols, rows);
    this._onResize(cols, rows, ownerId);
  }

  _ptyResize(cols, rows) {
    if (!this.pty || this.state !== 'running') return;
    try { this.pty.resize(cols, rows); } catch { /* pty may be exiting */ }
  }

  /**
   * The bottom `n` rows of the screen as plain text (what the headless terminal has parsed so far);
   * [] when the terminal cannot say. Read-only; used by the Codex Focus view.
   */
  screenLines(n) {
    if (!this.term || typeof this.term.screenLines !== 'function') return [];
    const rows = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_ROWS) : this.rows;
    try { return this.term.screenLines(rows); } catch { return []; }
  }

  /** Screen state for a late-attaching client: serialized screen + tracked DEC private modes. */
  serialize() {
    return (this.term ? this.term.serialize() : '') + this._modes.snapshot();
  }

  /**
   * Resolves once the headless terminal has parsed all PTY output received so far. Call before
   * serialize() when sending init, then serialize and register the client in the same tick.
   */
  async flush() {
    if (!this.term || typeof this.term.flush !== 'function') return;
    for (let i = 0; i < 100; i++) {
      const seq = this._writeSeq;
      await this.term.flush();
      if (seq === this._writeSeq) return;
    }
  }

  _safeWrite(s) {
    if (this.state !== 'running' || !this.pty) return;
    try { this.pty.write(s); } catch { /* ignore */ }
  }

  /**
   * Graceful stop: sends Ctrl+C twice (100 ms apart), waits up to killTimeoutMs (3000) for exit,
   * then pty.kill(). Resolves when the session has exited. `{graceful:false}` kills immediately.
   * @returns {Promise<void>}
   */
  kill({ graceful = true } = {}) {
    if (this.state === 'exited') return Promise.resolve();
    if (this._killPromise) return this._killPromise;
    this._killPromise = this.exited;
    if (!this.pty) {
      this._markExited(null);
      return this._killPromise;
    }
    const hardKill = () => {
      if (this.state === 'exited') return;
      try { this.pty.kill(); } catch { /* already gone */ }
      if (this.state !== 'exited') this._killTimers.push(this._st(() => this._markExited(null), HARD_KILL_GRACE_MS));
    };
    if (graceful) {
      this._safeWrite('\x03');
      this._killTimers.push(this._st(() => this._safeWrite('\x03'), CTRL_C_GAP_MS));
      this._killTimers.push(this._st(hardKill, this._killTimeoutMs));
    } else {
      hardKill();
    }
    return this._killPromise;
  }

  _markExited(code) {
    if (this.state === 'exited') return;
    this.state = 'exited';
    this.exitCode = code;
    this.endedAt = new Date().toISOString();
    this._resizer.cancel();
    for (const t of this._killTimers) this._ct(t);
    this._killTimers = [];
    this._resolveExited();
    this._onExit(code);
  }

  toJSON() {
    const started = this.startedAt ? Date.parse(this.startedAt) : NaN;
    const ended = this.endedAt ? Date.parse(this.endedAt) : Date.now();
    return {
      id: this.id,
      index: this.index,
      cwd: this.cwd,
      command: this.command,
      args: this.args,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      state: this.state,
      exitCode: this.exitCode,
      cols: this.cols,
      rows: this.rows,
      clients: this.clients.size,
      needsInput: this.needsInput,
      claudeSessionId: this.claudeSessionId,
      harness: this.harness,
      model: this.model,
      harnessSessionId: this.harnessSessionId,
      termTitle: this.termTitle,
      title: this.title,
      firstPrompt: this.firstPrompt,
      hasTranscript: this.hasTranscript,
      userTitle: this.userTitle,
      lastActivity: this._lastActivityMs === null ? null : new Date(this._lastActivityMs).toISOString(),
      durationMs: Number.isNaN(started) ? null : Math.max(0, ended - started),
    };
  }
}
