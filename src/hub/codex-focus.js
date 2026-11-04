// The Focus view's feed for a Codex session (GET /api/sessions/<id>/focus, web/focus.js): the
// conversation from the thread's rollout file (codex-rollout.js) as compact events, read
// incrementally, plus whether Codex is waiting for the user.
//
// Which file: the locator re-checks at most every relocateMs per session, so a new thread (/new) or
// a resumed one is followed within a few seconds. Files already shown by another running session's
// feed, and the files of other sessions' known thread ids, are never picked for this one.
import path from 'node:path';
import {
  createRolloutReader, createRolloutLocator, resumeIdFromArgs, continuesLast, detectApproval, ROLLOUT_NAME_RE,
} from './codex-rollout.js';
import '../shared/harnesses.js';

export const RELOCATE_MS = 3000;
export const FEED_LIMIT = 250; // events in a first (or reset) answer; later answers carry only new ones
const SCREEN_ROWS = 24; // bottom rows of the terminal checked for an approval prompt

/** True for a session started with the Codex preset (or a custom `codex` command). */
export function isCodexSession(s) {
  if (!s) return false;
  const H = globalThis.cwHarnesses;
  const h = H.getHarness(s.harness) || H.inferHarness(s.command);
  return !!h && h.id === 'codex';
}

/**
 * What the user should know about Codex waiting on them, or null.
 *   {kind:'approval', text}   an approval prompt is on the terminal (answer it there)
 *   {kind:'needs-input'}      the hub's own needs-input flag (hooks, bell)
 *   {kind:'your-turn', question}  the turn ended with an answer (question: it ends with "?")
 */
export function computeWaiting({ running = true, approval = null, needsInput = false, turn = null, lastAgent = null } = {}) {
  if (!running) return null;
  if (approval) return { kind: 'approval', text: approval };
  if (needsInput) return { kind: 'needs-input' };
  if (turn === 'idle' && typeof lastAgent === 'string' && lastAgent) return { kind: 'your-turn', question: /\?\s*$/.test(lastAgent) };
  return null;
}

/**
 * @param {object} o
 * @param {string} o.codexHome
 * @param {object} [o.reader] createRolloutReader()
 * @param {object} [o.locator] createRolloutLocator()
 * @param {number} [o.relocateMs]
 * @param {Function} [o.now]
 */
export function createCodexFocus({ codexHome, reader, locator, relocateMs = RELOCATE_MS, now = Date.now, limit = FEED_LIMIT } = {}) {
  const rd = reader || createRolloutReader();
  const loc = locator || createRolloutLocator({ codexHome, reader: rd, now });
  const state = new Map(); // session id -> {file, at}

  async function resolve(session, others) {
    let st = state.get(session.id);
    if (!st) { st = { file: null, at: 0 }; state.set(session.id, st); }
    if (st.file && now() - st.at < relocateMs) return st.file;
    const exclude = new Set();
    const ids = [session.harnessSessionId, resumeIdFromArgs(session.args)].filter((x) => typeof x === 'string' && x);
    for (const o of others) {
      if (!o || o.id === session.id) continue;
      const f = state.get(o.id)?.file;
      if (f) exclude.add(f);
      const oid = typeof o.harnessSessionId === 'string' ? o.harnessSessionId : resumeIdFromArgs(o.args);
      if (oid && !ids.includes(oid)) {
        const of = await loc.findById(oid);
        if (of) exclude.add(of);
      }
    }
    const started = Date.parse(session.startedAt);
    const hit = await loc.locate({
      cwd: session.cwd, startedAtMs: Number.isNaN(started) ? now() : started, ids, exclude, continueLast: continuesLast(session.args),
    });
    st.at = now();
    st.file = hit ? hit.file : null;
    return st.file;
  }

  /**
   * The feed for a session. `since` is the last seq the client has and `thread` the thread id it
   * has them for; a different thread (or none) answers with reset: true and the newest `limit`
   * events.
   * @param {object} session a Session (or its toJSON shape plus screenLines)
   * @param {{since?:number, thread?:string|null, others?:object[]}} [q]
   */
  async function feed(session, { since = 0, thread = null, others = [] } = {}) {
    const running = session.state === 'running';
    const screen = running && typeof session.screenLines === 'function' ? session.screenLines(SCREEN_ROWS) : [];
    const approval = detectApproval(screen);
    const file = await resolve(session, others);
    const r = file ? await rd.read(file) : null;
    if (!r) {
      return {
        available: false, thread: null, reset: thread !== null, seq: 0, truncated: false, events: [], turn: null,
        waiting: computeWaiting({ running, approval, needsInput: session.needsInput === true }),
      };
    }
    const name = path.basename(file);
    const tid = r.meta?.id || ROLLOUT_NAME_RE.exec(name)?.[1] || name;
    const reset = thread !== tid;
    const after = reset ? 0 : Math.max(0, Number(since) || 0);
    let events = r.events.filter((e) => e.seq > after);
    let truncated = after + 1 < r.firstSeq;
    if (reset && events.length > limit) { events = events.slice(-limit); truncated = true; }
    return {
      available: true,
      thread: { id: tid, cwd: r.meta?.cwd ?? null, startedAt: r.meta?.timestamp ? new Date(r.meta.timestamp).toISOString() : null, file: name },
      reset,
      seq: r.nextSeq - 1,
      truncated,
      events,
      turn: running ? r.turn : 'ended',
      waiting: computeWaiting({ running, approval, needsInput: session.needsInput === true, turn: r.turn, lastAgent: r.lastAgent }),
    };
  }

  return { feed, forget: (id) => state.delete(id) };
}
