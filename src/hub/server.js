// HTTP (static + REST) and WebSocket server for the hub. No process lifecycle here: hub.js owns
// listening, pid files and exiting (via the onStop callback).
//
// Auth: every route and every WS upgrade except GET /api/health requires a valid token
// (cookie `cw_token`, or `?t=`). A valid `?t=` on a GET page request is swapped for a cookie via
// a 302 to the same URL without `t`. /api/* and WS accept `?t=` directly (no redirect).
// With config.tailscaleAuth enabled, a request from loopback (tailscale serve) whose
// `Tailscale-User-Login` is in the allow list is signed in as `ts:<login>` instead (auth.js
// tailscaleIdentity); no cookie is set, the header is checked on every request and upgrade.
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, cookieHeader, isSecure, isLoopbackAddress, tailscaleIdentity, TS_LOGIN_HEADER, TS_NAME_PREFIX } from './auth.js';
import { decodeMessage, encodeControl, INIT, RESIZE, EXIT, PING, PONG, SESSIONS, SNIPPET, SNIPPETS } from './protocol.js';
import { validateSnippet, SNIPPET_MAX_BYTES } from './snippets.js';
import { isPassiveInput, MIN_COLS, MIN_ROWS, MAX_COLS, MAX_ROWS } from './session.js';
import { mapHookEvent, formatNotification, inferHookHarness } from './hooks.js';
import { recentProjects, rootDirs } from './projects.js';
import { claudeHome as defaultClaudeHome, codexHome as defaultCodexHome, normalizeTailscaleAuth } from './config.js';
import { sessionTitle as defaultSessionTitle } from './transcripts.js';
import { createCodexFocus, isCodexSession } from './codex-focus.js';
import { readFinalAssistantText } from './claude-turn.js';
import { SpeechError } from './speech.js';
import '../shared/recent-filter.js';
import '../shared/harnesses.js';
import { resolveLaunch } from './launch.js';
import { saveUpload, UploadError, UPLOAD_MAX_BYTES, defaultUploadDir } from './uploads.js';

const { isHidden, normalizeTitle, displayTitle } = globalThis.cwRecentFilter;

const noopLog = { info() {}, warn() {}, error() {} };
const noopAudit = { record() {} };

export const BODY_LIMIT = 64 * 1024;
// POST /api/sessions/<id>/snippets carries up to SNIPPET_MAX_BYTES of text, which JSON escaping
// (\n, \", \uXXXX) can grow; the text itself is checked against SNIPPET_MAX_BYTES after parsing.
export const SNIPPET_BODY_LIMIT = SNIPPET_MAX_BYTES * 4 + 1024;
export const DEFAULT_SESSION_COLS = 120;
export const DEFAULT_SESSION_ROWS = 35;
const WS_MAX_PAYLOAD = 4 * 1024 * 1024;
const WS_MAX_BUFFERED = 16 * 1024 * 1024; // a client this far behind is dropped
const SESSION_ID_RE = /^[0-9a-f]{8}$/;
const APP_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const RESUME_RE = /^[A-Za-z0-9._-]{1,128}$/;

// The microphone permission is for voice dictation (web/voice.js). getUserMedia and the audio
// WebSocket are not governed by media-src, and the AudioWorklet module is a same-origin /app/
// script covered by default-src 'self', so the CSP needs no media-src.
// frame-ancestors 'self': the split view (/split) frames session pages from the same origin; no
// other site may frame the hub (clickjacking).
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

// /ws/voice: PCM16 LE mono 16 kHz = 32 000 bytes per second.
const VOICE_BYTES_PER_SECOND = 32000;
export const VOICE_MAX_SECONDS = 120; // one utterance; longer ones are dropped with an error
const VOICE_MIN_BYTES = VOICE_BYTES_PER_SECOND * 0.3; // shorter than this: empty text, no transcriber call

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Default /vendor/<key> map onto the installed @xterm packages. */
export function defaultVendorMap() {
  const require = createRequire(import.meta.url);
  const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
  const xterm = pkgDir('@xterm/xterm');
  return {
    'xterm.js': path.join(xterm, 'lib', 'xterm.js'),
    'xterm.css': path.join(xterm, 'css', 'xterm.css'),
    'addon-fit.js': path.join(pkgDir('@xterm/addon-fit'), 'lib', 'addon-fit.js'),
    'addon-web-links.js': path.join(pkgDir('@xterm/addon-web-links'), 'lib', 'addon-web-links.js'),
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cwdKey = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} o
 * @param {object} o.config hub config ({port, projectRoots, notifyIdle, notifyPreview, publicBase?}); config.port
 *   must be the actual listening port by the time requests arrive (hub.js updates it after listen).
 * @param {Array|Function} o.tokens token array from loadTokens(), or a function returning it
 * @param {object} o.registry from createRegistry()
 * @param {object} [o.audit] from createAudit()
 * @param {object} [o.notifier] from createNotifier()
 * @param {object} [o.log]
 * @param {string} o.webDir directory holding index.html, session.html and /app files
 * @param {object} [o.vendorMap] key -> absolute file (default defaultVendorMap())
 * @param {string} o.version
 * @param {Function} [o.onStop] called after a 202 reply to POST /api/hub/stop
 * @param {string} [o.claudeHome] default: config.claudeHome()
 * @param {string} [o.defaultCommand] command for POST /api/sessions without `command`
 * @param {object|Function} [o.harnesses] validated config.harnesses (config.js normalizeHarnesses), or a function returning it
 * @param {string} [o.defaultHarness] preset used by POST /api/sessions without harness or command (default 'claude')
 * @param {Function} [o.resolveCommand] the hub's resolveCommand, for GET /api/harnesses availability
 * @param {object} [o.models] from models.js createModels(); without it model lists are empty
 * @param {number} [o.heartbeatMs] WS ping interval (default 30 s)
 * @param {number} [o.projectsCacheMs] /api/projects cache (default 10 s)
 * @param {number} [o.notifyDebounceMs] identical hook notifications within this window are dropped (10 s)
 * @param {Function} [o.sessionTitle] transcript reader (default transcripts.js sessionTitle)
 * @param {number} [o.titleRefreshMs] running sessions' titles are refreshed this often (default 30 s)
 * @param {string} [o.sharedDir] second lookup dir for /app/<file> (default <webDir>/../src/shared)
 *   config.allowedHosts (optional array) adds Host names to the allowlist (hub.js: the tailnet name).
 * @param {object} [o.stt] from stt.js createStt(); without it (or with config.voice.enabled false,
 *   or engine 'browser') /ws/voice closes with 4503 and /api/voice reports the state.
 *   config.voice is the validated voice config (config.js normalizeVoice).
 * @param {object|Function} [o.tailscaleAuth] validated {enabled, allow} (config.js
 *   normalizeTailscaleAuth), or a function `(force) => config` that re-reads it (hub.js); default:
 *   config.tailscaleAuth normalized once, without logging.
 * @param {string} [o.uploadDir] where POST /api/sessions/<id>/upload saves files (default os.tmpdir()/cw-uploads)
 * @param {number} [o.uploadMaxBytes] upload cap (default UPLOAD_MAX_BYTES, 25 MB; the page checks the same constant)
 * @param {string} [o.codexHome] Codex's home for the Focus view's rollout files (default config.codexHome(), CW_CODEX_HOME)
 * @param {object} [o.codexFocus] from codex-focus.js createCodexFocus() (default: one over codexHome)
 * @param {object} [o.speech] from speech.js createSpeech() (Talk mode); without it (or with
 *   config.voice.talk false) the speech routes answer 404 and /api/voice reports talk.enabled false.
 */
export function createServer({
  config, tokens, registry, audit, notifier, log, webDir, vendorMap, version, onStop,
  claudeHome, defaultCommand = 'claude.exe', heartbeatMs = 30000, projectsCacheMs = 10000,
  startedAt = Date.now(), notifyDebounceMs = 10000,
  sessionTitle = defaultSessionTitle, titleRefreshMs = 30000, sharedDir, stt = null, tailscaleAuth,
  harnesses = null, sessionColors = null, defaultHarness = 'claude', resolveCommand = null, models = null,
  uploadDir = defaultUploadDir(), uploadMaxBytes = UPLOAD_MAX_BYTES, codexHome, codexFocus, speech = null,
} = {}) {
  if (!config) throw new TypeError('config is required');
  if (!registry) throw new TypeError('registry is required');
  if (!webDir) throw new TypeError('webDir is required');
  const lg = log || noopLog;
  const au = audit || noopAudit;
  const vendor = vendorMap || defaultVendorMap();
  const getTokens = typeof tokens === 'function' ? tokens : () => tokens;
  const staticTsAuth = typeof tailscaleAuth === 'function' ? null : normalizeTailscaleAuth(tailscaleAuth ?? config.tailscaleAuth);
  const getTsAuth = typeof tailscaleAuth === 'function' ? tailscaleAuth : () => staticTsAuth;
  const home = claudeHome || defaultClaudeHome();
  const focus = codexFocus || createCodexFocus({ codexHome: codexHome || defaultCodexHome() });
  const shared = sharedDir || path.resolve(webDir, '..', 'src', 'shared');

  /** sessionId -> Map<clientId, ws> */
  const sessionClients = new Map();
  const listClients = new Set();
  const missedPongs = new WeakMap();
  const socketToken = new WeakMap(); // ws -> name of the token it authenticated with
  const projectsCache = new Map(); // 'all'|'default' -> {at, value}
  const recentNotifications = new Map(); // click+title+message -> sent at (hook debounce)
  const bellSent = new Map(); // session id -> when its last bell/OSC push went out
  let listScheduled = false;
  let closed = false;

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      lg.error(`request ${req.method} ${safePath(req)} failed: ${e?.stack || e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  httpServer.on('upgrade', (req, socket, head) => {
    try { handleUpgrade(req, socket, head); } catch (e) {
      lg.error(`upgrade ${safePath(req)} failed: ${e?.stack || e}`);
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) || 0;
      if (missed >= 2) { ws.terminate(); continue; }
      missedPongs.set(ws, missed + 1);
      try { ws.ping(); } catch { /* closing */ }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  // Running sessions' titles (and last activity) every titleRefreshMs.
  const lastSeenActivity = new Map(); // id -> lastActivity at the previous tick
  const titleTimer = setInterval(() => {
    refreshRunningTitles().catch((e) => lg.warn(`title refresh failed: ${e?.message || e}`));
  }, titleRefreshMs);
  titleTimer.unref?.();

  // ---------- helpers ----------

  function safePath(req) {
    try { return new URL(req.url, 'http://127.0.0.1').pathname; } catch { return '?'; }
  }

  function who(req, auth) {
    return { name: auth?.name, tsUser: req.headers['tailscale-user-login'] || null };
  }

  // Never logs the query string (it may hold a token). With Tailscale auth enabled, or an identity
  // header present, says why the identity was not accepted.
  function logAuthFailure(req, kind) {
    const parts = [`auth failed: ${kind} ${req.method} ${safePath(req)}`];
    if (req.headers['x-forwarded-for']) parts.push(`x-forwarded-for=${req.headers['x-forwarded-for']}`);
    const login = req.headers[TS_LOGIN_HEADER];
    if (login) parts.push(`${TS_LOGIN_HEADER}=${String(login).replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}`);
    const ts = getTsAuth();
    if (login || ts?.enabled) parts.push(`tailscale-auth=${tailscaleIdentity(req, ts).reason}`);
    lg.warn(parts.join(' '));
  }

  function setCommon(res, { noStore = true } = {}) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('Cache-Control', noStore ? 'no-store' : 'no-cache');
  }

  function sendJson(res, status, obj) {
    setCommon(res);
    if (obj === undefined) { res.writeHead(status); res.end(); return; }
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function sendText(res, status, text) {
    setCommon(res);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  async function sendFile(req, res, file) {
    const ext = path.extname(file).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) return sendText(res, 404, 'not found');
    let data;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return sendText(res, 404, 'not found');
      data = await fsp.readFile(file);
    } catch {
      return sendText(res, 404, 'not found');
    }
    setCommon(res, { noStore: ext === '.html' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /** Reads a JSON object body (64 KB max unless `limit` says otherwise). Empty body -> {}. */
  function readJsonBody(req, limit = BODY_LIMIT) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) tooLarge = true;
        else chunks.push(c);
      });
      req.on('error', reject);
      req.on('end', () => {
        if (tooLarge) return reject(new HttpError(413, 'body too large'));
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') return resolve({});
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (!ct.startsWith('application/json')) return reject(new HttpError(400, 'content-type must be application/json'));
        let obj;
        try { obj = JSON.parse(text); } catch { return reject(new HttpError(400, 'malformed JSON')); }
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return reject(new HttpError(400, 'body must be a JSON object'));
        resolve(obj);
      });
    });
  }

  function listSnapshot() {
    return {
      running: registry.running().map((s) => s.toJSON()),
      recent: registry.recent(),
    };
  }

  // ---------- titles (transcripts.js) ----------

  /** Transcript fields for a session or recent entry; never rejects. */
  async function transcriptFields(x) {
    const keep = { title: x.title ?? null, firstPrompt: x.firstPrompt ?? null, hasTranscript: false };
    if (!x.claudeSessionId) return keep;
    let t;
    try { t = await sessionTitle({ claudeHome: home, cwd: x.cwd, claudeSessionId: x.claudeSessionId }); } catch { t = null; }
    if (!t || !t.exists) return keep;
    return { title: t.title ?? keep.title, firstPrompt: t.firstPrompt ?? keep.firstPrompt, hasTranscript: true };
  }

  /** Updates a live Session's title fields. @returns {Promise<boolean>} whether anything changed */
  async function refreshSessionTitle(s) {
    const f = await transcriptFields(s);
    let changed = false;
    for (const [k, v] of Object.entries(f)) if (s[k] !== v) { s[k] = v; changed = true; }
    return changed;
  }

  /** Refreshes recent entries (all, or the given ids); persists once. @returns {Promise<boolean>} */
  async function refreshRecentTitles(ids) {
    let changed = false;
    for (const r of registry.recent()) {
      if (ids && !ids.includes(r.id)) continue;
      const f = await transcriptFields(r);
      if (registry.updateRecent?.(r.id, f, { save: false })) changed = true;
    }
    if (changed) registry.save?.();
    return changed;
  }

  async function refreshRunningTitles() {
    let titles = false;
    let activity = false;
    const live = registry.running();
    for (const s of live) {
      if (await refreshSessionTitle(s)) titles = true;
      const a = s.toJSON().lastActivity;
      if (lastSeenActivity.get(s.id) !== a) { lastSeenActivity.set(s.id, a); activity = true; }
    }
    for (const id of [...lastSeenActivity.keys()]) if (!live.some((s) => s.id === id)) lastSeenActivity.delete(id);
    if (titles) registry.save?.(); // the running snapshot carries the title
    if (titles || activity) broadcastList();
  }

  /** Pushes {t:'sessions'} to every /ws/list client (coalesced per tick). */
  function broadcastList() {
    if (listScheduled || closed) return;
    listScheduled = true;
    setImmediate(() => {
      listScheduled = false;
      if (listClients.size === 0) return;
      const msg = encodeControl({ t: SESSIONS, ...listSnapshot() });
      for (const ws of listClients) sendTo(ws, msg);
    });
  }

  function publicBase() {
    const b = config.publicBase || `http://127.0.0.1:${config.port}`;
    return String(b).replace(/\/+$/, '');
  }

  // ---------- Host / Origin checks ----------
  // Host allowlist (DNS rebinding): 127.0.0.1:<port>, localhost:<port>, and config.publicBase's
  // host. Origin check (cross-site / cross-port requests; SameSite cookies do not isolate ports):
  // when an Origin header is present its host must equal the Host header or publicBase's host.
  // Requests without Origin (CLI, curl, hooks) pass the Origin check.

  const normHost = (h) => String(h || '').trim().toLowerCase().replace(/:(80|443)$/, '');

  function publicBaseHost() {
    if (!config.publicBase) return null;
    try { return normHost(new URL(config.publicBase).host); } catch { return null; }
  }

  /**
   * Extra public host names (hub.js adds `<tailnet name>:<port>`; the port-less name only when the
   * hub is on 443). Each is also accepted as an Origin host, so it must never name another origin.
   */
  const extraHosts = () => (Array.isArray(config.allowedHosts) ? config.allowedHosts : []).map(normHost).filter(Boolean);

  /** @returns {null|{status:number, text:string}} null if the request may proceed */
  function checkHostOrigin(req, { checkOrigin }) {
    const host = normHost(req.headers.host);
    const pbHost = publicBaseHost();
    const extra = extraHosts();
    const allowed = [`127.0.0.1:${config.port}`, `localhost:${config.port}`].map(normHost);
    if (pbHost) allowed.push(pbHost);
    allowed.push(...extra);
    if (!host || !allowed.includes(host)) return { status: 421, text: 'Misdirected Request' };
    if (!checkOrigin) return null;
    const origin = req.headers.origin;
    if (origin === undefined) return null;
    let originHost = null;
    try { originHost = normHost(new URL(origin).host); } catch { originHost = null; }
    if (originHost && (originHost === host || originHost === pbHost || extra.includes(originHost))) return null;
    return { status: 403, text: 'Forbidden' };
  }

  function logRejected(req, kind, status, why) {
    const parts = [`rejected (${status}): ${kind} ${req.method} ${safePath(req)} host=${req.headers.host ?? '-'}`];
    if (req.headers.origin !== undefined) parts.push(`origin=${req.headers.origin}`);
    if (req.headers['x-forwarded-for']) parts.push(`x-forwarded-for=${req.headers['x-forwarded-for']}`);
    if (why) parts.push(`(${why})`);
    lg.warn(parts.join(' '));
  }

  /**
   * Review F2: an identity login (no cookie, no token) must come from a browser page, which always
   * sends Origin on non-GET API calls and WebSocket upgrades. Without it the request is refused
   * (403) even though the Origin check above passes requests that carry no Origin at all.
   */
  const originRequired = (req, auth) => auth.via === 'tailscale' && req.headers.origin === undefined;

  function clientsOf(id) {
    let m = sessionClients.get(id);
    if (!m) { m = new Map(); sessionClients.set(id, m); }
    return m;
  }

  function sendTo(ws, data, opts) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > WS_MAX_BUFFERED) {
      lg.warn('dropping a websocket client that fell too far behind');
      ws.terminate();
      return;
    }
    ws.send(data, opts);
  }

  // ---------- HTTP ----------

  async function handleHttp(req, res) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendText(res, 400, 'bad request'); }
    const p = url.pathname;
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    const bad = checkHostOrigin(req, { checkOrigin: p.startsWith('/api/') && !isGet });
    if (bad) {
      logRejected(req, 'http', bad.status);
      return sendText(res, bad.status, bad.text.toLowerCase());
    }
    // No `//` or `\` in the raw or parsed path (`//x` parses as a host, `\` becomes `/`, `/.//x`
    // normalises to `//x`): keeps every path, and so every redirect, same-origin.
    const rawPath = String(req.url).split('?')[0];
    if (p.includes('//') || /\/\/|\\/.test(rawPath)) return sendText(res, 404, 'not found');

    if (p === '/api/health' && isGet) {
      return sendJson(res, 200, {
        ok: true, app: 'cw', version, sessions: registry.running().length,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      });
    }

    const tokenList = getTokens() || [];
    const auth = authenticate(req, tokenList, { tailscaleAuth: getTsAuth() });
    if (!auth) {
      logAuthFailure(req, 'http');
      return sendText(res, 401, 'unauthorized');
    }
    if (p.startsWith('/api/') && !isGet && originRequired(req, auth)) {
      logRejected(req, 'http', 403, 'tailscale login without Origin');
      return sendText(res, 403, 'forbidden');
    }

    // Page requests carrying ?t=: set the cookie (if that token is valid) and strip t from the URL.
    if (isGet && !p.startsWith('/api/') && url.searchParams.has('t')) {
      const viaQuery = authenticate({ headers: {}, url: req.url }, tokenList);
      if (viaQuery) res.setHeader('Set-Cookie', cookieHeader(url.searchParams.get('t'), { secure: isSecure(req) }));
      url.searchParams.delete('t');
      const qs = url.searchParams.toString();
      setCommon(res);
      // Always a single leading slash: never a protocol-relative `//host` redirect.
      res.writeHead(302, { Location: `/${p.replace(/^[/\\]+/, '')}${qs ? `?${qs}` : ''}` });
      res.end();
      return;
    }

    if (p.startsWith('/api/')) return handleApi(req, res, url, auth);
    if (!isGet) return sendText(res, 404, 'not found');
    return handleStatic(req, res, p);
  }

  async function handleStatic(req, res, p) {
    if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(webDir, 'index.html'));
    // Split view (web/split.js): the session ids are in the query, ?s=<id>,<id>.
    if (p === '/split') return sendFile(req, res, path.join(webDir, 'split.html'));
    let m = /^\/s\/([^/]+)$/.exec(p);
    if (m) {
      if (!SESSION_ID_RE.test(m[1])) return sendText(res, 404, 'not found');
      return sendFile(req, res, path.join(webDir, 'session.html'));
    }
    m = /^\/app\/([^/]+)$/.exec(p);
    if (m) {
      const name = m[1];
      if (!APP_FILE_RE.test(name) || name.includes('..')) return sendText(res, 404, 'not found');
      // web/ first, then src/shared/ (plain scripts shared with the CLI, e.g. recent-filter.js).
      let file = path.join(webDir, name);
      try { await fsp.access(file); } catch { file = path.join(shared, name); }
      return sendFile(req, res, file);
    }
    m = /^\/vendor\/([^/]+)$/.exec(p);
    if (m && Object.hasOwn(vendor, m[1])) return sendFile(req, res, vendor[m[1]]);
    return sendText(res, 404, 'not found');
  }

  async function handleApi(req, res, url, auth) {
    const p = url.pathname;
    const m = req.method;
    try {
      if (p === '/api/sessions' && m === 'GET') {
        if (await refreshRecentTitles()) broadcastList();
        return sendJson(res, 200, listSnapshot());
      }
      // Who this request is signed in as (the list page shows "signed in as <login>" for Tailscale).
      if (p === '/api/me' && m === 'GET') return sendJson(res, 200, { name: auth.name, via: auth.via, ...(auth.login ? { login: auth.login } : {}) });
      if (p === '/api/recent' && m === 'DELETE') return await clearRecent(req, res, auth, url);
      const rdel = /^\/api\/recent\/([^/]+)$/.exec(p);
      if (rdel && m === 'DELETE') return await deleteRecent(req, res, auth, rdel[1]);
      if (p === '/api/sessions' && m === 'POST') return await createSession(req, res, auth);
      const snip = /^\/api\/sessions\/([^/]+)\/snippets$/.exec(p);
      if (snip && m === 'POST') return await postSnippet(req, res, auth, snip[1]);
      const up = /^\/api\/sessions\/([^/]+)\/upload$/.exec(p);
      if (up && m === 'POST') return await postUpload(req, res, auth, up[1], url);
      const fo = /^\/api\/sessions\/([^/]+)\/focus$/.exec(p);
      if (fo && m === 'GET') return await focusFeed(res, fo[1], url);
      const sp = /^\/api\/sessions\/([^/]+)\/speech$/.exec(p);
      if (sp && m === 'GET') return await speechPoll(res, sp[1], url);
      const spa = /^\/api\/sessions\/([^/]+)\/speech\/(\d{1,16})\/(\d{1,3})\.wav$/.exec(p);
      if (spa && m === 'GET') return await speechAudio(req, res, auth, spa[1], Number(spa[2]), Number(spa[3]));
      const del = /^\/api\/sessions\/([^/]+)$/.exec(p);
      if (del && m === 'DELETE') return await killSession(req, res, auth, del[1]);
      if (del && m === 'PATCH') return await renameSession(req, res, auth, del[1]);
      if (p === '/api/harnesses' && m === 'GET') return sendJson(res, 200, harnessList());
      const hm = /^\/api\/harnesses\/([^/]+)\/models$/.exec(p);
      if (hm && m === 'GET') {
        let hid;
        try { hid = decodeURIComponent(hm[1]); } catch { return sendJson(res, 404, { error: 'unknown harness' }); }
        // refresh=1 is honoured for requests without Origin (CLI) or with an accepted same-origin one.
        const refresh = url.searchParams.get('refresh') === '1' && checkHostOrigin(req, { checkOrigin: true }) === null;
        return await harnessModels(res, hid, refresh);
      }
      if (p === '/api/projects' && m === 'GET') return sendJson(res, 200, await projects(url.searchParams.get('all') === '1'));
      if (p === '/api/session-colors' && m === 'GET') return sendJson(res, 200, { colors: (typeof sessionColors === 'function' ? sessionColors() : sessionColors) || {}, terminalTint: config.terminalTint !== false });
      if (p === '/api/voice' && m === 'GET') return sendJson(res, 200, voiceInfo());
      if (p === '/api/hook' && m === 'POST') return await hook(req, res, auth);
      if (p === '/api/hub/stop' && m === 'POST') return await hubStop(req, res, auth);
      if (p === '/api/notify/test' && m === 'POST') return await notifyTest(req, res, auth);
      if (p === '/api/tokens/reload' && m === 'POST') return await tokensReload(req, res, auth);
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      throw e;
    }
  }

  /** config.harnesses (validated by hub.js), read per call so tests and reloads see changes. */
  function harnessConfig() {
    return (typeof harnesses === 'function' ? harnesses() : harnesses) || {};
  }

  /** GET /api/harnesses: the presets the picker offers, with whether each can be started here. */
  function harnessList() {
    const cfg = harnessConfig();
    const list = [];
    for (const h of globalThis.cwHarnesses.HARNESSES) {
      if (cfg[h.id]?.hidden === true) continue;
      const cmd = h.id === 'claude' ? (cfg.claude?.path || defaultCommand) : (cfg[h.id]?.path || h.command);
      let found = null;
      if (resolveCommand) {
        try { found = resolveLaunch(cmd, [], { env: process.env, resolve: resolveCommand }).command; } catch { found = null; }
      }
      // A preset that needs an environment variable (NVIDIA_API_KEY) is unavailable without it; only the name is reported.
      const missingEnv = h.requiresEnv && !String(process.env[h.requiresEnv] || '').trim() ? h.requiresEnv : null;
      list.push({
        id: h.id, label: h.label, command: h.command, args: cfg[h.id]?.args ?? h.args,
        available: !!found && !missingEnv, path: found,
        ...(missingEnv ? { unavailableReason: `${missingEnv} is not set in the hub environment` } : {}),
        hasModels: !!h.models || !!cfg[h.id]?.models, modelRequired: !!h.modelRequired,
        canContinue: !!h.continueArgs, canResumeById: !!h.resumeArgs, hooks: h.hooks,
      });
    }
    return { default: defaultHarness, harnesses: list };
  }

  async function harnessModels(res, id, refresh) {
    const h = globalThis.cwHarnesses.getHarness(id);
    if (!h || harnessConfig()[id]?.hidden === true) throw new HttpError(404, 'unknown harness');
    if (!models) return sendJson(res, 200, { id, models: [], source: null, fetchedAt: new Date().toISOString(), error: 'model lists are not available' });
    return sendJson(res, 200, await models.list(id, { refresh }));
  }

  async function createSession(req, res, auth) {
    const body = await readJsonBody(req);
    const { cwd, command, args, cols, rows, resume, harness: harnessId, model } = body;
    const cont = body.continue;
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new HttpError(400, 'cwd is required');
    let st = null;
    try { st = await fsp.stat(cwd); } catch { /* handled below */ }
    if (!st || !st.isDirectory()) throw new HttpError(400, 'cwd is not an existing directory');
    if (command !== undefined && command !== null && (typeof command !== 'string' || command.trim() === '')) {
      throw new HttpError(400, 'command must be a non-empty string');
    }
    if (args !== undefined && args !== null && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) {
      throw new HttpError(400, 'args must be an array of strings');
    }
    for (const [k, v] of [['cols', cols], ['rows', rows]]) {
      if (v !== undefined && v !== null && !Number.isInteger(v)) throw new HttpError(400, `${k} must be an integer`);
    }
    if (resume !== undefined && resume !== null && (typeof resume !== 'string' || !RESUME_RE.test(resume))) {
      throw new HttpError(400, 'resume must be a session id');
    }
    // ---- harness: which preset starts (src/shared/harnesses.js); none given = the old Claude behaviour
    const H = globalThis.cwHarnesses;
    const hcfg = harnessConfig();
    if (harnessId !== undefined && harnessId !== null
      && (typeof harnessId !== 'string' || !H.getHarness(harnessId) || hcfg[harnessId]?.hidden === true)) {
      throw new HttpError(400, 'unknown harness');
    }
    if (model !== undefined && model !== null && !H.validModel(model)) throw new HttpError(400, 'model is not valid');
    const needEnv = harnessId ? H.getHarness(harnessId)?.requiresEnv : null;
    if (needEnv && !String(process.env[needEnv] || '').trim()) throw new HttpError(400, `${needEnv} is not set in the hub environment`);
    if (cont !== undefined && cont !== null && typeof cont !== 'boolean') throw new HttpError(400, 'continue must be true or false');
    const harness = harnessId ? H.getHarness(harnessId)
      : command ? H.inferHarness(command)
        : resume ? H.getHarness('claude')
          : H.getHarness(defaultHarness);
    // Preset arguments belong to a preset that was asked for (or defaulted to); a bare custom
    // command keeps exactly the arguments it was given.
    const usePreset = !!harnessId || !command;
    // `resume` without `harness` is the old API; a custom command without `harness` is legacy too.
    let builtArgs;
    try {
      const argHarness = (!harnessId && resume) ? H.getHarness('claude') : harness;
      builtArgs = H.buildSessionArgs({
        harnessId, command, harness, resume, model, continue: cont === true, args: args || [],
        presetArgs: usePreset && argHarness ? (hcfg[argHarness.id]?.args ?? argHarness.args) : [],
      });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const presetCommand = !harness ? defaultCommand
      : harness.id === 'claude' ? (hcfg.claude?.path || defaultCommand)
        : (hcfg[harness.id]?.path || harness.command);
    const opts = {
      cwd,
      command: command || presetCommand,
      args: builtArgs,
      harness: harness ? harness.id : null,
      model: model ?? null,
      cols: clampInt(Number.isInteger(cols) ? cols : DEFAULT_SESSION_COLS, MIN_COLS, MAX_COLS),
      rows: clampInt(Number.isInteger(rows) ? rows : DEFAULT_SESSION_ROWS, MIN_ROWS, MAX_ROWS),
    };
    if (resume || cont === true) {
      // The user's own name follows the conversation: the newest recent entry with that session id,
      // or, for "continue latest", the newest recent entry of the same harness in the same folder.
      const same = (r) => (resume
        ? r.claudeSessionId === resume || r.harnessSessionId === resume
        : r.harness === opts.harness && r.cwd === cwd);
      const src = registry.recent().find(same);
      if (src?.userTitle) opts.userTitle = src.userTitle;
    }
    let session;
    try {
      session = await registry.create(opts);
    } catch (e) {
      lg.warn(`session create failed (${opts.command}): ${e?.message || e}`);
      if (e?.code === 'ENOENT') throw new HttpError(400, e.message);
      throw new HttpError(500, `could not start session: ${e?.message || e}`);
    }
    lg.info(`session ${session.id} #${session.index} started: ${opts.command} (${opts.args.length} args)${opts.harness ? ` harness ${opts.harness}` : ''}${cont === true ? ' continue' : ''}`);
    au.record({ ...who(req, auth), action: resume ? 'resume' : 'create', sessionId: session.id, cwd });
    broadcastList();
    return sendJson(res, 201, { id: session.id, index: session.index });
  }

  async function killSession(req, res, auth, key) {
    // Accepts an id, or a numeric index of the current hub life.
    const session = SESSION_ID_RE.test(key) || /^\d+$/.test(key) ? registry.get(key) : null;
    if (!session) throw new HttpError(404, 'unknown session');
    au.record({ ...who(req, auth), action: 'kill', sessionId: session.id, cwd: session.cwd });
    await registry.kill(session.id);
    lg.info(`session ${session.id} killed`);
    broadcastList();
    return sendJson(res, 204);
  }

  /**
   * PATCH /api/sessions/:key {title: string|null}: sets (or, when blank/null, clears) the user's
   * own title. `key` is an id or an index; an index resolves live sessions only (a running one wins
   * over recent entries of earlier hub lives). A running session is renamed in place; an exited one
   * (retained, or recent by id) through its recent entry.
   */
  async function renameSession(req, res, auth, key) {
    const body = await readJsonBody(req);
    if (!Object.hasOwn(body, 'title') || (body.title !== null && typeof body.title !== 'string')) {
      throw new HttpError(400, 'title must be a string or null');
    }
    const userTitle = normalizeTitle(body.title) || null;
    const isId = SESSION_ID_RE.test(key);
    const live = isId || /^\d+$/.test(key) ? registry.get(key) : null;
    let target;
    if (live && live.state === 'running') {
      live.userTitle = userTitle;
      registry.save?.();
      target = live;
    } else {
      // An exited session still within retention (by id or index), else a recent entry by id.
      const id = live ? live.id : isId ? key : null;
      const r = id ? registry.findRecent(id) : null;
      if (!r || r.id !== id) throw new HttpError(404, 'unknown session');
      registry.updateRecent(r.id, { userTitle });
      if (live) live.userTitle = userTitle; // the retained Session object never keeps a stale name
      target = { ...r, userTitle };
    }
    au.record({ ...who(req, auth), action: 'rename', sessionId: target.id, cwd: target.cwd });
    lg.info(`session ${target.id} ${userTitle ? 'renamed' : 'name cleared'}`);
    broadcastList();
    return sendJson(res, 200, { id: target.id, index: target.index, userTitle, title: displayTitle(target) });
  }

  /**
   * POST /api/sessions/:key/snippets {text, label?} (`cw copy`): adds a snippet to a running
   * session (id, or index of this hub life). The text is kept exactly; it is never logged. The
   * session's onSnippet broadcasts it to the attached clients (sessionEvents.snippet). 201
   * {id, sessionId, index, label, at, bytes}; 400 bad body, 404 no such running session, 413 too large.
   */
  async function postSnippet(req, res, auth, key) {
    const body = await readJsonBody(req, SNIPPET_BODY_LIMIT);
    const session = SESSION_ID_RE.test(key) || /^\d+$/.test(key) ? registry.get(key) : null;
    if (!session || session.state !== 'running' || typeof session.addSnippet !== 'function') {
      throw new HttpError(404, 'no running session');
    }
    let v;
    try { v = validateSnippet(body); } catch (e) { throw new HttpError(e.status || 400, e.message); }
    const s = session.addSnippet({ ...v, source: 'api' });
    const bytes = Buffer.byteLength(s.text, 'utf8');
    au.record({ ...who(req, auth), action: 'snippet', sessionId: session.id, cwd: session.cwd });
    lg.info(`snippet ${s.id} added to session ${session.id} (${bytes} bytes)`);
    return sendJson(res, 201, { id: s.id, sessionId: session.id, index: session.index, label: s.label, at: s.at, bytes });
  }

  /**
   * POST /api/sessions/:key/upload?name=<file name> (web/drop.js: a file dropped or an image pasted
   * onto the session page). The raw body is streamed to <uploadDir>/<session id>/<unique>-<name>
   * (uploads.js; the name is sanitized there). 201 {path, name, bytes, sessionId}; 400 empty body,
   * 404 no such running session, 413 over UPLOAD_MAX_BYTES (answered with Connection: close). The
   * file name is never logged.
   */
  async function postUpload(req, res, auth, key, url) {
    const session = SESSION_ID_RE.test(key) || /^\d+$/.test(key) ? registry.get(key) : null;
    if (!session || session.state !== 'running') {
      req.resume();
      throw new HttpError(404, 'no running session');
    }
    let saved;
    try {
      saved = await saveUpload(req, { dir: uploadDir, sessionId: session.id, name: url.searchParams.get('name'), maxBytes: uploadMaxBytes });
    } catch (e) {
      if (!(e instanceof UploadError)) throw e;
      if (e.status === 413) res.setHeader('Connection', 'close');
      throw new HttpError(e.status, e.message);
    }
    au.record({ ...who(req, auth), action: 'upload', sessionId: session.id, cwd: session.cwd });
    lg.info(`upload saved for session ${session.id} (${saved.bytes} bytes)`);
    return sendJson(res, 201, { path: saved.path, name: saved.name, bytes: saved.bytes, sessionId: session.id });
  }

  /**
   * GET /api/sessions/:key/focus?since=<seq>&thread=<id> (web/focus.js): the Codex conversation of
   * a session (running, or exited and still retained) from its rollout file, as compact events after
   * `since`, plus whether Codex waits for the user (codex-focus.js). 404 unknown session, 400 not a
   * Codex session. Read-only: polled by the page, so it is neither logged nor audited.
   */
  async function focusFeed(res, key, url) {
    const session = SESSION_ID_RE.test(key) || /^\d+$/.test(key) ? registry.get(key) : null;
    if (!session) throw new HttpError(404, 'unknown session');
    if (!isCodexSession(session)) throw new HttpError(400, 'the focus view is for Codex sessions');
    const s = url.searchParams.get('since');
    const t = url.searchParams.get('thread');
    const since = s && /^\d{1,12}$/.test(s) ? Number(s) : 0;
    const thread = t && RESUME_RE.test(t) ? t : null;
    const others = registry.running().filter((o) => o.id !== session.id && isCodexSession(o));
    return sendJson(res, 200, await focus.feed(session, { since, thread, others }));
  }

  // ---------- Talk mode (web/talk.js; speech.js, tts.js, claude-turn.js) ----------

  const talkOn = () => !!speech && voiceCfg().talk !== false;
  const codexSpeech = new Map(); // session id -> {thread, since}: where the speech poll left off in the Codex feed
  const spokenSeq = new Map(); // session id -> the turn whose audio was last served (one audit line per turn)
  const forgetTimers = new Set();

  /** A session ended: its last reply stays speakable for a few minutes (the page may still be fetching it). */
  function forgetSpeechLater(id) {
    if (!speech) return;
    const t = setTimeout(() => { forgetTimers.delete(t); speech.forget(id); codexSpeech.delete(id); spokenSeq.delete(id); }, 5 * 60_000);
    t.unref?.();
    forgetTimers.add(t);
  }

  /** The session behind a speech route; 404 when Talk is off or the session is unknown, 400 for other harnesses. */
  function speechSession(key) {
    if (!talkOn()) throw new HttpError(404, 'talk mode is disabled');
    const session = SESSION_ID_RE.test(key) || /^\d+$/.test(key) ? registry.get(key) : null;
    if (!session) throw new HttpError(404, 'unknown session');
    const H = globalThis.cwHarnesses;
    const h = H.getHarness(session.harness) || H.inferHarness(session.command);
    if (!h || (h.id !== 'claude' && h.id !== 'codex')) throw new HttpError(400, 'talk mode is for Claude and Codex sessions');
    return { session, codex: h.id === 'codex' };
  }

  /**
   * Codex has no Stop payload here: its turn ends show up in the rollout feed (codex-focus.js). Reads
   * what is new since the last poll and records the newest final answer when the turn is idle.
   */
  async function refreshCodexSpeech(session) {
    const st = codexSpeech.get(session.id) || { thread: null, since: 0 };
    const others = registry.running().filter((o) => o.id !== session.id && isCodexSession(o));
    const f = await focus.feed(session, { since: st.since, thread: st.thread, others });
    if (!f.available) return;
    codexSpeech.set(session.id, { thread: f.thread.id, since: f.seq });
    if (f.turn !== 'idle') return;
    const answers = f.events.filter((e) => e.kind === 'agent' && (e.phase === 'final_answer' || e.phase == null) && typeof e.text === 'string');
    if (answers.length) speech.record(session.id, answers[answers.length - 1].text);
  }

  /**
   * GET /api/sessions/:key/speech?since=<seq>: the latest finished turn of a session as speakable
   * parts. {seq, engine, turn}: seq is the newest turn's id (0: none yet); turn is present only when
   * it is newer than `since` ({seq, parts, chars, truncated, at}, plus texts for engine 'browser').
   * A page with Talk on polls this; each poll also warms the synthesizer. 404 unknown session or
   * Talk disabled, 400 not a Claude or Codex session. Polled, so neither logged nor audited.
   */
  async function speechPoll(res, key, url) {
    const { session, codex } = speechSession(key);
    if (codex) {
      try { await refreshCodexSpeech(session); } catch (e) { lg.warn(`speech: codex feed failed (session ${session.id}): ${e?.message || e}`); }
    }
    // ?voice=browser: this page speaks with the browser's own voice (its Talk toggle), so the hub
    // prepares no audio for it and sends the text. A hub configured for engine 'browser' always does.
    const browser = voiceCfg().ttsEngine === 'browser' || url.searchParams.get('voice') === 'browser';
    speech.touch(session.id, { synth: !browser });
    if (whisperOn()) stt.warm?.(); // the fallback for a page that cannot listen itself: ready before the first utterance
    const s = url.searchParams.get('since');
    const since = s && /^\d{1,16}$/.test(s) ? Number(s) : 0;
    const turn = speech.latest(session.id);
    return sendJson(res, 200, {
      seq: turn ? turn.seq : 0,
      engine: browser ? 'browser' : 'hub',
      turn: turn && turn.seq > since ? { ...turn, ...(browser ? { texts: speech.texts(session.id, turn.seq) } : {}) } : null,
    });
  }

  /**
   * GET /api/sessions/:key/speech/:seq/:part.wav: one part of a turn as a 16-bit mono WAV, made on
   * first request (speech.js) and cached. Only files the speech cache itself produced are served.
   * 404 stale or unknown turn/part, 503 no synthesizer, 502 synthesis failed. One audit line
   * `speak` per turn (part 0).
   */
  async function speechAudio(req, res, auth, key, seq, part) {
    const { session } = speechSession(key);
    let a;
    try {
      a = await speech.audio(session.id, seq, part);
    } catch (e) {
      if (e instanceof SpeechError) throw new HttpError(e.status, e.message);
      throw e;
    }
    let data;
    try { data = await fsp.readFile(a.file); } catch { throw new HttpError(404, 'speech expired'); }
    if (spokenSeq.get(session.id) !== seq) { // the first part served of a turn
      spokenSeq.set(session.id, seq);
      au.record({ ...who(req, auth), action: 'speak', sessionId: session.id, cwd: session.cwd });
    }
    setCommon(res);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /** Stop hook of a Claude session: remember the final message of the turn for Talk mode. */
  async function captureSpeech(session, payload, ev) {
    let md = typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim() ? payload.last_assistant_message : null;
    // Older Claude Code versions send no message: read the end of the transcript instead (it may lag the hook by a moment).
    for (let attempt = 0; !md && ev.claudeSessionId && attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 500));
      md = await readFinalAssistantText({ claudeHome: home, cwd: session.cwd ?? ev.cwd, claudeSessionId: ev.claudeSessionId });
    }
    if (md) speech.record(session.id, md);
  }

  /** DELETE /api/recent/:id: removes one recent entry (running sessions are never touched). */
  async function deleteRecent(req, res, auth, id) {
    const entry = SESSION_ID_RE.test(id) ? registry.findRecent(id) : null;
    if (!entry || entry.id !== id || !registry.removeRecent(id)) throw new HttpError(404, 'unknown recent session');
    au.record({ ...who(req, auth), action: 'recent-delete', sessionId: id, cwd: entry.cwd });
    lg.info(`recent session ${id} removed`);
    broadcastList();
    return sendJson(res, 204);
  }

  /** DELETE /api/recent: clears recent; `?hidden=1` only the hidden-by-default entries. */
  async function clearRecent(req, res, auth, url) {
    const onlyHidden = url.searchParams.get('hidden') === '1';
    if (onlyHidden) await refreshRecentTitles(); // hasTranscript must be current
    const removed = registry.clearRecent(onlyHidden ? isHidden : undefined);
    au.record({ ...who(req, auth), action: onlyHidden ? 'recent-clear-hidden' : 'recent-clear' });
    lg.info(`recent cleared (${onlyHidden ? 'hidden only' : 'all'}): ${removed} removed`);
    broadcastList();
    return sendJson(res, 200, { ok: true, removed, remaining: registry.recent().length });
  }

  // ---------- voice dictation (docs/evidence/voice/PLAN.md) ----------

  const voiceCfg = () => (config.voice && typeof config.voice === 'object' ? config.voice : { enabled: false });
  /** Whisper dictation is usable: enabled, engine whisper, and a transcriber was wired in. */
  const whisperOn = () => { const v = voiceCfg(); return v.enabled !== false && v.engine !== 'browser' && !!stt; };

  /** GET /api/voice: what the page needs to decide which engine to use. Never the python path. */
  function voiceInfo() {
    const v = voiceCfg();
    const enabled = v.enabled !== false && (v.engine === 'browser' || !!stt);
    return {
      enabled,
      engine: v.engine === 'browser' ? 'browser' : 'whisper',
      model: v.model ?? null,
      language: v.language ?? 'auto',
      device: v.device ?? 'auto',
      transcriber: stt ? stt.status().state : 'absent',
      maxSeconds: VOICE_MAX_SECONDS,
      requestTimeoutSeconds: v.requestTimeoutSeconds ?? null,
      talk: talkInfo(),
    };
  }

  /** The Talk mode part of GET /api/voice. Never paths. */
  function talkInfo() {
    const v = voiceCfg();
    const enabled = talkOn();
    const engine = v.ttsEngine ?? 'kokoro';
    const st = speech?.status?.() ?? { synth: false, state: 'absent' };
    return {
      enabled,
      engine,
      available: enabled && (engine === 'browser' || st.synth),
      synthesizer: engine === 'browser' ? 'page' : st.state,
      voice: v.ttsVoice ?? null,
      speed: v.ttsSpeed ?? 1,
      maxChars: v.ttsMaxChars ?? 600,
      browserStt: v.talkBrowserStt !== false, // Talk may listen with the browser's SpeechRecognition (audio goes to the browser vendor)
    };
  }

  /**
   * /ws/voice/:id. Binary frames: PCM16 LE mono 16 kHz chunks of one utterance. Text frames:
   * {t:'start'} or {t:'cancel'} drop the buffer, {t:'end'} transcribes it and answers
   * {t:'final', text, ms, language} (or {t:'error', message}); {t:'ping'} -> {t:'pong'}.
   * One transcription in flight per socket: an `end` while one is pending is answered with
   * {t:'error', code:'busy'} and its audio dropped. One audit line `voice` per utterance. Audio
   * and text are never logged.
   */
  function onVoiceSocket(ws, req, auth, id) {
    const session = SESSION_ID_RE.test(id) ? registry.get(id) : null;
    if (!session) { ws.close(4404, 'unknown session'); return; }
    if (!whisperOn()) { ws.close(4503, 'voice disabled'); return; }
    trackAlive(ws);
    const actor = who(req, auth);
    const maxBytes = VOICE_BYTES_PER_SECOND * VOICE_MAX_SECONDS;
    let chunks = [];
    let bytes = 0;
    let overflow = false;
    let inflight = false;
    const send = (obj) => sendTo(ws, encodeControl(obj));
    const drop = () => { chunks = []; bytes = 0; overflow = false; };
    ws.on('message', (data, isBinary) => {
      missedPongs.set(ws, 0);
      let d;
      try { d = decodeMessage(data, isBinary); } catch { return; }
      if (d.kind === 'input') {
        if (overflow) return;
        if (bytes + d.bytes.length > maxBytes) {
          drop();
          overflow = true;
          send({ t: 'error', message: `utterance too long (${VOICE_MAX_SECONDS} s max); release and try again` });
          return;
        }
        chunks.push(d.bytes);
        bytes += d.bytes.length;
        return;
      }
      const { t } = d.msg;
      if (t === PING) { send({ t: PONG }); return; }
      if (t === 'start' || t === 'cancel') { drop(); return; }
      if (t !== 'end') return;
      const wasOverflow = overflow;
      const pcm = Buffer.concat(chunks);
      drop();
      if (wasOverflow) return; // the error went out when the cap was hit
      if (inflight) { send({ t: 'error', code: 'busy', message: 'still transcribing the previous utterance; try again in a moment' }); return; }
      au.record({ ...actor, action: 'voice', sessionId: session.id, cwd: session.cwd });
      if (pcm.length < VOICE_MIN_BYTES) { send({ t: 'final', text: '', ms: 0, language: '' }); return; }
      const t0 = Date.now();
      inflight = true;
      stt.transcribe(pcm)
        .then((r) => {
          lg.info(`voice: ${(pcm.length / VOICE_BYTES_PER_SECOND).toFixed(1)} s of audio -> ${r.text.length} chars in ${Date.now() - t0} ms (session ${session.id})`);
          send({ t: 'final', text: r.text, ms: r.ms, language: r.language });
        })
        .catch((e) => {
          lg.warn(`voice: transcription failed (session ${session.id}): ${e?.message || e}`);
          send({ t: 'error', message: String(e?.message || 'transcription failed').slice(0, 300) });
        })
        .finally(() => { inflight = false; });
    });
    send({ t: 'ready', engine: 'whisper', model: voiceCfg().model ?? null, maxSeconds: VOICE_MAX_SECONDS });
  }

  async function projects(all) {
    const key = all ? 'all' : 'default';
    const hit = projectsCache.get(key);
    if (hit && Date.now() - hit.at < projectsCacheMs) return hit.value;
    const [recent, roots] = await Promise.all([
      recentProjects({ claudeHome: home, includeWorktrees: all }),
      rootDirs(Array.isArray(config.projectRoots) ? config.projectRoots : []),
    ]);
    const value = { recent, roots };
    projectsCache.set(key, { at: Date.now(), value });
    return value;
  }

  // cwSessionId (live session) first, else the newest running session with the same cwd.
  // Returns {session, exact}: exact is true only for a cwSessionId match; a cwd-only match is a guess.
  function findHookSession(ev) {
    if (ev.cwSessionId && SESSION_ID_RE.test(ev.cwSessionId)) {
      const s = registry.get(ev.cwSessionId);
      if (s) return { session: s, exact: true };
    }
    if (ev.cwd) {
      let key;
      try { key = cwdKey(ev.cwd); } catch { key = null; }
      let best = null;
      for (const s of registry.running()) {
        if (key && cwdKey(s.cwd) === key && (!best || s.index > best.index)) best = s;
      }
      if (best) return { session: best, exact: false };
    }
    return { session: null, exact: false };
  }

  async function hook(req, res, auth) {
    // Never blocks or fails Claude: always 204; errors (including a malformed body) are only logged.
    try {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (e) {
        lg.warn(`hook: ignoring bad body: ${e.message}`);
        return sendJson(res, 204);
      }
      // notifyPreview (opt-in): a Stop's last_assistant_message becomes the "finished" body. It is
      // used for the push only; nothing below logs ev.message.
      // Which harness sent it: Gemini's own event names, else the matched session's hook channel
      // (codex), else Claude. The session lookup only needs the ids, which do not depend on it.
      const { session, exact } = findHookSession(mapHookEvent(payload));
      const inferred = inferHookHarness(payload);
      // Only a cwSessionId match says which harness sent this; a cwd-only match must not relabel it.
      const sessionChannel = exact ? (globalThis.cwHarnesses.getHarness(session?.harness)?.hooks ?? null) : null;
      const harness = inferred !== 'claude' ? inferred : (sessionChannel || 'claude');
      const ev = mapHookEvent(payload, { preview: config.notifyPreview === true, harness });
      if (session) {
        let changed = false;
        // claudeSessionId stays Claude-only (Resume); other harnesses report theirs in harnessSessionId.
        const idField = harness === 'claude' ? 'claudeSessionId' : 'harnessSessionId';
        if (exact && ev.claudeSessionId && session[idField] !== ev.claudeSessionId) {
          session[idField] = ev.claudeSessionId;
          changed = true;
          registry.save?.(); // so Resume survives a hub crash
        }
        if (ev.kind === 'needs-input' && !session.needsInput && session.state === 'running') {
          session.needsInput = true;
          changed = true;
        }
        // Stop: Claude finished its turn, so nothing is pending (controller ruling).
        const turnEnded = harness === 'claude' ? payload.hook_event_name === 'Stop' : ev.kind === 'finished';
        if (turnEnded && session.needsInput) {
          session.needsInput = false;
          changed = true;
        }
        if (changed) broadcastList();
        // Talk mode: the Stop of a Claude turn (an exact match, or a cwd match whose Claude session id agrees).
        if (talkOn() && harness === 'claude' && payload.hook_event_name === 'Stop' && !payload.stop_hook_active
          && (exact || (session.claudeSessionId && session.claudeSessionId === ev.claudeSessionId))) {
          captureSpeech(session, payload, ev).catch((e) => lg.warn(`speech: could not read the reply (session ${session.id}): ${e?.message || e}`));
        }
        // Claude writes its transcript as it goes: pick up the title (not awaited; never blocks Claude).
        if (harness === 'claude') {
          const s = session;
          refreshSessionTitle(s).then((c) => {
            if (!c) return;
            if (s.state === 'running') registry.save?.();
            else refreshRecentTitles([s.id]).catch(() => {});
            broadcastList();
          }).catch((e) => lg.warn(`title refresh failed: ${e?.message || e}`));
        }
      }
      au.record({ ...who(req, auth), action: 'hook', sessionId: session?.id, cwd: session?.cwd ?? ev.cwd });
      lg.info(`hook ${typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '?'} -> ${ev.kind}${session ? ` (session ${session.id})` : ''}`);
      const notify = ev.kind === 'needs-input' || ev.kind === 'finished' || (ev.kind === 'idle' && config.notifyIdle);
      if (notify && notifier) {
        const n = formatNotification(ev.kind, { index: session?.index, cwd: session?.cwd ?? ev.cwd, message: ev.message, harness });
        const click = n && (session ? `${publicBase()}/s/${session.id}` : `${publicBase()}/`);
        // Unmapped sessions (not started by cw) share the `/` link: keep Claude's session id in the
        // key so two different sessions in one folder are not merged into one notification.
        const who = session ? session.id : `${harness}:${ev.claudeSessionId || ''}`;
        if (n && isDuplicateNotification(`${who}\n${click}\n${n.title}\n${n.message}`)) {
          lg.info(`notification suppressed (identical one sent less than ${notifyDebounceMs / 1000} s ago)`);
        } else if (n) {
          // Not awaited: ntfy can take seconds (timeout + retry); the hook caller must not wait.
          Promise.resolve(notifier.send({ ...n, click })).catch((e) => lg.warn(`notify failed: ${e?.message || e}`));
        }
      }
    } catch (e) {
      lg.error(`hook handling failed: ${e?.stack || e}`);
    }
    if (!res.headersSent) sendJson(res, 204);
  }

  /** True if an identical notification (same link, title and text) went out within the window. */
  function isDuplicateNotification(key, now = Date.now()) {
    for (const [k, at] of recentNotifications) if (now - at >= notifyDebounceMs) recentNotifications.delete(k);
    if (recentNotifications.has(key)) return true;
    recentNotifications.set(key, now);
    return false;
  }

  /** POST /api/notify/test (`cw notify test`): 204 once ntfy accepted it, 502 otherwise. */
  async function notifyTest(req, res, auth) {
    await readJsonBody(req); // same content-type/size rules as every POST; the body is unused
    au.record({ ...who(req, auth), action: 'notify-test' });
    const ok = notifier
      ? await notifier.send({
        title: 'cw test notification',
        message: 'If this reached your phone, cw notifications work.',
        click: `${publicBase()}/`,
        priority: 'default',
        tags: ['bell'],
      })
      : false;
    lg.info(`notify test ${ok ? 'sent' : 'not delivered'}`);
    if (ok) return sendJson(res, 204);
    return sendJson(res, 502, { error: 'test notification not delivered (no ntfy topic, or ntfy unreachable; see hub.log)' });
  }

  /**
   * Closes (4401) every WebSocket whose token is no longer in tokens.json, and every `ts:<login>`
   * socket whose login is no longer allowed (or Tailscale auth was disabled). Authentication
   * happens only at upgrade, so without this a removed token keeps its open shells (final review I2).
   * @returns {number} sockets closed
   */
  function revokeRemovedTokens(tokenList, tsAuth) {
    const names = new Set((tokenList || []).map((t) => t.name));
    const allowed = new Set(tsAuth?.enabled ? tsAuth.allow : []);
    let n = 0;
    for (const ws of wss.clients) {
      const name = socketToken.get(ws);
      if (name === undefined) continue;
      const ts = name.startsWith(TS_NAME_PREFIX);
      if (ts ? allowed.has(name.slice(TS_NAME_PREFIX.length)) : names.has(name)) continue;
      n++;
      try { ws.close(4401, ts ? 'access revoked' : 'token revoked'); } catch { /* gone */ }
    }
    return n;
  }

  /**
   * POST /api/tokens/reload (`cw token rm`, `cw auth tailscale remove|disable`): re-reads
   * tokens.json and config.tailscaleAuth, and closes revoked sockets.
   */
  async function tokensReload(req, res, auth) {
    await readJsonBody(req);
    const list = getTokens(true) || [];
    const ts = getTsAuth(true);
    const closedSockets = revokeRemovedTokens(list, ts);
    au.record({ ...who(req, auth), action: 'tokens-reload' });
    lg.info(`tokens reloaded (${list.length} token(s)); closed ${closedSockets} websocket(s) of removed tokens or logins (tailscale auth ${ts?.enabled ? `enabled for ${ts.allow.join(', ')}` : 'disabled'})`);
    return sendJson(res, 200, { ok: true, tokens: list.length, closed: closedSockets });
  }

  async function hubStop(req, res, auth) {
    const body = await readJsonBody(req);
    const running = registry.running().length;
    if (running > 0 && body.force !== true) return sendJson(res, 409, { error: 'sessions running', running });
    au.record({ ...who(req, auth), action: 'hub-stop' });
    lg.info(`hub stop requested (running=${running}, force=${body.force === true})`);
    res.on('finish', () => {
      if (typeof onStop !== 'function') { lg.warn('hub stop requested but no onStop handler'); return; }
      try {
        Promise.resolve(onStop()).catch((e) => lg.error(`onStop failed: ${e?.stack || e}`));
      } catch (e) {
        lg.error(`onStop failed: ${e?.stack || e}`);
      }
    });
    return sendJson(res, 202, { ok: true, stopping: true });
  }

  // ---------- WebSocket ----------

  function rejectUpgrade(socket, status, text) {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    socket.destroy();
  }

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    if (closed) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    const bad = checkHostOrigin(req, { checkOrigin: true });
    if (bad) {
      logRejected(req, 'ws', bad.status);
      return rejectUpgrade(socket, bad.status, bad.text);
    }
    const auth = authenticate(req, getTokens() || [], { tailscaleAuth: getTsAuth() });
    if (!auth) {
      logAuthFailure(req, 'ws');
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (originRequired(req, auth)) {
      logRejected(req, 'ws', 403, 'tailscale login without Origin');
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const p = url.pathname;
    if (p === '/ws/list') {
      return wss.handleUpgrade(req, socket, head, (ws) => { socketToken.set(ws, auth.name); onListSocket(ws); });
    }
    let m = /^\/ws\/session\/([^/]+)$/.exec(p);
    if (m) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        socketToken.set(ws, auth.name);
        onSessionSocket(ws, req, auth, m[1], url).catch((e) => {
          lg.error(`session socket failed: ${e?.stack || e}`);
          try { ws.close(1011, 'internal error'); } catch { /* gone */ }
        });
      });
    }
    m = /^\/ws\/voice\/([^/]+)$/.exec(p);
    if (m) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        socketToken.set(ws, auth.name);
        try { onVoiceSocket(ws, req, auth, m[1]); } catch (e) {
          lg.error(`voice socket failed: ${e?.stack || e}`);
          try { ws.close(1011, 'internal error'); } catch { /* gone */ }
        }
      });
    }
    return rejectUpgrade(socket, 404, 'Not Found');
  }

  function trackAlive(ws) {
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
    ws.on('error', (e) => lg.warn(`websocket error: ${e?.message || e}`));
  }

  function onListSocket(ws) {
    trackAlive(ws);
    listClients.add(ws);
    ws.on('close', () => listClients.delete(ws));
    ws.on('message', (data, isBinary) => {
      missedPongs.set(ws, 0);
      let d;
      try { d = decodeMessage(data, isBinary); } catch { return; }
      if (d.kind === 'control' && d.msg.t === PING) sendTo(ws, encodeControl({ t: PONG }));
    });
    sendTo(ws, encodeControl({ t: SESSIONS, ...listSnapshot() }));
    // Listing refreshes recent titles; a change reaches every list client.
    refreshRecentTitles().then((c) => { if (c) broadcastList(); })
      .catch((e) => lg.warn(`title refresh failed: ${e?.message || e}`));
  }

  /**
   * The session's snippets right after init, so a phone that attaches late (or reconnects) has the
   * tray too. The client replaces its tray with this list. Sent only when there are any: a
   * session's list never shrinks to empty, so a client with an empty tray has nothing to replace.
   */
  function sendSnippets(ws, session) {
    const list = Array.isArray(session.snippets) ? session.snippets : [];
    if (list.length) sendTo(ws, encodeControl({ t: SNIPPETS, snippets: list }));
  }

  const parseSize = (v) => (v !== null && /^\d{1,5}$/.test(v) ? Number(v) : null);

  async function onSessionSocket(ws, req, auth, id, url) {
    const session = SESSION_ID_RE.test(id) ? registry.get(id) : null;
    if (!session) { ws.close(4404, 'unknown session'); return; }
    trackAlive(ws);
    const clientId = crypto.randomBytes(8).toString('hex');
    const kind = url.searchParams.get('kind') === 'local' ? 'local' : 'web';
    const qc = parseSize(url.searchParams.get('cols'));
    const qr = parseSize(url.searchParams.get('rows'));
    const actor = who(req, auth);
    let attached = false;
    let closedEarly = false;
    let inputAudited = false;
    const pending = [];

    const onMessage = (data, isBinary) => {
      let d;
      try { d = decodeMessage(data, isBinary); } catch { return; }
      if (d.kind === 'input') {
        // Terminal-generated replies/reports (DA, CPR, focus, ...) are dropped from every client:
        // the hub's headless terminal answers queries itself (answerQueries), so these would be
        // duplicates, and focus reports from several tabs would contradict each other.
        if (isPassiveInput(d.bytes)) return;
        const before = session.needsInput;
        if (!session.write(d.bytes, clientId)) return;
        if (!inputAudited) {
          inputAudited = true;
          au.record({ ...actor, action: 'input', sessionId: session.id, cwd: session.cwd });
        }
        if (before && !session.needsInput) broadcastList();
        return;
      }
      const msg = d.msg;
      if (msg.t === RESIZE) {
        if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) session.resizeFrom(clientId, msg.cols, msg.rows);
      } else if (msg.t === PING) {
        sendTo(ws, encodeControl({ t: PONG }));
      }
    };

    ws.on('message', (data, isBinary) => {
      missedPongs.set(ws, 0);
      if (attached) onMessage(data, isBinary);
      else pending.push([data, isBinary]);
    });
    ws.on('close', () => {
      if (!attached) { closedEarly = true; return; }
      const m = sessionClients.get(session.id);
      if (m) {
        m.delete(clientId);
        if (m.size === 0) sessionClients.delete(session.id);
      }
      if (session.detach(clientId)) broadcastList();
    });

    // Late-attach race (Task 2 concern 4): let the headless terminal parse everything received so
    // far, then serialize and join the broadcast set in the same tick.
    try { await session.flush(); } catch { /* serialize whatever is there */ }
    if (closedEarly || ws.readyState !== WebSocket.OPEN) return;

    if (session.state !== 'running') {
      // Exited but still retained: show the final screen, then the exit.
      sendTo(ws, encodeControl({ t: INIT, cols: session.cols, rows: session.rows, data: session.serialize(), needsInput: false }));
      sendSnippets(ws, session); // a command the agent left is still worth copying
      sendTo(ws, encodeControl({ t: EXIT, code: session.exitCode }));
      ws.close(1000, 'session exited');
      return;
    }

    // No size in the query: attach with a null size, so this client cannot own the size until it
    // reports one (a reconnecting follower must not take ownership from the real owner).
    const hasSize = qc !== null && qr !== null;
    session.attach(clientId, { cols: hasSize ? qc : null, rows: hasSize ? qr : null, name: auth.name, kind });
    clientsOf(session.id).set(clientId, ws);
    attached = true;
    sendTo(ws, encodeControl({
      t: INIT, cols: session.cols, rows: session.rows, data: session.serialize(), needsInput: session.needsInput,
    }));
    sendSnippets(ws, session);
    au.record({ ...actor, action: 'attach', sessionId: session.id, cwd: session.cwd });
    broadcastList();
    for (const [data, isBinary] of pending.splice(0)) onMessage(data, isBinary);
  }

  /** Session callbacks; hub.js wires each Session's onData/onResize/onExit to these. */
  const sessionEvents = {
    data(id, bytes) {
      const m = sessionClients.get(id);
      if (!m) return;
      for (const ws of m.values()) sendTo(ws, bytes, { binary: true });
    },
    resize(id, cols, rows, ownerId) {
      const m = sessionClients.get(id);
      if (!m) return;
      const msg = encodeControl({ t: RESIZE, cols, rows });
      for (const [cid, ws] of m) if (cid !== ownerId) sendTo(ws, msg);
    },
    /**
     * A bell / OSC 9, 777, 99 notification from a session's program (session.js _handleNotify).
     * Policy: config.notifyBell === true, or 'auto' and an agent harness with no hook channel (not a shell or custom command), and not
     * harnesses.<id>.bell === false. Returns false when not wanted (the row is not marked either).
     * One push per session per notifyDebounceMs, however often it rings. The text the program sent
     * is the push body only with notifyPreview; it is never logged.
     */
    notify(session, n) {
      const mode = config.notifyBell === undefined ? 'auto' : config.notifyBell;
      const h = globalThis.cwHarnesses.getHarness(session.harness);
      const wanted = mode === true || (mode === 'auto' && globalThis.cwHarnesses.isAgent(h) && (h.hooks ?? null) === null);
      if (!wanted || harnessConfig()[session.harness]?.bell === false) return false;
      const now = Date.now();
      const last = bellSent.get(session.id);
      if (last !== undefined && now - last < notifyDebounceMs) return true;
      if (!notifier) return true;
      const out = formatNotification('attention', {
        index: session.index, cwd: session.cwd, message: config.notifyPreview === true ? n.text : null,
      });
      const click = `${publicBase()}/s/${session.id}`;
      if (isDuplicateNotification(`${session.id}\n${click}\n${out.title}\n${out.message}`, now)) return true;
      bellSent.set(session.id, now);
      lg.info(`bell -> attention (session ${session.id})`);
      Promise.resolve(notifier.send({ ...out, click })).catch((e) => lg.warn(`notify failed: ${e?.message || e}`));
      return true;
    },
    /** A new snippet (POST .../snippets or OSC 52, session.js addSnippet): to every attached client. */
    snippet(id, snippet) {
      const m = sessionClients.get(id);
      if (!m) return;
      const msg = encodeControl({ t: SNIPPET, ...snippet });
      for (const ws of m.values()) sendTo(ws, msg);
    },
    exit(id, code) {
      bellSent.delete(id);
      focus.forget(id); // an exited session's feed locates its file again if it is still viewed
      forgetSpeechLater(id);
      const m = sessionClients.get(id);
      lg.info(`session ${id} exited (code ${code})`);
      if (m) {
        const msg = encodeControl({ t: EXIT, code });
        for (const ws of m.values()) {
          sendTo(ws, msg);
          // ws sends the close frame after already-queued frames, so the exit message is flushed.
          try { ws.close(1000, 'session exited'); } catch { /* gone */ }
        }
      }
      broadcastList();
      // Final title for the recent entry (the registry has already moved it there).
      refreshRecentTitles([id]).then((c) => { if (c) broadcastList(); })
        .catch((e) => lg.warn(`title refresh failed: ${e?.message || e}`));
    },
  };

  return {
    httpServer,
    wss,
    sessionEvents,
    broadcastList,
    /** Closes sockets of removed tokens / logins (review F3: hub.js calls it after a config.json reload). */
    revokeRemoved: (tokenList, tsAuth) => revokeRemovedTokens(tokenList ?? (getTokens() || []), tsAuth ?? getTsAuth()),
    /**
     * @returns {Promise<number>} the bound port. Rejects without binding when Tailscale auth is
     * enabled and `host` is not loopback: the identity header is only trustworthy from the local
     * tailscale serve proxy.
     */
    listen(port, host = '127.0.0.1') {
      const ts = getTsAuth();
      if (ts?.enabled && !isLoopbackAddress(host)) {
        return Promise.reject(new Error(`refusing to listen on ${host}: tailscaleAuth is enabled, which is only safe on a loopback bind behind tailscale serve`));
      }
      return new Promise((resolve, reject) => {
        const onError = (e) => { httpServer.off('listening', onListening); reject(e); };
        const onListening = () => { httpServer.off('error', onError); resolve(httpServer.address().port); };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    /** Closes all sockets and the HTTP server. */
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(titleTimer);
      for (const t of forgetTimers) clearTimeout(t);
      forgetTimers.clear();
      for (const ws of wss.clients) { try { ws.close(1001, 'hub stopping'); } catch { /* gone */ } }
      return new Promise((resolve) => {
        const t = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000);
        t.unref?.();
        wss.close(() => {
          httpServer.close(() => { clearTimeout(t); resolve(); });
          httpServer.closeAllConnections?.();
        });
      });
    },
  };
}
