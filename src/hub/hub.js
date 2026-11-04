// Hub entry point (`npm run hub`, or spawned detached by the cw CLI). Binds 127.0.0.1 only.
//
// Environment:
//   CW_PORT         port (0 = ephemeral, for tests); else config.json `port` (default 4242)
//   CW_DATA_DIR     data dir (config, tokens, sessions, logs); default ~/.cw (%USERPROFILE%\.cw)
//   CW_CLAUDE_HOME  Claude Code home for /api/projects (default ~/.claude)
//   CW_CLAUDE_PATH  default session command (else config.claudePath, else claude.exe on PATH)
//   CW_PUBLIC_BASE  base URL used in notification click links (else config.publicBase, else
//                   https://<tailnet name>:<port> when tailscale answers, else http://127.0.0.1:<port>)
//   CW_TAILSCALE_FAKE_JSON test hook: read this file instead of running `tailscale status --json`
//                   (a missing file means "no tailscale")
//   CW_NTFY_CAPTURE test hook: append each would-be ntfy POST as a JSON line to this file
//                   instead of sending it
//   CW_STT_FAKE     test hook: run `node <this file>` as the voice transcriber instead of
//                   `<config.voice.python> src/hub/stt-sidecar.py`
//   CW_TTS_FAKE     test hook: run `node <this file>` as the Talk mode speech synthesizer instead of
//                   `<config.voice.ttsPython> src/hub/tts-sidecar.py`
//   CW_HOST         not supported: logged and ignored (loopback only)
//
// On start it prints exactly one stdout line `cw-hub listening 127.0.0.1:<port>` and writes
// <dataDir>/hub.pid and <dataDir>/hub.port.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir as defaultDataDir, loadConfig, claudeHome as defaultClaudeHome, normalizeVoice, normalizeTailscaleAuth, normalizeHarnesses, normalizeSessionColors, normalizeDefaultHarness } from './config.js';
import { createModels } from './models.js';
import { createStt } from './stt.js';
import { createTts, enginesFor } from './tts.js';
import { createSpeech } from './speech.js';
import { resolveLaunch } from './launch.js';
import { createLogger } from './log.js';
import { loadTokens } from './auth.js';
import { createAudit } from './audit.js';
import { createNotifier } from './notify.js';
import { createRegistry } from './registry.js';
import { Session } from './session.js';
import { createServer } from './server.js';
import { discoverTailscale } from './tailscale.js';
import { normalizeStripEnv } from './spawn-env.js';

const HOST = '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * Resolves a command the way a shell would: a path (absolute, or containing a separator) is used
 * if it exists (a relative one resolved against `cwd`, the session's directory); a bare name is searched on PATH as given and with .exe/.com appended
 * (node-pty only searches PATH for the exact name, so `pwsh` would otherwise fail).
 * Throws err.code === 'ENOENT' if nothing is found.
 */
export function resolveCommand(command, env = process.env, cwd = process.cwd()) {
  const notFound = () => Object.assign(new Error(`command not found: ${command}`), { code: 'ENOENT' });
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    const full = path.resolve(cwd, command); // relative paths are relative to the session's cwd
    if (isFile(full)) return full;
    throw notFound();
  }
  const exts = path.extname(command) || process.platform !== 'win32' ? [''] : ['.exe', '.com'];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const f = path.join(d, command + ext);
      if (isFile(f)) return f;
    }
  }
  // App execution aliases (e.g. %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe) are reparse points
  // that Node's stat reports as ENOENT, yet CreateProcess runs them. readdir does list them.
  const wanted = new Set(exts.map((e) => (command + e).toLowerCase()));
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    const hit = names.find((n) => wanted.has(n.toLowerCase()));
    if (hit) return path.join(d, hit);
  }
  throw notFound();
}

/** Default session command: first `claude.exe` on PATH, else the bare name. */
export function resolveClaudeCommand(env = process.env) {
  try { return resolveCommand('claude.exe', env); } catch { return 'claude.exe'; }
}

/**
 * Re-reads tokens.json when its mtime/size changes (or when called with force = true, from
 * POST /api/tokens/reload), so `cw token add|rm` apply without a restart.
 */
function tokenSource(dir, log) {
  const file = path.join(dir, 'tokens.json');
  let tokens = loadTokens(dir); // creates the first token on first run
  let stamp = null;
  const statStamp = () => { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; };
  try { stamp = statStamp(); } catch { /* re-checked on use */ }
  return (force = false) => {
    try {
      const s = statStamp();
      if (force || s !== stamp) {
        tokens = loadTokens(dir);
        stamp = s;
      }
    } catch (e) {
      log.warn(`tokens reload failed, keeping previous tokens: ${e.message}`);
    }
    return tokens;
  };
}

const tsAuthText = (ts) => (ts.enabled ? `enabled for ${ts.allow.join(', ')}` : `disabled${ts.allow.length ? '' : ' (allow list empty)'}`);

/**
 * Re-reads config.tailscaleAuth when config.json's mtime/size changes (or when called with
 * force = true, from POST /api/tokens/reload), so `cw auth tailscale add|remove|enable|disable`
 * apply without a restart. A malformed file keeps the previous settings (never opens the door).
 * `onChange(next)` runs when the effective settings changed (review F3: close revoked sockets).
 */
function tailscaleAuthSource(dir, log, initial, onChange) {
  const file = path.join(dir, 'config.json');
  let value = initial;
  let stamp = null;
  const statStamp = () => { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; };
  try { stamp = statStamp(); } catch { /* re-checked on use */ }
  return (force = false) => {
    try {
      const s = statStamp();
      if (force || s !== stamp) {
        const warnings = [];
        const next = normalizeTailscaleAuth(loadConfig().tailscaleAuth, { warn: (m) => warnings.push(m) });
        for (const w of warnings) log.warn(w);
        const changed = JSON.stringify(next) !== JSON.stringify(value);
        value = next;
        stamp = s;
        if (changed) {
          log.info(`tailscale auth: ${tsAuthText(next)} (config.json changed)`);
          try { onChange?.(next); } catch (e) { log.warn(`tailscale auth change handling failed: ${e.message}`); }
        }
      }
    } catch (e) {
      log.warn(`tailscale auth reload failed, keeping previous settings: ${e.message}`);
    }
    return value;
  };
}

function captureFetch(file) {
  return async (url, init = {}) => {
    fs.appendFileSync(file, JSON.stringify({ url, method: init.method, headers: init.headers, body: init.body }) + '\n');
    return { ok: true, status: 200, body: null };
  };
}

/** Tailscale discovery, or the CW_TAILSCALE_FAKE_JSON test hook (same parser, file instead of binary). */
function defaultDiscover() {
  const fake = process.env.CW_TAILSCALE_FAKE_JSON;
  if (!fake) return discoverTailscale();
  return discoverTailscale({ candidates: [fake], execFileImpl: (file, args, opts, cb) => fs.readFile(file, 'utf8', cb) });
}

const TAILSCALE_RETRY_MS = 60_000;

/**
 * Host/Origin names allowed for a discovered tailnet name. The port-less name is allowed only when
 * the hub itself is on 443: otherwise `https://<dns>` is a different origin (any page `tailscale
 * serve` puts on 443 of this machine), and since cookies are not port-isolated, accepting it would
 * give that page an authenticated WebSocket (final review C1).
 */
export function tailnetAllowedHosts(dnsName, port) {
  return port === 443 ? [dnsName] : [`${dnsName}:${port}`];
}

function envPort() {
  const raw = process.env.CW_PORT;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : null;
}

/**
 * Starts the hub. Rejects with the listen error (e.g. code EADDRINUSE) if the port is taken.
 * @param {object} [o]
 * @param {number} [o.port] default CW_PORT, else config.port
 * @param {string} [o.dataDir] default CW_DATA_DIR / ~/.cw
 * @param {string} [o.claudeHome]
 * @param {Function} [o.fetchImpl] notifier fetch (default: capture file if CW_NTFY_CAPTURE, else fetch)
 * @param {Function} [o.exit] called with the exit code after an /api/hub/stop or signal shutdown
 *   (default process.exit — node-pty keeps the event loop alive, so the process must exit explicitly)
 * @param {boolean} [o.handleSignals] install SIGINT/SIGTERM/SIGBREAK handlers (default true)
 * @param {Function} [o.discoverTailscale] resolves {dnsName, ips} or null (default: tailscale CLI)
 * @param {number} [o.tailscaleRetryMs] retry interval while tailscale is not available (default 60 s)
 * @returns {Promise<{port:number, close:()=>Promise<void>, server:object, registry:object, log:object}>}
 */
export async function startHub(o = {}) {
  if (o.dataDir) process.env.CW_DATA_DIR = o.dataDir;
  const dir = defaultDataDir();
  const log = o.log || createLogger(path.join(dir, 'hub.log'));
  // Test hooks must never be active silently in a real hub (an inherited env var would do that).
  if (process.env.CW_TAILSCALE_FAKE_JSON) log.warn(`CW_TAILSCALE_FAKE_JSON is set: reading ${process.env.CW_TAILSCALE_FAKE_JSON} instead of running tailscale (test hook)`);
  if (process.env.CW_NTFY_CAPTURE) log.warn(`CW_NTFY_CAPTURE is set: notifications are written to ${process.env.CW_NTFY_CAPTURE}, not sent (test hook)`);
  if (process.env.CW_TTS_FAKE) log.warn(`CW_TTS_FAKE is set: Talk mode speech runs node ${process.env.CW_TTS_FAKE} instead of python (test hook)`);
  if (process.env.CW_STT_FAKE) log.warn(`CW_STT_FAKE is set: voice transcription runs node ${process.env.CW_STT_FAKE} instead of python (test hook)`);
  if (process.env.CW_HOST) log.warn(`CW_HOST=${process.env.CW_HOST} ignored: the hub only binds ${HOST}`);

  // cleanup: drop default values older versions pinned into config.json (logged once).
  const config = loadConfig({ cleanup: true, log });
  const stripEnv = normalizeStripEnv(config.stripEnv, log); // a bad value warns once, here
  const voice = normalizeVoice(config.voice, log); // likewise, one WARN per bad key
  const harnesses = normalizeHarnesses(config.harnesses, log);
  const sessionColors = normalizeSessionColors(config.sessionColors, log);
  const defaultHarness = normalizeDefaultHarness(config.defaultHarness, harnesses, log);
  const models = createModels({ resolve: resolveCommand, harnessConfig: () => harnesses, stripEnv });
  // Tailscale identity login (docs/evidence/tailscale-auth/PLAN.md): validated here, re-read on change.
  const tailscaleAuth = tailscaleAuthSource(dir, log, normalizeTailscaleAuth(config.tailscaleAuth, log), (next) => {
    // A login removed by editing config.json (not only via `cw auth tailscale remove`) loses its
    // open sockets as soon as the hub notices the change.
    const n = server?.revokeRemoved(undefined, next) ?? 0;
    if (n) log.info(`tailscale auth: closed ${n} websocket(s) of logins no longer allowed`);
  });
  log.info(`tailscale auth: ${tsAuthText(tailscaleAuth())}`);
  const port = o.port ?? envPort() ?? config.port;
  const configuredBase = process.env.CW_PUBLIC_BASE || config.publicBase || null;
  const discover = o.discoverTailscale || defaultDiscover;
  const retryMs = o.tailscaleRetryMs ?? TAILSCALE_RETRY_MS;
  const claudeHomeDir = o.claudeHome || defaultClaudeHome();
  const defaultCommand = process.env.CW_CLAUDE_PATH || config.claudePath || resolveClaudeCommand();
  const version = readVersion();
  const exit = o.exit || ((code) => process.exit(code));

  const tokens = tokenSource(dir, log);
  const audit = createAudit(path.join(dir, 'audit.log'), { log });
  const fetchImpl = o.fetchImpl
    || (process.env.CW_NTFY_CAPTURE ? captureFetch(process.env.CW_NTFY_CAPTURE) : globalThis.fetch);
  const notifier = createNotifier({ server: config.ntfyServer, topic: config.ntfyTopic, topicDone: config.ntfyTopicDone, fetchImpl, log });

  // Voice dictation: the transcriber process is started by the first utterance, never here.
  let stt = null;
  if (voice.enabled && voice.engine === 'whisper') {
    stt = process.env.CW_STT_FAKE
      ? createStt({ voice, log, command: process.execPath, sidecar: process.env.CW_STT_FAKE })
      : createStt({ voice, log });
    log.info(`voice: whisper dictation enabled (model ${voice.model}, device ${voice.device}, language ${voice.language}, idle ${voice.idleMinutes} min)`);
  } else {
    log.info(`voice: ${voice.enabled ? 'browser engine (Web Speech API)' : 'disabled'}`);
  }

  // Talk mode: the synthesizer process is started by the first Talk page (or reply), never here.
  let tts = null;
  let speech = null;
  if (voice.talk) {
    const engines = process.env.CW_TTS_FAKE
      ? enginesFor(voice).map((e) => ({ name: e.name, command: process.execPath, args: [process.env.CW_TTS_FAKE, '--engine', e.name] }))
      : undefined;
    tts = createTts({ voice, log, engines });
    speech = createSpeech({ voice, tts, log });
    log.info(`talk: enabled (${voice.ttsEngine === 'browser' ? 'the page speaks with the browser voice' : `${voice.ttsEngine}${voice.ttsFallback === 'piper' && voice.ttsEngine !== 'piper' ? ' with piper as fallback' : ''}, voice ${voice.ttsVoice}, speed ${voice.ttsSpeed}`}, first ${voice.ttsMaxChars} chars of a reply; audio cache ${speech.cacheDir})`);
  } else {
    log.info('talk: disabled');
  }

  let server = null;
  let boundPort = null;
  const registry = createRegistry({
    dataDir: dir,
    log,
    onChange: () => server?.broadcastList(),
    createSession: async (opts) => {
      const { id, onExit } = opts;
      const launch = resolveLaunch(opts.command, opts.args || [], { env: process.env, cwd: opts.cwd, resolve: resolveCommand });
      log.info(`launch ${id}: ${launch.command} via ${launch.via}`);
      const s = new Session({
        ...opts,
        command: launch.command,
        spawn: launch.via === 'exe' ? null : { file: launch.file, args: launch.commandLine ?? launch.args },
        hubPort: boundPort,
        answerQueries: true,
        // Provider keys named by a preset's requiresEnv reach only that preset's session.
        stripEnv: [...stripEnv, ...globalThis.cwHarnesses.HARNESSES.filter((h) => h.requiresEnv && h.id !== opts.harness).map((h) => h.requiresEnv)],
        onData: (bytes) => server.sessionEvents.data(id, bytes),
        onResize: (cols, rows, ownerId) => server.sessionEvents.resize(id, cols, rows, ownerId),
        onNotify: (n, session) => server.sessionEvents.notify(session, n),
        onSnippet: (snippet) => server.sessionEvents.snippet(id, snippet),
        onChange: () => server?.broadcastList(),
        onExit: (code) => {
          try { onExit(code); } finally { server.sessionEvents.exit(id, code); }
        },
      });
      try {
        await s.start();
      } catch (e) {
        // The command resolved but the PTY did not start: the registry lists it as spawn-failed.
        if (e && typeof e === 'object') e.spawnFailed = true;
        throw e;
      }
      return s;
    },
  });

  let stopping = null;
  const pidFile = path.join(dir, 'hub.pid');
  const portFile = path.join(dir, 'hub.port');

  let tailscaleTimer = null;
  let closed = false;

  async function close() {
    closed = true;
    clearTimeout(tailscaleTimer);
    await server.close();
    if (stt) { try { await stt.stop(); } catch { /* best effort */ } }
    if (tts) { try { await tts.stop(); } catch { /* best effort */ } }
    if (speech) { try { speech.dispose(); } catch { /* best effort */ } }
    registry.dispose();
    for (const f of [pidFile, portFile]) {
      try { if (fs.readFileSync(f, 'utf8').trim() === String(f === pidFile ? process.pid : boundPort)) fs.rmSync(f); } catch { /* gone */ }
    }
  }

  /** Kills every session (graceful), closes the server, then exits. */
  function shutdown(reason) {
    if (stopping) return stopping;
    log.info(`hub stopping (${reason})`);
    stopping = (async () => {
      try { await registry.stop({ force: true }); } catch (e) { log.warn(`stopping sessions failed: ${e.message}`); }
      try { await close(); } catch (e) { log.warn(`close failed: ${e.message}`); }
      log.info('hub stopped');
      exit(0);
    })();
    return stopping;
  }

  // publicBase and allowedHosts are in-memory only: tailscale discovery never writes config.json.
  const serverConfig = { ...config, voice, publicBase: configuredBase, allowedHosts: [] };
  server = createServer({
    config: serverConfig,
    tokens,
    tailscaleAuth,
    registry,
    audit,
    notifier,
    stt,
    speech,
    log,
    webDir: path.join(repoRoot, 'web'),
    version,
    claudeHome: claudeHomeDir,
    defaultCommand,
    harnesses,
    sessionColors,
    defaultHarness,
    resolveCommand,
    models,
    onStop: () => shutdown('api'),
    heartbeatMs: o.heartbeatMs,
  });

  boundPort = await server.listen(port, HOST); // rejects on EADDRINUSE etc.
  serverConfig.port = boundPort; // real port for default notification links (port 0 in tests)

  fs.writeFileSync(pidFile, String(process.pid));
  fs.writeFileSync(portFile, String(boundPort));
  log.info(`hub ${version} listening on ${HOST}:${boundPort} (pid ${process.pid})`);

  // Prewarm: the transcriber (10 to 60 s to import and load) and the synthesizer (10 s) start now,
  // in the background, so the first utterance and the first reply of the day are not the slow ones.
  // They then stay up for voice.idleMinutes (120 by default; 0 never stops them).
  if (voice.prewarm) {
    const warmed = [];
    if (stt?.warm?.()) warmed.push('transcriber');
    if (tts?.configured) { tts.warm(); warmed.push('synthesizer'); }
    if (warmed.length) log.info(`voice: prewarming the ${warmed.join(' and ')}`);
  }

  if (o.handleSignals !== false) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      try { process.on(sig, () => shutdown(sig)); } catch { /* unsupported on this platform */ }
    }
  }

  // Tailscale discovery (up to ~2 s) runs after listen, so /api/health answers immediately; the
  // stdout "listening" line (printed when startHub resolves) comes after it.
  const allowedHostsLine = () => {
    const hosts = [`${HOST}:${boundPort}`, `localhost:${boundPort}`];
    try { if (serverConfig.publicBase) hosts.push(new URL(serverConfig.publicBase).host); } catch { /* invalid publicBase */ }
    hosts.push(...serverConfig.allowedHosts);
    return [...new Set(hosts.map((h) => h.toLowerCase()))].join(', ');
  };
  /** Tailnet name -> in-memory publicBase + Host/Origin allowlist (port-less only on 443). */
  async function applyTailscale() {
    let ts = null;
    try { ts = await discover(); } catch { ts = null; }
    if (!ts || stopping || closed) return false;
    serverConfig.publicBase = `https://${ts.dnsName}:${boundPort}`;
    serverConfig.allowedHosts = tailnetAllowedHosts(ts.dnsName, boundPort);
    log.info(`tailscale: ${ts.dnsName}; notification links use ${serverConfig.publicBase}`);
    log.info(`allowed hosts: ${allowedHostsLine()}`);
    return true;
  }
  if (configuredBase) {
    log.info(`publicBase ${configuredBase} (configured); allowed hosts: ${allowedHostsLine()}`);
  } else if (!(await applyTailscale())) {
    // The logon task can start the hub before tailscale is up: keep looking, quietly.
    log.info(`tailscale not available; allowed hosts: ${allowedHostsLine()} (retrying every ${retryMs / 1000} s)`);
    const retry = () => {
      tailscaleTimer = setTimeout(async () => { if (!(await applyTailscale()) && !stopping && !closed) retry(); }, retryMs);
      tailscaleTimer.unref?.();
    };
    retry();
  }

  return { port: boundPort, close, shutdown, server, registry, log };
}

/** GET /api/health on 127.0.0.1:port; true if a cw hub answers. */
async function isCwHub(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return body?.app === 'cw';
  } catch {
    return false;
  }
}

async function main() {
  let hub;
  try {
    hub = await startHub();
  } catch (e) {
    const dir = defaultDataDir();
    const log = createLogger(path.join(dir, 'hub.log'));
    if (e?.code === 'EADDRINUSE') {
      const port = e.port ?? envPort() ?? '?';
      if (await isCwHub(port)) {
        const msg = `cw hub already running on ${HOST}:${port}`;
        log.info(msg);
        console.log(msg);
        process.exit(0);
      }
      const msg = `port ${port} in use by another process (not a cw hub)`;
      log.error(msg);
      console.error(msg);
      process.exit(1);
    }
    log.error(`hub failed to start: ${e?.stack || e}`);
    console.error(`cw hub failed to start: ${e?.message || e}`);
    process.exit(1);
  }
  // Keep the hub (and every live session) up on stray errors; they are logged for diagnosis.
  process.on('uncaughtException', (e) => hub.log.error(`uncaught exception: ${e?.stack || e}`));
  process.on('unhandledRejection', (e) => hub.log.error(`unhandled rejection: ${e?.stack || e}`));
  console.log(`cw-hub listening ${HOST}:${hub.port}`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) main();
