// Session registry: live sessions by id, per-hub-life indexes, and the persisted `recent` list
// (<dataDir>/sessions.json, newest first, max 50, written atomically on every change, together with
// a snapshot of the running sessions so a crashed hub's sessions reappear under recent).
// Every recent entry records how it ended (endReason): 'exit' (the process ended by itself;
// exitCode), 'killed' (kill() / stop()), 'hub-restart' (it was running when the previous hub
// stopped without a clean shutdown), 'spawn-failed' (the PTY could not be started).
import fs from 'node:fs';
import '../shared/harnesses.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './util.js';

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} [o.log]
 * @param {(opts:object)=>object|Promise<object>} o.createSession receives {...opts, id, index, onExit};
 *   must return a started session exposing id, index, state, kill(), toJSON().
 * @param {number} [o.retentionMs] how long an exited Session object stays retrievable (default 60 s)
 * @param {Function} [o.onChange] called after create, exit, and retention removal (for list broadcasts)
 */
export function createRegistry({
  dataDir, log, createSession, retentionMs = 60000, setTimeoutImpl, clearTimeoutImpl, maxRecent = 50, onChange,
} = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  if (typeof createSession !== 'function') throw new TypeError('createSession is required');
  const lg = log || noopLog;
  const file = path.join(dataDir, 'sessions.json');
  const st = setTimeoutImpl || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const ct = clearTimeoutImpl || ((h) => clearTimeout(h));

  const sessions = new Map(); // id -> Session (running, or exited within retention)
  const retention = new Map(); // id -> timer
  const earlyExits = new Map(); // id -> code, for sessions that exit before create() registers them
  const killed = new Set(); // ids ended through kill()/stop(), for endReason
  let nextIndex = 1;
  let loadedOrphans = false;
  let recent = load();
  // Write the converted orphans back at once, so the next hub neither warns again nor resets endedAt.
  if (loadedOrphans) persist();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') lg.warn(`cannot read ${file}: ${e.message}`);
      return [];
    }
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data?.recent;
      if (!Array.isArray(list)) throw new Error('no recent array');
      const valid = (r) => r && typeof r === 'object' && typeof r.id === 'string';
      // Sessions that were running when the previous hub died (crash, kill, power loss): they are
      // gone now, so they join recent as exited with an unknown code (Resume still works).
      const noticed = new Date().toISOString();
      const orphans = (Array.isArray(data?.running) ? data.running : []).filter(valid).map((r) => ({
        ...r,
        state: 'exited',
        exitCode: null,
        endedAt: noticed,
        clients: 0,
        needsInput: false,
        hubLost: true,
        endReason: 'hub-restart',
        // The real end is unknown: the last recorded activity is the best estimate.
        durationMs: orphanDuration(r),
      }));
      if (orphans.length) {
        lg.warn(`${orphans.length} session(s) were running when the previous hub stopped unexpectedly; listed under recent`);
        loadedOrphans = true;
      }
      const ids = new Set(orphans.map((r) => r.id));
      const older = list.filter((r) => valid(r) && !ids.has(r.id))
        .map((r) => (r.hubLost && !r.endReason ? { ...r, endReason: 'hub-restart' } : r));
      // Entries written before harness presets existed: infer the harness from the command.
      const infer = globalThis.cwHarnesses.inferHarness;
      return [...orphans, ...older].slice(0, maxRecent)
        .map((r) => (r.harness === undefined ? { ...r, harness: infer(r.command)?.id ?? null } : r));
    } catch (e) {
      lg.warn(`ignoring corrupt ${file}: ${e.message}`);
      return [];
    }
  }

  function orphanDuration(r) {
    const start = Date.parse(r.startedAt);
    const last = Date.parse(r.lastActivity);
    return Number.isNaN(start) || Number.isNaN(last) ? null : Math.max(0, last - start);
  }

  /**
   * Writes recent plus a snapshot of the running sessions (so a hub that dies without a clean
   * shutdown still leaves them behind for the next hub's recent list and Resume).
   */
  function persist() {
    try {
      const running = [...sessions.values()].filter((s) => s.state === 'running').map((s) => s.toJSON());
      writeJsonAtomic(file, { version: 1, recent, running });
    } catch (e) {
      lg.warn(`cannot write ${file}: ${e.message}`);
    }
  }

  function changed() {
    if (typeof onChange !== 'function') return;
    try { onChange(); } catch (e) { lg.warn(`registry onChange failed: ${e.message}`); }
  }

  // 8 hex chars, never all digits (so an id can't be mistaken for an index), unique vs live + recent.
  function newId() {
    for (;;) {
      const id = crypto.randomBytes(4).toString('hex');
      if (/^\d+$/.test(id) || sessions.has(id) || recent.some((r) => r.id === id)) continue;
      return id;
    }
  }

  function handleExit(id, code) {
    const s = sessions.get(id);
    if (!s) { earlyExits.set(id, code); return; }
    const meta = { ...s.toJSON(), endReason: killed.has(id) ? 'killed' : 'exit' };
    killed.delete(id);
    recent = [meta, ...recent.filter((r) => r.id !== id)].slice(0, maxRecent);
    persist();
    retention.set(id, st(() => {
      retention.delete(id);
      sessions.delete(id);
      changed();
    }, retentionMs));
    changed();
  }

  function recordSpawnFailure(id, index, opts, e) {
    const now = new Date().toISOString();
    const meta = {
      id,
      index,
      cwd: opts.cwd,
      command: opts.command,
      args: Array.isArray(opts.args) ? [...opts.args] : [],
      startedAt: now,
      endedAt: now,
      state: 'exited',
      exitCode: null,
      clients: 0,
      needsInput: false,
      claudeSessionId: null,
      harness: opts.harness ?? null,
      model: opts.model ?? null,
      harnessSessionId: null,
      termTitle: null,
      title: null,
      firstPrompt: null,
      hasTranscript: false,
      userTitle: null,
      lastActivity: null,
      durationMs: 0,
      endReason: 'spawn-failed',
      error: String(e?.message || e).slice(0, 300),
    };
    recent = [meta, ...recent].slice(0, maxRecent);
    persist();
    changed();
  }

  const isIndexKey = (k) => (typeof k === 'number' ? Number.isInteger(k) : typeof k === 'string' && /^\d+$/.test(k));

  /**
   * Looks up a live Session of the current hub life by id (string) or index (number or numeric
   * string). "Live" = running, or exited but still within retention. Always a Session or null —
   * never recent metadata (use findRecent for that).
   */
  function get(key) {
    if (key === undefined || key === null || key === '') return null;
    if (typeof key === 'string' && sessions.has(key)) return sessions.get(key);
    if (isIndexKey(key)) {
      const n = Number(key);
      for (const s of sessions.values()) if (s.index === n) return s;
    }
    return null;
  }

  /**
   * Looks up exited-session metadata in recent (persisted across hub lives) by id, or by index
   * (newest match first; indexes from earlier hub lives can repeat). Returns a copy, or null.
   */
  function findRecent(key) {
    if (key === undefined || key === null || key === '') return null;
    let r = typeof key === 'string' ? recent.find((x) => x.id === key) : undefined;
    if (!r && isIndexKey(key)) r = recent.find((x) => x.index === Number(key));
    return r ? { ...r, args: Array.isArray(r.args) ? [...r.args] : r.args } : null;
  }

  return {
    /** All live Session objects (running, and exited ones still within retention). */
    list: () => [...sessions.values()],
    /** Session objects with state === 'running'. */
    running: () => [...sessions.values()].filter((s) => s.state === 'running'),
    /** Exited session metadata (toJSON() snapshots), newest first, max 50. */
    recent: () => recent.map((r) => ({ ...r })),
    get,
    findRecent,

    /** Assigns id + index, calls createSession, registers and returns the session. */
    async create(opts = {}) {
      const id = newId();
      const index = nextIndex++;
      const callerOnExit = opts.onExit;
      const onExit = (code) => {
        handleExit(id, code);
        if (typeof callerOnExit === 'function') callerOnExit(code);
      };
      let session;
      try {
        session = await createSession({ ...opts, id, index, onExit });
      } catch (e) {
        // A PTY that could not be started (createSession marks it err.spawnFailed) is listed under
        // recent; a refusal before spawning (e.g. command not found) is not.
        if (e && e.spawnFailed) recordSpawnFailure(id, index, opts, e);
        throw e;
      }
      if (!session) throw new Error('createSession returned nothing');
      sessions.set(id, session);
      if (!earlyExits.has(id)) persist(); // running snapshot (an early exit persists below)
      changed();
      if (earlyExits.has(id)) {
        const code = earlyExits.get(id);
        earlyExits.delete(id);
        handleExit(id, code);
      }
      return session;
    },

    /**
     * Kills a running session by id or index. Resolves true once it has exited; false if not found
     * or already exited (an exited session still within retention is not killed again).
     */
    async kill(key) {
      const s = get(key);
      if (!s || s.state !== 'running') return false;
      killed.add(s.id);
      await s.kill();
      return true;
    },

    /**
     * Stops all sessions. Rejects with err.code === 'RUNNING' if any are running and !force;
     * otherwise kills every running session and resolves once all have exited.
     */
    async stop({ force = false } = {}) {
      const live = [...sessions.values()].filter((s) => s.state === 'running');
      if (live.length > 0 && !force) {
        throw Object.assign(new Error(`${live.length} session(s) still running`), { code: 'RUNNING', count: live.length });
      }
      for (const s of live) killed.add(s.id);
      await Promise.allSettled(live.map((s) => s.kill()));
    },

    /**
     * Merges fields into a recent entry (title refreshes). Resolves true if anything changed.
     * Writes sessions.json only when `save` is true (the default) and something changed.
     */
    updateRecent(id, patch, { save = true } = {}) {
      const i = recent.findIndex((r) => r.id === id);
      if (i === -1 || !patch || typeof patch !== 'object') return false;
      const cur = recent[i];
      const diff = Object.entries(patch).some(([k, v]) => cur[k] !== v);
      if (!diff) return false;
      recent[i] = { ...cur, ...patch };
      if (save) persist();
      return true;
    },

    /** Removes one recent entry by id. @returns {boolean} false if there was none */
    removeRecent(id) {
      const before = recent.length;
      recent = recent.filter((r) => r.id !== id);
      if (recent.length === before) return false;
      persist();
      changed();
      return true;
    },

    /**
     * Removes recent entries (all, or those matching `pred`); running sessions are untouched.
     * @returns {number} how many were removed
     */
    clearRecent(pred) {
      const keep = typeof pred === 'function' ? recent.filter((r) => !pred({ ...r })) : [];
      const n = recent.length - keep.length;
      if (n === 0) return 0;
      recent = keep;
      persist();
      changed();
      return n;
    },

    /** Re-writes sessions.json (call after changing a running session's metadata, e.g. claudeSessionId). */
    save: persist,

    /** Clears retention timers (for shutdown / tests). */
    dispose() {
      for (const t of retention.values()) ct(t);
      retention.clear();
    },
  };
}
