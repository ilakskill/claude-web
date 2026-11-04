// Session titles from Claude Code transcripts: <claudeHome>/projects/<encoded cwd>/<claudeSessionId>.jsonl.
// Transcripts are append-only JSONL and can be many MB, so they are read in chunks of at most
// CHUNK_BYTES and parsed incrementally: a later call only reads the bytes appended since the last
// one (cache keyed by file, invalidated by mtime/size). Lines are prefiltered by substring, so only
// the few records that matter are JSON-parsed.
//
// Title, in order: the latest `custom-title` (/rename), the latest `ai-title` (current Claude Code
// versions), the latest `summary` (older versions), else the first typed user prompt. User records
// that are meta, sidechain, tool results, or whose text starts with `<` (commands, system and
// hook output) are skipped.
import fsp from 'node:fs/promises';
import path from 'node:path';
import '../shared/recent-filter.js';

const { cleanText: clean, TITLE_MAX: SHARED_TITLE_MAX } = globalThis.cwRecentFilter;

export const CHUNK_BYTES = 512 * 1024;
export const TITLE_MAX = SHARED_TITLE_MAX;
export const PROMPT_MAX = 200;
const MAX_LINE_BYTES = 8 * 1024 * 1024; // a longer line (a huge tool result) is skipped, never buffered
const MISS_TTL_MS = 60_000; // a transcript not found anywhere is not searched for again this soon
const MAX_CACHE = 500;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Claude Code's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

const empty = () => ({ title: null, firstPrompt: null, lastActivity: null, messageCount: 0, exists: false });

export function truncate(s, max) {
  if (typeof s !== 'string') return null;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The typed prompt of a user record, or null for meta/sidechain/tool-result/`<...>` records. */
export function promptText(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  }
  if (typeof text !== 'string') return null;
  text = clean(text);
  if (!text || text.startsWith('<')) return null;
  return text;
}

const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]{1,40})"/g;

function newState() {
  return { customTitle: null, aiTitle: null, summary: null, firstPrompt: null, lastTs: 0, count: 0 };
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function stringField(o, k) {
  return o && typeof o[k] === 'string' && clean(o[k]) ? clean(o[k]) : null;
}

function feedLine(st, line) {
  if (!line) return;
  if (line.includes('"type":"custom-title"')) {
    const o = parse(line);
    if (o?.type === 'custom-title') st.customTitle = stringField(o, 'customTitle') ?? st.customTitle;
    return;
  }
  if (line.includes('"type":"ai-title"')) {
    const o = parse(line);
    if (o?.type === 'ai-title') st.aiTitle = stringField(o, 'aiTitle') ?? st.aiTitle;
    return;
  }
  if (line.includes('"type":"summary"')) {
    const o = parse(line);
    if (o?.type === 'summary') { st.summary = stringField(o, 'summary') ?? st.summary; return; }
  }
  const isUser = line.includes('"type":"user"');
  const isAssistant = !isUser && line.includes('"type":"assistant"');
  if (!isUser && !isAssistant) return;
  st.count++;
  for (const m of line.matchAll(TS_RE)) {
    const t = Date.parse(m[1]);
    if (t > st.lastTs) st.lastTs = t;
  }
  if (isUser && st.firstPrompt === null) {
    const o = parse(line);
    const p = promptText(o);
    if (p) st.firstPrompt = p;
    else if (o && o.type !== 'user') st.count--; // the substring was inside another record type
  }
}

function result(st, mtimeMs) {
  const title = st.customTitle ?? st.aiTitle ?? st.summary ?? st.firstPrompt;
  const last = st.lastTs || mtimeMs || null;
  return {
    title: truncate(title, TITLE_MAX),
    firstPrompt: truncate(st.firstPrompt, PROMPT_MAX),
    lastActivity: last ? new Date(last).toISOString() : null,
    messageCount: st.count,
    exists: true,
  };
}

/**
 * Creates an independent reader (own caches). The module also exports a default instance's
 * sessionTitle for the hub.
 */
export function createTranscriptReader({ now = Date.now, chunkBytes = CHUNK_BYTES } = {}) {
  const files = new Map(); // file -> {mtimeMs, size, offset, carry:Buffer|null, skipping, st, value}
  const located = new Map(); // home\0id -> file
  const misses = new Map(); // home\0id -> time of the failed search
  const inflight = new Map(); // file -> Promise

  async function statFile(f) {
    try {
      const s = await fsp.stat(f);
      return s.isFile() ? s : null;
    } catch { return null; }
  }

  async function locate(home, cwd, id) {
    const key = `${home}\0${id}`;
    const known = located.get(key);
    if (known) {
      const s = await statFile(known);
      if (s) return { file: known, stat: s };
      located.delete(key);
    }
    const projects = path.join(home, 'projects');
    const name = `${id}.jsonl`;
    if (typeof cwd === 'string' && cwd) {
      const f = path.join(projects, encodeProjectDir(cwd), name);
      const s = await statFile(f);
      if (s) { remember(located, key, f); return { file: f, stat: s }; }
    }
    // Fallback: long or unusual paths may be encoded differently; look in every project dir.
    const missAt = misses.get(key);
    if (missAt !== undefined && now() - missAt < MISS_TTL_MS) return null;
    let dirs = [];
    try {
      dirs = (await fsp.readdir(projects, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* no projects dir */ }
    const hits = await Promise.all(dirs.map(async (d) => {
      const f = path.join(projects, d, name);
      const s = await statFile(f);
      return s ? { file: f, stat: s } : null;
    }));
    const hit = hits.find(Boolean);
    if (hit) { misses.delete(key); remember(located, key, hit.file); return hit; }
    remember(misses, key, now());
    return null;
  }

  function remember(map, k, v) {
    if (map.size >= MAX_CACHE) map.clear();
    map.set(k, v);
  }

  async function readFrom(file, stat) {
    let c = files.get(file);
    if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.value;
    if (!c || stat.size < c.offset) {
      c = { mtimeMs: 0, size: 0, offset: 0, carry: null, skipping: false, st: newState(), value: null };
    }
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(chunkBytes, Math.max(1, stat.size - c.offset)));
      while (c.offset < stat.size) {
        const want = Math.min(buf.length, stat.size - c.offset);
        const { bytesRead } = await fh.read(buf, 0, want, c.offset);
        if (bytesRead <= 0) break;
        c.offset += bytesRead;
        let chunk = buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(10, start);
          if (nl === -1) break;
          if (c.skipping) c.skipping = false;
          else {
            const piece = chunk.subarray(start, nl);
            const lineBuf = c.carry ? Buffer.concat([c.carry, piece]) : piece;
            feedLine(c.st, lineBuf.toString('utf8').trim());
          }
          c.carry = null;
          start = nl + 1;
        }
        if (start < chunk.length && !c.skipping) {
          const rest = Buffer.from(chunk.subarray(start));
          c.carry = c.carry ? Buffer.concat([c.carry, rest]) : rest;
          if (c.carry.length > MAX_LINE_BYTES) { c.carry = null; c.skipping = true; }
        }
        chunk = null;
      }
    } finally {
      await fh.close();
    }
    c.mtimeMs = stat.mtimeMs;
    c.size = stat.size;
    // A last line without its newline yet (still being written) is counted when it completes.
    c.value = result(c.st, stat.mtimeMs);
    if (!files.has(file) && files.size >= MAX_CACHE) files.clear();
    files.set(file, c);
    return c.value;
  }

  /**
   * @param {{claudeHome:string, cwd?:string, claudeSessionId?:string|null}} o
   * @returns {Promise<{title:string|null, firstPrompt:string|null, lastActivity:string|null,
   *   messageCount:number, exists:boolean}>} never rejects; exists=false when there is no transcript.
   */
  async function sessionTitle({ claudeHome, cwd, claudeSessionId } = {}) {
    try {
      if (!claudeHome || typeof claudeSessionId !== 'string' || !ID_RE.test(claudeSessionId)) return empty();
      const hit = await locate(claudeHome, cwd, claudeSessionId);
      if (!hit) return empty();
      // One read per file at a time (the incremental state is shared); stat inside the queue so a
      // queued read never sees a size older than what the previous read consumed.
      const { file } = hit;
      const prev = inflight.get(file) || Promise.resolve();
      const p = prev.catch(() => {}).then(async () => {
        const s = await statFile(file);
        return s ? readFrom(file, s) : null;
      });
      inflight.set(file, p);
      try {
        const v = await p;
        return v ? { ...v } : empty();
      } finally {
        if (inflight.get(file) === p) inflight.delete(file);
      }
    } catch {
      return empty();
    }
  }

  return { sessionTitle, clear: () => { files.clear(); located.clear(); misses.clear(); } };
}

const defaultReader = createTranscriptReader();
export const sessionTitle = defaultReader.sessionTitle;
