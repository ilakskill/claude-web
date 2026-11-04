// Talk mode's store: per session, what to say for the latest finished turn (speech-text.js) and the
// WAV files made from it (tts.js), served by GET /api/sessions/<id>/speech[/<seq>/<part>.wav].
//
// Lazy by design: a turn is only text until some page asks for its audio. A page that has Talk on
// polls the speech route, which marks the session as listened to for LISTEN_MS; a turn that ends
// meanwhile has its first parts synthesized at once, so the reply starts playing without waiting
// for the page's next request. Audio lives in a private temp directory (created per hub run,
// removed on dispose and when a session is forgotten, swept by age and count). Nothing here logs
// the text.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { speechText, splitSpeech } from './speech-text.js';

const noopLog = { info() {}, warn() {}, error() {} };

export const LISTEN_MS = 15_000; // a poll this recent means a page is listening
export const DUPLICATE_MS = 5_000; // the same text again within this is the same turn (a hook that fired twice)
export const PREFETCH_PARTS = 2;
export const MAX_AGE_MS = 20 * 60_000;
export const MAX_FILES = 60;
const STALE_DIR_MS = 24 * 3600_000;
const DIR_PREFIX = 'cw-tts-';

export class SpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Removes cw-tts-* directories in the temp dir that a crashed hub left behind. */
function removeStaleDirs(tmp, now) {
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(DIR_PREFIX)) continue;
    const p = path.join(tmp, n);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && now() - st.mtimeMs > STALE_DIR_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* in use or gone */ }
  }
}

/**
 * @param {object} o
 * @param {object} o.voice validated voice config (config.js normalizeVoice): ttsEngine, ttsVoice, ttsSpeed, ttsMaxChars
 * @param {object} [o.tts] tts.js createTts(); without one (engine 'browser') audio() is a 503
 * @param {string} [o.cacheDir] default: a fresh mkdtemp under os.tmpdir(); a given dir is emptied
 * @param {object} [o.log]
 * @param {Function} [o.now]
 * @param {number} [o.maxAgeMs]
 * @param {number} [o.maxFiles]
 */
export function createSpeech({ voice, tts = null, cacheDir, log, now = Date.now, maxAgeMs = MAX_AGE_MS, maxFiles = MAX_FILES } = {}) {
  if (!voice) throw new TypeError('voice config is required');
  const lg = log || noopLog;
  let dir = cacheDir;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    removeStaleDirs(os.tmpdir(), now);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
  }

  const turns = new Map(); // session id -> {seq, parts: string[], chars, truncated, at, text}
  const listening = new Map(); // session id -> time of the last poll
  const cache = new Map(); // key -> {file, at}
  const inflight = new Map(); // key -> Promise
  let lastSeq = 0;

  const synthOn = () => !!tts && tts.configured !== false && voice.ttsEngine !== 'browser';
  const view = (t) => (t ? { seq: t.seq, parts: t.parts.length, chars: t.chars, truncated: t.truncated, at: t.at } : null);
  const keyOf = (id, seq, part) => `${id}-${seq}-${part}`;

  function drop(key) {
    const e = cache.get(key);
    cache.delete(key);
    if (e) fs.rmSync(e.file, { force: true });
  }
  function dropSession(id, exceptSeq) {
    for (const key of [...cache.keys()]) {
      const m = /^([0-9a-f]+)-(\d+)-\d+$/.exec(key);
      if (m && m[1] === id && Number(m[2]) !== exceptSeq) drop(key);
    }
  }

  /** Deletes aged-out files, then the oldest beyond maxFiles. */
  function sweep() {
    const t = now();
    for (const [key, e] of cache) if (t - e.at > maxAgeMs) drop(key);
    if (cache.size > maxFiles) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - maxFiles);
      for (const [key] of oldest) drop(key);
    }
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref?.();

  /**
   * A turn finished: remember what to say. Returns its summary, or null when nothing is speakable
   * (the previous turn then stays). The same text again within DUPLICATE_MS is the same turn.
   */
  function record(sessionId, markdown) {
    const { text, truncated } = speechText(markdown, { maxChars: voice.ttsMaxChars });
    if (!text) return null;
    const prev = turns.get(sessionId);
    if (prev && prev.text === text && now() - prev.at < DUPLICATE_MS) return view(prev);
    const parts = splitSpeech(text);
    lastSeq = Math.max(lastSeq + 1, now());
    const turn = { seq: lastSeq, parts, chars: text.length, truncated, at: now(), text };
    turns.set(sessionId, turn);
    dropSession(sessionId, turn.seq);
    if (synthOn() && now() - (listening.get(sessionId) ?? -Infinity) < LISTEN_MS) {
      for (let i = 0; i < Math.min(PREFETCH_PARTS, parts.length); i++) audio(sessionId, turn.seq, i).catch(() => {}); // errors surface when the page asks
    }
    return view(turn);
  }

  /**
   * A page with Talk on asked about this session: start the model now, and prefetch the next turn.
   * `synth: false` is a page that speaks with the browser's own voice: nothing to prepare for it.
   */
  function touch(sessionId, { synth = true } = {}) {
    if (!synth) return;
    listening.set(sessionId, now());
    if (synthOn()) tts.warm?.();
  }

  const latest = (sessionId) => view(turns.get(sessionId));

  /** The spoken text of a turn's parts (the browser engine speaks it itself); null when `seq` is stale. */
  function texts(sessionId, seq) {
    const t = turns.get(sessionId);
    return t && t.seq === seq ? [...t.parts] : null;
  }

  /**
   * The WAV of one part: made on first request, then served from the cache.
   * @returns {Promise<{file: string, bytes: number, ms: number, engine: string|null, cached: boolean}>}
   * @throws {SpeechError} 404 no such turn or part, 503 no synthesizer, 502 synthesis failed
   */
  async function audio(sessionId, seq, part) {
    const t = turns.get(sessionId);
    if (!t || t.seq !== seq) throw new SpeechError(404, 'no such speech');
    if (!Number.isInteger(part) || part < 0 || part >= t.parts.length) throw new SpeechError(404, 'no such part');
    if (!synthOn()) throw new SpeechError(503, 'speech synthesis is not available on the hub');
    const key = keyOf(sessionId, seq, part);
    const hit = cache.get(key);
    if (hit) {
      try {
        const st = await fsp.stat(hit.file);
        return { file: hit.file, bytes: st.size, ms: 0, engine: null, cached: true };
      } catch { cache.delete(key); }
    }
    let p = inflight.get(key);
    if (!p) {
      const file = path.join(dir, `${key}.wav`);
      p = (async () => {
        const t0 = now();
        let r;
        try {
          // The synthesizer does one part at a time: first parts of the newest turns go first, and a
          // part whose turn was replaced meanwhile is dropped before it costs any synthesis time.
          r = await tts.synthesize(t.parts[part], file, {
            voice: voice.ttsVoice,
            speed: voice.ttsSpeed,
            priority: [part === 0 ? 0 : 1, -seq, part],
            isStale: () => turns.get(sessionId)?.seq !== seq,
          });
        } catch (e) {
          fs.rm(file, { force: true }, () => {});
          if (e?.superseded) throw new SpeechError(404, 'no such speech');
          throw new SpeechError(502, String(e?.message || 'speech synthesis failed').slice(0, 300));
        }
        const st = await fsp.stat(file);
        if (turns.get(sessionId)?.seq !== seq) { fs.rm(file, { force: true }, () => {}); throw new SpeechError(404, 'no such speech'); } // superseded meanwhile
        cache.set(key, { file, at: now() });
        sweep();
        lg.info(`speech: part ${part} of ${t.parts.length} (${t.parts[part].length} chars -> ${r.seconds} s of audio) in ${Math.max(r.ms, now() - t0)} ms via ${r.engine}${r.fellBack ? ' (fallback)' : ''} (session ${sessionId})`);
        return { file, bytes: st.size, ms: r.ms, engine: r.engine, cached: false };
      })().finally(() => { inflight.delete(key); });
      inflight.set(key, p);
    }
    return p;
  }

  /** A session ended or was removed. */
  function forget(sessionId) {
    turns.delete(sessionId);
    listening.delete(sessionId);
    dropSession(sessionId, -1);
  }

  function dispose() {
    clearInterval(timer);
    cache.clear();
    inflight.clear();
    turns.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** @returns {{synth: boolean, state: string}} synth: the hub can make audio; state: the synthesizer process ('absent' | 'stopped' | 'starting' | 'ready') */
  function status() {
    return { synth: synthOn(), state: tts?.status ? tts.status().state : 'absent' };
  }

  return { record, touch, latest, texts, audio, forget, sweep, status, dispose, cacheDir: dir };
}
