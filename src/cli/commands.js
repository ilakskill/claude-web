// Session commands: default (start), ls, clear, attach, kill, resume, url, notify test.
// Local view: default, attach and resume attach to the session in this terminal (attach.js);
// `--web` or config `localView: "browser"` opens the browser instead.
import { createRequire } from 'node:module';
import { loadConfig, normalizeTailscaleAuth } from '../hub/config.js';
import { api, hubPort, hubUrl, remoteBase, token, findSession, probeHealth, CliError, HOST } from './client.js';
import { ensureHub } from './ensure-hub.js';
import { open } from './open.js';
import '../shared/recent-filter.js';
import '../shared/harnesses.js';

const { partitionRecent, truncate, endText, commandName, isClaude } = globalThis.cwRecentFilter;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 35;
const KILL_TIMEOUT_MS = 10_000; // the hub replies after the PTY exits: up to ~3 s per session

const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

const pad2 = (n) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD HH:MM`, or '-' for a missing/invalid time. */
export function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Aligns rows of strings into columns separated by two spaces. */
export function table(rows) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); });
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

const INDENT = '  ';
const MIN_TITLE = 10;

/** What the TITLE column shows: the custom or transcript title, else `(pwsh)` for a non-Claude command, else `-`. */
export function titleCell(s) {
  const t = globalThis.cwRecentFilter.displayTitle(s);
  if (t) return t;
  const H = globalThis.cwHarnesses;
  if (s.harness && s.harness !== 'claude') return `(${H.displayLabel(s)})`;
  return s.command && !isClaude(s.command) ? `(${commandName(s.command)})` : '-';
}

/**
 * table() plus a last TITLE column cut to fit `width` (0 or missing: never cut, e.g. when piped).
 * The other columns are never cut; the title keeps at least MIN_TITLE characters.
 */
function tableWithTitle(rows, titles, width) {
  const lines = table(rows).split('\n');
  const left = Math.max(...lines.map((l) => l.length));
  const room = width > 0 ? Math.max(MIN_TITLE, width - INDENT.length - left - 2) : Infinity;
  return lines.map((l, i) => {
    const t = i === 0 ? 'TITLE' : titles[i - 1];
    return `${INDENT}${l.padEnd(left)}  ${room === Infinity ? t : truncate(t, room)}`.trimEnd();
  }).join('\n');
}

/**
 * Renders the `cw ls` text for a GET /api/sessions body. Recent entries without a Claude
 * transcript (shells, test sessions) are hidden unless `all` (same rule as the list page).
 * @param {{running?:object[], recent?:object[]}} data
 * @param {{all?:boolean, width?:number}} [o] width: terminal columns (0 = do not cut titles)
 */
export function formatSessions({ running = [], recent = [] } = {}, { all = false, width = 0 } = {}) {
  const out = [];
  out.push(`running (${running.length})`);
  if (running.length) {
    out.push(tableWithTitle([
      ['#', 'ID', 'CWD', 'STARTED', 'CLIENTS', '!'],
      ...running.map((s) => [s.index, s.id, s.cwd, fmtTime(s.startedAt), s.clients ?? 0, s.needsInput ? '!' : '']),
    ], running.map(titleCell), width));
  }
  const { shown, hidden } = partitionRecent(recent, all);
  out.push(!all && hidden > 0
    ? `recent (${shown.length}; ${hidden} without a transcript hidden, show them: cw ls --all)`
    : `recent (${shown.length})`);
  if (shown.length) {
    out.push(tableWithTitle([
      ['#', 'ID', 'CWD', 'ENDED', 'RESULT'],
      ...shown.map((s) => [s.index, s.id, s.cwd, fmtTime(s.endedAt), endText(s)]),
    ], shown.map(titleCell), width));
  }
  return out.join('\n');
}

/** Session page URL that logs the browser in once (the hub swaps `t` for a cookie via 302). */
const browserUrl = (port, id, tok) => `${hubUrl(port)}/s/${id}?t=${tok}`;

export const EXIT_NOT_TTY = 3;
export const EXIT_NOT_FOUND = 4;
const NOT_TTY_MSG = 'cw: --no-web needs an interactive console (stdin and stdout must be a terminal); '
  + 'drop --no-web to open the session in the browser instead';
const FALLBACK_MSG = 'cw: stdin/stdout is not a terminal; opening the session in the browser instead (--web)';
const NO_BROWSER_MSG = 'cw: not a terminal and no browser could be opened; open the URL above yourself';

const defaultIsTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Where to show the session. `--web` → browser; `--no-web` → terminal (error without a TTY);
 * else config localView "browser" → browser; else the terminal when stdin and stdout are TTYs,
 * the browser (fallback) otherwise.
 * @returns {{web:boolean, fallback?:boolean} | {error:string}}
 */
function chooseView(parsed, isTty) {
  if (parsed.web === true) return { web: true };
  if (parsed.web === false) return isTty() ? { web: false } : { error: NOT_TTY_MSG };
  if (loadConfig().localView === 'browser') return { web: true };
  if (isTty()) return { web: false };
  return { web: true, fallback: true };
}

/** Opens the browser; resolves false when there is no opener or it failed. */
const tryOpen = async (url, openImpl) => (openImpl ? openImpl(url) : false);

/** Exit code after the browser flow: in the non-TTY fallback, no browser means exit 3. */
function browserExit(opened, view, io) {
  if (view.fallback && opened === false) {
    io.err(NO_BROWSER_MSG);
    return EXIT_NOT_TTY;
  }
  return 0;
}

/** The size a new session starts with: this console's size in terminal mode. */
function startSize(web) {
  if (web) return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  return { cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS };
}

/**
 * Prints the one-line header and attaches this console to the session. Resolves to the exit code.
 * The unref'd exit timer ends the process if anything (a stdin handle) still holds the event loop.
 */
async function attachHere(port, s, io, { attachImpl } = {}) {
  io.out(`cw: session #${s.index} ${s.id} · detach Ctrl+\\ · browser ${hubUrl(port)}/s/${s.id}`);
  const impl = attachImpl || (await import('./attach.js')).attach;
  const code = await impl({
    id: s.id, index: s.index, hubUrl: hubUrl(port), token: token(),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  });
  if (!attachImpl) setTimeout(() => process.exit(code), 300).unref();
  return code;
}

async function printSessionStarted({ port, created, cwd, note, io }) {
  const remote = await remoteBase(port);
  io.out(`cw: session #${created.index} ${created.id} in ${cwd}${note ? ` (${note})` : ''}`);
  io.out(`  local:   ${hubUrl(port)}/s/${created.id}`);
  if (remote) io.out(`  tailnet: ${remote}/s/${created.id}`);
}

/** Resolves the view, printing the error or the fallback note. Null means: stop with exit 3. */
function resolveView(parsed, io, isTty) {
  const view = chooseView(parsed, isTty);
  if (view.error) {
    io.err(view.error);
    return null;
  }
  if (view.fallback) io.err(FALLBACK_MSG);
  return view;
}

async function startSession(body, { io, note, parsed, opts }) {
  const { openImpl = open, isTty = defaultIsTty } = opts;
  const view = resolveView(parsed, io, isTty);
  if (!view) return EXIT_NOT_TTY;
  const { port, started } = await ensureHub();
  if (started) io.out(`cw: started hub on ${HOST}:${port}`);
  const created = await api('POST', '/api/sessions', { ...startSize(view.web), ...body }, { port });
  if (!view.web) return attachHere(port, created, io, opts);
  const [opened] = await Promise.all([
    tryOpen(browserUrl(port, created.id, token()), openImpl),
    printSessionStarted({ port, created, cwd: body.cwd, note, io }),
  ]);
  return browserExit(opened, view, io);
}

async function cmdDefault(parsed, io, opts) {
  const { command, args, harness } = parsed;
  const body = { cwd: process.cwd(), args };
  if (harness !== undefined) body.harness = harness;
  if (command !== undefined && harness === undefined) body.command = command;
  return startSession(body, { io, parsed, opts });
}

async function cmdLs(parsed, io, { width = process.stdout.isTTY ? process.stdout.columns : 0 } = {}) {
  const data = await api('GET', '/api/sessions');
  io.out(formatSessions(data, { all: parsed.all === true, width }));
  return 0;
}

/** `cw clear`: removes recent entries without a transcript; `--all`: every recent entry. */
async function cmdClear(parsed, io) {
  const all = parsed.all === true;
  const r = await api('DELETE', all ? '/api/recent' : '/api/recent?hidden=1');
  const n = r?.removed ?? 0;
  io.out(`cw: removed ${n} recent ${n === 1 ? 'entry' : 'entries'}${all ? '' : ' without a transcript'}`
    + ` (${r?.remaining ?? '?'} left; running sessions are not affected)`);
  return 0;
}

async function runningSession(target) {
  const { running } = await api('GET', '/api/sessions');
  const s = findSession(running, target);
  if (!s) throw new CliError(`no running session ${target} (see: cw ls)`);
  return s;
}

async function cmdAttach(parsed, io, opts) {
  const { openImpl = open, isTty = defaultIsTty } = opts;
  const view = resolveView(parsed, io, isTty);
  if (!view) return EXIT_NOT_TTY;
  if (view.web) {
    const s = await runningSession(parsed.target);
    const port = hubPort();
    io.out(`cw: opened session #${s.index} ${s.id} (${s.cwd})`);
    io.out(`  local:   ${hubUrl(port)}/s/${s.id}`);
    return browserExit(await tryOpen(browserUrl(port, s.id, token()), openImpl), view, io);
  }
  const { running } = await api('GET', '/api/sessions');
  const s = findSession(running, parsed.target);
  if (!s) {
    io.err(`cw: no running session ${parsed.target} (see: cw ls)`);
    return EXIT_NOT_FOUND;
  }
  return attachHere(hubPort(), s, io, opts);
}

async function cmdKill(target, io) {
  const s = await runningSession(target);
  await api('DELETE', `/api/sessions/${s.id}`, undefined, { timeoutMs: KILL_TIMEOUT_MS });
  io.out(`cw: killed session #${s.index} ${s.id} (${s.cwd})`);
  return 0;
}

async function cmdRename({ target, title }, io, { fetchImpl } = {}) {
  const { running, recent } = await api('GET', '/api/sessions', undefined, { fetchImpl });
  const s = findSession(running, target) || findSession(recent, target);
  if (!s) throw new CliError(`no session ${target} (see: cw ls)`);
  const r = await api('PATCH', `/api/sessions/${s.id}`, { title: title || null }, { fetchImpl });
  io.out(r?.userTitle
    ? `cw: renamed session #${s.index} ${s.id} to "${r.userTitle}"`
    : `cw: cleared the name of session #${s.index} ${s.id}`);
  return 0;
}

/**
 * The POST /api/sessions body (without size) that resumes a recent entry. Claude entries keep
 * `resume: claudeSessionId`; other harnesses resume by id or continue, per their preset.
 */
function resumeBody(s) {
  const H = globalThis.cwHarnesses;
  // A recorded Claude session id wins whatever the harness (a shell that ran claude inside).
  if (s.claudeSessionId) return { cwd: s.cwd, resume: s.claudeSessionId };
  const hid = s.harness || H.inferHarness(s.command)?.id || 'claude';
  if (hid === 'claude') {
    if (!s.claudeSessionId) {
      throw new CliError(`no Claude session id recorded for #${s.index}; start a new session in ${s.cwd} instead`);
    }
    return { cwd: s.cwd, resume: s.claudeSessionId };
  }
  const preset = H.getHarness(hid);
  if (preset?.resumeArgs && s.harnessSessionId) return { cwd: s.cwd, harness: hid, resume: s.harnessSessionId };
  if (preset?.continueArgs) return { cwd: s.cwd, harness: hid, continue: true };
  throw new CliError(`no way to resume a ${H.displayLabel(s) || hid} session; start a new one in ${s.cwd}`);
}

async function cmdResume(parsed, io, opts) {
  const { openImpl = open, isTty = defaultIsTty, fetchImpl, ensureHubImpl = ensureHub } = opts;
  const { target } = parsed;
  const view = resolveView(parsed, io, isTty);
  if (!view) return EXIT_NOT_TTY;
  const { port, started } = await ensureHubImpl();
  if (started) io.out(`cw: started hub on ${HOST}:${port}`);
  const { recent } = await api('GET', '/api/sessions', undefined, { port, fetchImpl });
  const s = findSession(recent, target);
  if (!s) throw new CliError(`no recent session ${target} (see: cw ls)`);
  const body = resumeBody(s);
  const created = await api('POST', '/api/sessions', { ...body, ...startSize(view.web) }, { port, fetchImpl });
  if (!view.web) return attachHere(port, created, io, opts);
  const [opened] = await Promise.all([
    tryOpen(browserUrl(port, created.id, token()), openImpl),
    printSessionStarted({ port, created, cwd: s.cwd, note: `resuming ${body.resume ?? 'latest session'}`, io }),
  ]);
  return browserExit(opened, view, io);
}

async function renderQr(text) {
  const require = createRequire(import.meta.url);
  const qrcode = require('qrcode-terminal');
  return new Promise((resolve) => qrcode.generate(text, { small: true }, resolve));
}

/**
 * Subscription URL for the ntfy app, e.g. https://ntfy.sh/<topic>; null without a topic.
 * `topic` defaults to the needs-input topic; pass cfg.ntfyTopicDone for the finished topic.
 */
export function ntfyTopicUrl(cfg, topic = cfg.ntfyTopic) {
  if (!topic) return null;
  return `${String(cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
}

async function cmdUrl(qr, io, { qrImpl = renderQr } = {}) {
  const port = hubPort();
  const tok = token();
  const [base, health] = await Promise.all([remoteBase(port), probeHealth(port)]);
  const local = `${hubUrl(port)}/?t=${tok}`;
  const remote = base ? `${base}/?t=${tok}` : null;
  const cfg = loadConfig();
  const ts = normalizeTailscaleAuth(cfg.tailscaleAuth);
  io.out(`local:   ${local}`);
  if (remote) io.out(`tailnet: ${remote}`);
  // Tailscale identity login: the plain tailnet URL works without a token for the allowed accounts.
  if (remote && ts.enabled) {
    io.out(`tailnet (no token): ${base}/`);
    io.out(`  phones on the tailnet signed in to Tailscale as ${ts.allow.join(', ')} need no token: open that URL and bookmark it`);
  }
  if (qr) {
    io.out(remote ? 'login (scan with the phone camera, then bookmark the page):' : 'login (local only; tailscale not available):');
    io.out(await qrImpl(remote || local));
  }
  // Two topics: "needs input" (ntfyTopic) and "finished" (ntfyTopicDone, default <ntfyTopic>-done).
  // Subscribing to both lets the ntfy app give each its own notification sound.
  // With ntfyTopicDone set equal to ntfyTopic (one topic for both), the line and QR appear once.
  const topicUrl = ntfyTopicUrl(cfg);
  const doneUrl = topicUrl ? ntfyTopicUrl(cfg, cfg.ntfyTopicDone) : null;
  const shared = doneUrl !== null && doneUrl === topicUrl;
  if (!topicUrl) {
    io.out('ntfy: no topic configured (set ntfyTopic in config.json)');
  } else if (shared) {
    io.out(`ntfy: subscribe to ${cfg.ntfyTopic} on ${cfg.ntfyServer} (${topicUrl}) (needs-input and finished share this topic)`);
  } else {
    io.out(`ntfy needs-input: subscribe to ${cfg.ntfyTopic} on ${cfg.ntfyServer} (${topicUrl})`);
    if (doneUrl) io.out(`ntfy finished:    subscribe to ${cfg.ntfyTopicDone} on ${cfg.ntfyServer} (${doneUrl})`);
  }
  if (qr && topicUrl) {
    io.out(shared ? 'ntfy topic (open in the ntfy app):' : 'ntfy needs-input topic (open in the ntfy app):');
    io.out(await qrImpl(topicUrl));
  }
  if (qr && doneUrl && !shared) {
    io.out('ntfy finished topic (open in the ntfy app):');
    io.out(await qrImpl(doneUrl));
  }
  if (health.state !== 'cw') io.err(`cw: note: the hub is not running on ${HOST}:${port} (start it with: cw hub start)`);
  return 0;
}

async function cmdNotifyTest(io) {
  // Up to two ntfy attempts of 3 s each happen inside the hub before it answers.
  await api('POST', '/api/notify/test', undefined, { timeoutMs: 10_000 });
  io.out('cw: test notification sent; it should appear in the ntfy app within a few seconds');
  return 0;
}

export async function run(parsed, io = defaultIo, opts = {}) {
  switch (parsed.cmd) {
    case 'default': return cmdDefault(parsed, io, opts);
    case 'ls': return cmdLs(parsed, io, opts);
    case 'clear': return cmdClear(parsed, io);
    case 'attach': return cmdAttach(parsed, io, opts);
    case 'kill': return cmdKill(parsed.target, io);
    case 'rename': return cmdRename(parsed, io, opts);
    case 'resume': return cmdResume(parsed, io, opts);
    case 'url': return cmdUrl(parsed.qr, io, opts);
    case 'notify': return cmdNotifyTest(io);
    default: throw new Error(`unhandled command ${parsed.cmd}`);
  }
}
