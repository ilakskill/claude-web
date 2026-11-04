// Codex CLI rollout files, read for the Focus view (codex-focus.js). Codex writes one append-only
// JSONL file per thread: <codexHome>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl.
// The first line is `session_meta` (thread id, cwd, originator, source); after that, Codex 0.163
// records every finished TUI cell as `event_msg` `item_completed` (UserMessage, AgentMessage,
// CommandExecution, FileChange, McpToolCall, Extension, SubAgentActivity, Plan, ContextCompaction,
// Reasoning) plus turn markers (`task_started`, `task_complete`, `turn_aborted`). The same content
// is repeated as `response_item` records (the model's view), which are ignored here, so nothing is
// counted twice. Running commands are not recorded until they finish.
//
// Files are read in chunks and incrementally, like transcripts.js: a later read only parses what
// was appended. Only lines that look like `event_msg` (or the first `session_meta`) are parsed.
// Nothing outside <codexHome>/sessions is ever opened: candidate files come from readdir there, and
// a thread id is only compared against file names, never joined into a path.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const CHUNK_BYTES = 512 * 1024;
export const DETAIL_MAX = 1500; // command output / diff / tool result kept per event
export const TEXT_MAX = 20000; // a user or agent message
export const TITLE_MAX = 160;
export const EVENTS_MAX = 1500; // newest events kept per file
const MAX_LINE_BYTES = 8 * 1024 * 1024; // a longer line is skipped, never buffered
const META_MAX_BYTES = 1024 * 1024; // session_meta carries the base instructions (tens of KB)
const MAX_CACHE = 500;
const SKEW_MS = 5000; // clock slack between the hub's session start and Codex's own timestamps
const SCAN_DAYS = 14; // newest day folders scanned for threads written during a session
const LAST_DAYS = 30; // ... and for `resume --last` before Codex writes to the resumed thread
const ID_SEARCH_TTL_MS = 30_000;

/** A Codex thread id (UUID v7 in practice); also the shape `resume <id>` accepts here. */
export const THREAD_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
export const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9A-Za-z-]{8,64})\.jsonl$/;

// The prompts of Codex's approval overlay (strings from the 0.163 binary). Matched against the
// screen rows joined with spaces, so a prompt Codex wrapped on a narrow terminal still matches.
const APPROVAL_RES = [
  /Would\s+you\s+like\s+to\s+(?:run\s+the\s+following\s+command|make\s+the\s+following\s+edits|grant\s+these\s+permissions|send\s+input\s+to\s+the\s+existing\s+terminal)\?/,
  /No,\s+and\s+tell\s+Codex\s+what\s+to\s+do\s+differently(?:\s+\(esc\))?/,
  /Yes,\s+and\s+don't\s+ask\s+again/,
  /\S+\s+needs\s+your\s+approval\./,
];

const cwdKey = (p) => {
  try {
    const r = path.resolve(String(p));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch { return null; }
};
const oneLine = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
const str = (v) => (typeof v === 'string' ? v : '');

/** Keeps the head and the tail of a long text (errors are usually at the end of command output). */
export function clip(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${t.slice(0, head)}\n… (${t.length - head - tail} characters omitted) …\n${t.slice(t.length - tail)}`;
}

function title(s) {
  const t = oneLine(s);
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1)}…`;
}

/** The text of a message's content parts; images become `[image]`. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.text === 'string') parts.push(c.text);
    else if (/image/i.test(str(c.type))) parts.push('[image]');
  }
  return parts.join('\n');
}

/** What a CommandExecution ran: the parsed command, else the shell script argument, else the argv. */
export function commandText(it) {
  const parsed = Array.isArray(it?.parsed_cmd) ? it.parsed_cmd : [];
  if (parsed.length === 1 && typeof parsed[0]?.cmd === 'string' && parsed[0].cmd) return parsed[0].cmd;
  const cmd = it?.command;
  if (Array.isArray(cmd)) {
    const i = cmd.findIndex((a) => typeof a === 'string' && /^-(?:command|c|lc)$/i.test(a));
    if (i >= 0 && typeof cmd[i + 1] === 'string') return cmd[i + 1];
    const s = cmd.filter((a) => typeof a === 'string').join(' ');
    if (s) return s;
  }
  if (typeof cmd === 'string' && cmd) return cmd;
  return 'command';
}

/** A path as the user thinks of it: relative to the thread's cwd when inside it. */
function relPath(p, cwd) {
  const s = String(p);
  if (typeof cwd === 'string' && cwd) {
    const base = cwd.replace(/[\\/]+$/, '');
    const low = process.platform === 'win32' || /^[A-Za-z]:/.test(base);
    const a = low ? s.toLowerCase() : s;
    const b = low ? base.toLowerCase() : base;
    if (a.startsWith(b) && (a[b.length] === '\\' || a[b.length] === '/')) return s.slice(b.length + 1);
  }
  return s;
}

function withDetail(e, detail) {
  const d = String(detail ?? '').replace(/\s+$/, '');
  if (d) e.detail = clip(d, DETAIL_MAX);
  return e;
}

/**
 * One rollout record as a Focus event, or null for anything not shown. Events carry `at` (the
 * record's timestamp) and, for items, the Codex item `id` (the reader dedupes on it, then drops it).
 *   {kind:'user'|'agent', text, phase?}  phase: 'commentary' | 'final_answer' | 'plan'
 *   {kind:'tool', tool:'command'|'edit'|'mcp'|'web'|'agent'|'other', ok, title, detail?, exitCode?, files?, agent?}
 *   {kind:'turn', state:'started'|'complete'|'aborted', reason?}
 *   {kind:'note', text}  {kind:'error', text}
 * @param {object} o a parsed JSONL record
 * @param {{cwd?:string}} [ctx] the thread's cwd, for relative file paths
 */
export function normalizeRecord(o, { cwd } = {}) {
  if (!o || typeof o !== 'object' || o.type !== 'event_msg') return null;
  const p = o.payload;
  if (!p || typeof p !== 'object') return null;
  const at = typeof o.timestamp === 'string' ? o.timestamp : null;
  switch (p.type) {
    case 'task_started': return { at, kind: 'turn', state: 'started' };
    case 'task_complete': return { at, kind: 'turn', state: 'complete' };
    case 'turn_aborted': return { at, kind: 'turn', state: 'aborted', ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) };
    case 'error': return typeof p.message === 'string' && p.message ? { at, kind: 'error', text: clip(p.message, DETAIL_MAX) } : null;
    case 'item_completed': break;
    default: return null;
  }
  const it = p.item;
  if (!it || typeof it !== 'object') return null;
  const base = { ...(typeof it.id === 'string' ? { id: it.id } : {}), at };
  switch (it.type) {
    case 'UserMessage':
    case 'AgentMessage':
    case 'Plan': {
      const text = (it.type === 'Plan' ? str(it.text) : contentText(it.content)).trim();
      if (!text) return null;
      const e = { ...base, kind: it.type === 'UserMessage' ? 'user' : 'agent', text: clip(text, TEXT_MAX) };
      if (it.type === 'Plan') e.phase = 'plan';
      else if (it.type === 'AgentMessage') e.phase = typeof it.phase === 'string' ? it.phase : null;
      return e;
    }
    case 'CommandExecution': {
      const exit = Number.isInteger(it.exit_code) ? it.exit_code : null;
      const ok = it.status !== 'failed' && it.status !== 'declined' && (exit === null || exit === 0);
      const e = { ...base, kind: 'tool', tool: 'command', ok, title: title(commandText(it)) };
      withDetail(e, it.aggregated_output);
      if (exit !== null) e.exitCode = exit;
      return e;
    }
    case 'FileChange': {
      const changes = it.changes && typeof it.changes === 'object' ? it.changes : {};
      const files = Object.keys(changes).map((f) => relPath(f, cwd));
      const diffs = Object.entries(changes).map(([f, c]) => `--- ${relPath(f, cwd)} (${str(c?.type) || 'change'})\n${str(c?.unified_diff)}`);
      const ok = it.status !== 'failed' && it.status !== 'declined';
      return withDetail({ ...base, kind: 'tool', tool: 'edit', ok, title: title(files.join(', ') || 'files'), files }, diffs.join('\n') || it.stderr);
    }
    case 'McpToolCall': {
      const label = `${str(it.server) || 'mcp'}: ${str(it.tool) || 'tool'}`;
      const argTitle = typeof it.arguments?.title === 'string' ? it.arguments.title : '';
      const ok = it.status !== 'failed' && it.result?.isError !== true;
      const res = Array.isArray(it.result?.content) ? contentText(it.result.content) : str(it.result?.error) || str(it.error);
      return withDetail({ ...base, kind: 'tool', tool: 'mcp', ok, title: title(argTitle ? `${label} - ${argTitle}` : label) }, res);
    }
    case 'Extension': {
      const a = it.action && typeof it.action === 'object' ? it.action : {};
      const web = /search/.test(str(it.kind));
      const t = a.type === 'openPage' && a.url ? `Opened ${a.url}`
        : web ? `Searched "${str(a.query) || str(it.query)}"`
          : `${str(it.kind) || 'extension'} ${str(it.query)}`;
      return { ...base, kind: 'tool', tool: web ? 'web' : 'other', ok: true, title: title(t) };
    }
    case 'SubAgentActivity': {
      const agent = str(it.agent_path) || str(it.agent_thread_id) || 'subagent';
      return { ...base, kind: 'tool', tool: 'agent', ok: true, title: title(`${agent} ${str(it.kind)}`), agent };
    }
    case 'ContextCompaction': return { ...base, kind: 'note', text: 'Context compacted' };
    default: return null;
  }
}

/** The fields of a session_meta payload the hub uses, or null without a cwd. */
export function pickMeta(p) {
  if (!p || typeof p !== 'object' || typeof p.cwd !== 'string' || !p.cwd) return null;
  const ts = Date.parse(p.timestamp);
  return {
    id: typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : null,
    cwd: p.cwd,
    timestamp: Number.isNaN(ts) ? null : ts,
    originator: typeof p.originator === 'string' ? p.originator : null,
    source: typeof p.source === 'string' ? p.source : p.source && typeof p.source === 'object' ? 'subagent' : null,
    parent: typeof p.parent_thread_id === 'string' ? p.parent_thread_id : null,
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
  };
}

/**
 * A thread the user drives from the Codex CLI: the TUI (originator codex-tui; source is `cli`, or
 * `vscode` inside a VS Code terminal), or an older file with source `cli` and no originator. Never a
 * subagent (guardian reviews, spawned agents), the Codex desktop app, or `codex exec`.
 */
export function isInteractiveMeta(m) {
  if (!m || m.parent || m.source === 'subagent') return false;
  if (m.originator) return m.originator === 'codex-tui';
  return m.source === 'cli';
}

/** The thread id after `resume` in a session's argv (`codex resume <id>`), else null. */
export function resumeIdFromArgs(args) {
  if (!Array.isArray(args)) return null;
  const i = args.indexOf('resume');
  const id = i >= 0 ? args[i + 1] : null;
  return typeof id === 'string' && !id.startsWith('-') && THREAD_ID_RE.test(id) ? id : null;
}

/** `codex resume --last` (the Continue button). */
export function continuesLast(args) {
  if (!Array.isArray(args)) return false;
  const i = args.indexOf('resume');
  return i >= 0 && args[i + 1] === '--last';
}

/** The approval prompt line on a Codex screen (the bottom rows of the terminal), else null. */
export function detectApproval(lines) {
  if (!Array.isArray(lines)) return null;
  const text = lines.map((l) => (typeof l === 'string' ? l.trim() : '')).filter(Boolean).join(' ');
  for (const re of APPROVAL_RES) {
    const m = re.exec(text);
    if (m) return title(m[0]);
  }
  return null;
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * An incremental reader with its own caches.
 * read(file) -> {meta, events, firstSeq, nextSeq, turn, lastAgent} | null (missing file). `events`
 * is the reader's own array (do not mutate); seq numbers start at 1 and only grow while the file
 * grows. turn: 'running' after task_started, 'idle' after task_complete/turn_aborted, null before
 * any turn. lastAgent: the text of the last final answer or plan, cleared by a user message.
 */
export function createRolloutReader({ chunkBytes = CHUNK_BYTES, eventsMax = EVENTS_MAX } = {}) {
  const files = new Map();
  const metas = new Map(); // file -> meta (the first line never changes)
  const inflight = new Map();

  const fresh = () => ({
    mtimeMs: 0, size: 0, offset: 0, carry: null, skipping: false, meta: null, metaSeen: false,
    events: [], nextSeq: 1, seen: new Set(), turn: null, lastAgent: null,
  });

  function feedLine(st, line) {
    if (!line) return;
    if (!st.metaSeen && line.includes('"session_meta"')) {
      const o = parse(line);
      if (o?.type === 'session_meta') { st.metaSeen = true; st.meta = pickMeta(o.payload); return; }
    }
    if (!line.includes('"event_msg"') || line.includes('"type":"token_count"')) return;
    const e = normalizeRecord(parse(line), { cwd: st.meta?.cwd });
    if (!e) return;
    if (e.id !== undefined) {
      if (st.seen.has(e.id)) return;
      st.seen.add(e.id);
      delete e.id;
    }
    if (e.kind === 'turn') st.turn = e.state === 'started' ? 'running' : 'idle';
    else if (e.kind === 'user') st.lastAgent = null;
    else if (e.kind === 'agent' && (e.phase === 'final_answer' || e.phase === 'plan')) st.lastAgent = e.text;
    e.seq = st.nextSeq++;
    st.events.push(e);
    if (st.events.length > eventsMax) st.events.splice(0, st.events.length - eventsMax);
  }

  async function readFrom(file, stat) {
    let c = files.get(file);
    if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c;
    if (!c || stat.size < c.offset) c = fresh();
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(chunkBytes, Math.max(1, stat.size - c.offset)));
      while (c.offset < stat.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, stat.size - c.offset), c.offset);
        if (bytesRead <= 0) break;
        c.offset += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(10, start);
          if (nl === -1) break;
          if (c.skipping) c.skipping = false;
          else {
            const piece = chunk.subarray(start, nl);
            feedLine(c, (c.carry ? Buffer.concat([c.carry, piece]) : piece).toString('utf8').trim());
          }
          c.carry = null;
          start = nl + 1;
        }
        if (start < chunk.length && !c.skipping) {
          const rest = Buffer.from(chunk.subarray(start));
          c.carry = c.carry ? Buffer.concat([c.carry, rest]) : rest;
          if (c.carry.length > MAX_LINE_BYTES) { c.carry = null; c.skipping = true; }
        }
      }
    } finally {
      await fh.close();
    }
    c.mtimeMs = stat.mtimeMs;
    c.size = stat.size;
    if (!files.has(file) && files.size >= MAX_CACHE) files.clear();
    files.set(file, c);
    return c;
  }

  const view = (c) => ({
    meta: c.meta, events: c.events, firstSeq: c.events.length ? c.events[0].seq : c.nextSeq,
    nextSeq: c.nextSeq, turn: c.turn, lastAgent: c.lastAgent,
  });

  /** One read per file at a time; stat inside the queue so a read never sees an older size. */
  async function read(file) {
    const prev = inflight.get(file) || Promise.resolve();
    const p = prev.catch(() => {}).then(async () => {
      let st;
      try { st = await fsp.stat(file); } catch { return null; }
      if (!st.isFile()) return null;
      return view(await readFrom(file, st));
    });
    inflight.set(file, p);
    try { return await p; } finally { if (inflight.get(file) === p) inflight.delete(file); }
  }

  /** The session_meta of a file (its first line only); null if missing or not a rollout. */
  async function readMeta(file) {
    if (metas.has(file)) return metas.get(file);
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch { return null; }
    let meta = null;
    try {
      const chunks = [];
      let total = 0;
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, total);
        if (bytesRead <= 0) break;
        const piece = buf.subarray(0, bytesRead);
        const nl = piece.indexOf(10);
        chunks.push(Buffer.from(nl === -1 ? piece : piece.subarray(0, nl)));
        total += bytesRead;
        if (nl !== -1 || total >= META_MAX_BYTES) break;
      }
      const o = parse(Buffer.concat(chunks).toString('utf8').trim());
      meta = o?.type === 'session_meta' ? pickMeta(o.payload) : null;
    } catch { meta = null; } finally {
      await fh.close().catch(() => {});
    }
    // A file still being created has no complete first line yet: only remember real answers.
    if (meta) {
      if (metas.size >= MAX_CACHE * 4) metas.clear();
      metas.set(file, meta);
    }
    return meta;
  }

  return { read, readMeta, forget: (file) => { files.delete(file); metas.delete(file); } };
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Finds the rollout a cw session's Codex is writing. See locate().
 * @param {{codexHome:string, reader?:object, now?:Function}} o
 */
export function createRolloutLocator({ codexHome, reader = createRolloutReader(), now = Date.now } = {}) {
  const sessionsDir = path.join(String(codexHome || ''), 'sessions');
  const byId = new Map(); // id -> {file|null, at}

  async function statFile(f) {
    try { const s = await fsp.stat(f); return s.isFile() ? s : null; } catch { return null; }
  }

  async function dirNames(d, re) {
    try {
      return (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name);
    } catch { return []; }
  }

  /**
   * Rollout files in the newest `days` local-date folders, from tomorrow back (Codex names folders
   * by the thread's local start date; tomorrow covers clock slack). Steps by calendar date, so a
   * daylight-saving change never skips a folder.
   */
  async function recentFiles(days) {
    const out = [];
    const d = new Date(now());
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    for (let i = 0; i <= days; i++, d.setDate(d.getDate() - 1)) {
      const dir = path.join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      let names = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const n of names) if (ROLLOUT_NAME_RE.test(n)) out.push(path.join(dir, n));
    }
    return out;
  }

  /** The file of a thread id, searched newest folder first (cached; misses for 30 s). */
  async function findById(id) {
    if (typeof id !== 'string' || !THREAD_ID_RE.test(id)) return null;
    const hit = byId.get(id);
    if (hit?.file && await statFile(hit.file)) return hit.file;
    if (hit && !hit.file && now() - hit.at < ID_SEARCH_TTL_MS) return null;
    const suffix = `-${id}.jsonl`;
    let found = null;
    outer:
    for (const y of (await dirNames(sessionsDir, /^\d{4}$/)).sort().reverse()) {
      for (const m of (await dirNames(path.join(sessionsDir, y), /^\d\d$/)).sort().reverse()) {
        for (const d of (await dirNames(path.join(sessionsDir, y, m), /^\d\d$/)).sort().reverse()) {
          const dir = path.join(sessionsDir, y, m, d);
          let names = [];
          try { names = await fsp.readdir(dir); } catch { continue; }
          const n = names.find((x) => x.endsWith(suffix) && ROLLOUT_NAME_RE.test(x));
          if (n) { found = path.join(dir, n); break outer; }
        }
      }
    }
    if (byId.size >= MAX_CACHE) byId.clear();
    byId.set(id, { file: found, at: now() });
    return found;
  }

  async function describe(file) {
    const st = await statFile(file);
    if (!st) return null;
    const meta = await reader.readMeta(file);
    return meta ? { file, meta, mtimeMs: st.mtimeMs } : null;
  }

  const newest = (list) => list.reduce((a, b) => (!a || b.mtimeMs > a.mtimeMs
    || (b.mtimeMs === a.mtimeMs && (b.meta.timestamp ?? 0) > (a.meta.timestamp ?? 0)) ? b : a), null);

  /**
   * The rollout of a session, or null. Candidates are interactive Codex CLI threads (see
   * isInteractiveMeta), never a file in `exclude` (claimed by another session):
   *  1. files of the known thread ids (`ids`: the Codex hook's session id, `resume <id>`), wherever
   *     they are, even if not written since the session started;
   *  2. threads in the same folder written since the session started (new threads, `/new`,
   *     resumed ones); the most recently written wins.
   * A known id wins unless a thread born during this session, after it, was written more recently
   * (the user started a new thread). With `continueLast` (`codex resume --last`) and no candidate
   * yet, the folder's most recently written thread of the last 30 days is shown.
   * @param {{cwd:string, startedAtMs:number, ids?:string[], exclude?:Set<string>, continueLast?:boolean}} o
   */
  async function locate({ cwd, startedAtMs, ids = [], exclude = new Set(), continueLast = false }) {
    const key = cwdKey(cwd);
    if (!key) return null;
    const start = Number.isFinite(startedAtMs) ? startedAtMs : now();
    const sameDir = (c) => cwdKey(c.meta.cwd) === key;

    const idCands = [];
    for (const id of ids) {
      const f = await findById(id);
      if (!f || exclude.has(f)) continue;
      const c = await describe(f);
      if (c && isInteractiveMeta(c.meta)) idCands.push(c);
    }

    const files = await recentFiles(continueLast ? LAST_DAYS : SCAN_DAYS);
    const during = [];
    const before = [];
    for (const f of files) {
      if (exclude.has(f)) continue;
      const st = await statFile(f);
      if (!st) continue;
      const writtenDuring = st.mtimeMs >= start - SKEW_MS;
      if (!writtenDuring && !continueLast) continue; // never touched while this session ran
      const meta = await reader.readMeta(f);
      if (!meta || !isInteractiveMeta(meta)) continue;
      const c = { file: f, meta, mtimeMs: st.mtimeMs };
      if (!sameDir(c)) continue;
      (writtenDuring ? during : before).push(c);
    }

    if (idCands.length) {
      const best = newest(idCands);
      const challenger = newest(during.filter((c) => c.file !== best.file
        && (c.meta.timestamp ?? 0) >= start - SKEW_MS
        && (c.meta.timestamp ?? 0) > (best.meta.timestamp ?? 0)
        && c.mtimeMs > best.mtimeMs));
      return challenger || best;
    }
    return newest(during) || (continueLast ? newest(before) : null);
  }

  return { locate, findById };
}
