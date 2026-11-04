// Project discovery for the "new session" picker.
//   recentProjects(): Claude Code transcript dirs under <claudeHome>/projects/*/, newest first.
//   rootDirs():       direct subdirectories of configured project roots.
// No caching here; the server may cache results (plan: 10 s).
import fsp from 'node:fs/promises';
import path from 'node:path';

const HEAD_BYTES = 64 * 1024;
const WORKTREE_MARKER = '--claude-worktrees-';

async function readHead(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), full: bytesRead === HEAD_BYTES };
  } finally {
    await fh.close();
  }
}

/** Newest *.jsonl in dir → {cwd, claudeSessionId, mtimeMs} from its first line with a string cwd. */
async function scanProjectDir(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
    if (files.length === 0) return null;
    const stats = await Promise.all(files.map(async (f) => {
      try { return { f, mtimeMs: (await fsp.stat(f)).mtimeMs }; } catch { return null; }
    }));
    let newest = null;
    for (const s of stats) if (s && (newest === null || s.mtimeMs > newest.mtimeMs)) newest = s;
    if (!newest) return null;
    const { text, full } = await readHead(newest.f);
    const lines = text.split('\n');
    if (full) lines.pop(); // last line may be truncated
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj && typeof obj.cwd === 'string' && obj.cwd) {
        return {
          cwd: obj.cwd,
          claudeSessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
          mtimeMs: newest.mtimeMs,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

const dedupeKey = (cwd) => {
  const r = path.resolve(cwd);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * @returns {Promise<Array<{cwd:string, lastUsed:string, claudeSessionId:string|null}>>}
 *   newest first, deduped by cwd, only cwds that exist on disk, at most `limit`.
 */
export async function recentProjects({ claudeHome, includeWorktrees = false, limit = 20 } = {}) {
  const root = path.join(claudeHome, 'projects');
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory() && (includeWorktrees || !e.name.includes(WORKTREE_MARKER)));
  const found = (await Promise.all(dirs.map((e) => scanProjectDir(path.join(root, e.name))))).filter(Boolean);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set();
  const unique = [];
  for (const r of found) {
    const key = dedupeKey(r.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const out = [];
  for (const r of unique) {
    if (out.length >= limit) break;
    if (!(await isDir(r.cwd))) continue;
    out.push({ cwd: r.cwd, lastUsed: new Date(r.mtimeMs).toISOString(), claudeSessionId: r.claudeSessionId });
  }
  return out;
}

/**
 * @param {string[]} roots
 * @returns {Promise<Array<{root:string, dirs:string[]}>>} missing roots and dot-dirs skipped; names sorted.
 */
export async function rootDirs(roots) {
  const out = [];
  for (const root of roots || []) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(path.join(root, e.name))))) dirs.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    out.push({ root, dirs });
  }
  return out;
}
