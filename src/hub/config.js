// Hub configuration and well-known locations.
//   dataDir:    CW_DATA_DIR || ~/.cw  (%USERPROFILE%\.cw; one-time migration from %LOCALAPPDATA%\cw)
//   claudeHome: CW_CLAUDE_HOME || ~/.claude
//   config:     <dataDir>/config.json merged over DEFAULT_CONFIG; CW_PORT overrides port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_STRIP_ENV } from './spawn-env.js';
import { writeJsonAtomic } from './util.js';
import '../shared/harnesses.js';
import '../shared/session-color.js';

// ---------- voice dictation (docs/evidence/voice/PLAN.md) ----------
// `voice` is the only nested object in config.json; loadConfig merges it per key, so a file that
// sets `{"voice": {"model": "base"}}` keeps every other default. Validated by normalizeVoice.
export const DEFAULT_VOICE = Object.freeze({
  enabled: true,
  engine: 'whisper', // 'whisper': faster-whisper on this PC; 'browser': Web Speech API (audio leaves the phone)
  model: 'small', // faster-whisper model name (tiny, base, small, medium, large-v3, *.en) or a CTranslate2 model dir
  language: 'auto', // 'auto' or an ISO 639-1 code such as 'en'
  device: 'auto', // 'auto' (cuda when available, else cpu), 'cuda', 'cpu'
  python: 'C:\\Python314\\python.exe', // interpreter with faster-whisper installed
  idleMinutes: 120, // the transcriber and synthesizer processes exit after this long without a request (0: never). Starting them costs 10 to 60 s, so they stay warm.
  prewarm: true, // start the transcriber and synthesizer when the hub starts, so the first utterance and reply do not pay for the model load
  talkBrowserStt: true, // Talk mode listens with the browser's SpeechRecognition when it can (fast, live text), else the hub's whisper. Chrome sends that audio to Google, Edge to Microsoft: false keeps all audio on the PC.
  requestTimeoutSeconds: 60, // one utterance must be transcribed within this; else the process is restarted
  // Talk mode (README "Talk mode"): the hub speaks Claude's final message of each turn.
  talk: true, // false hides the Talk button and refuses the speech routes
  ttsEngine: 'kokoro', // 'kokoro' | 'piper' (both on this PC) | 'browser' (the page's speechSynthesis: the phone's own voice)
  ttsFallback: 'piper', // used when ttsEngine cannot start or fails: 'piper' | 'none'
  ttsVoice: 'af_heart', // Kokoro voice name (af_heart, af_bella, am_adam, bf_emma, ...)
  ttsSpeed: 1, // 0.5 to 2
  ttsMaxChars: 600, // only the start of a long reply is spoken (then "The rest is on screen.")
  ttsThreads: 8, // CPU threads for synthesis (0: onnxruntime decides, which is slower than 8 on a 32-thread CPU)
  ttsPython: '', // interpreter for the synthesizer; '' uses `python`
  kokoroModel: 'C:\\tools\\kokoro\\kokoro-v1.0.onnx',
  kokoroVoices: 'C:\\tools\\kokoro\\voices-v1.0.bin',
  piperModel: 'C:\\tools\\piper\\en_US-amy-medium.onnx',
});
const VOICE_ENGINES = ['whisper', 'browser'];
const VOICE_DEVICES = ['auto', 'cuda', 'cpu'];
const TTS_ENGINES = ['kokoro', 'piper', 'browser'];
const TTS_FALLBACKS = ['piper', 'none'];
const oneLine = (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n\t]/.test(v);
const LANGUAGE_RE = /^(auto|[a-z]{2,3})$/;

/**
 * A complete, validated voice config: `raw` (config.json's `voice`) merged per key over
 * DEFAULT_VOICE. Every bad value falls back to its default with one WARN on `log`; never throws.
 */
export function normalizeVoice(raw, log) {
  const out = { ...DEFAULT_VOICE };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.(`config.voice must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}; using the defaults`);
    return out;
  }
  const checks = {
    enabled: (v) => typeof v === 'boolean',
    engine: (v) => VOICE_ENGINES.includes(v),
    model: (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n\t]/.test(v),
    language: (v) => typeof v === 'string' && LANGUAGE_RE.test(v),
    device: (v) => VOICE_DEVICES.includes(v),
    python: (v) => typeof v === 'string' && v.trim() !== '',
    idleMinutes: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    requestTimeoutSeconds: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
    prewarm: (v) => typeof v === 'boolean',
    talkBrowserStt: (v) => typeof v === 'boolean',
    talk: (v) => typeof v === 'boolean',
    ttsEngine: (v) => TTS_ENGINES.includes(v),
    ttsFallback: (v) => TTS_FALLBACKS.includes(v),
    ttsVoice: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
    ttsSpeed: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 2,
    ttsMaxChars: (v) => Number.isInteger(v) && v >= 40 && v <= 5000,
    ttsThreads: (v) => Number.isInteger(v) && v >= 0 && v <= 64,
    ttsPython: (v) => typeof v === 'string' && !/[\r\n\t]/.test(v),
    kokoroModel: oneLine,
    kokoroVoices: oneLine,
    piperModel: oneLine,
  };
  for (const [k, ok] of Object.entries(checks)) {
    if (!Object.hasOwn(raw, k) || raw[k] === undefined) continue;
    if (ok(raw[k])) out[k] = raw[k];
    else log?.warn?.(`config.voice.${k}: invalid value ${JSON.stringify(raw[k])}; using the default ${JSON.stringify(DEFAULT_VOICE[k])}`);
  }
  return out;
}
// ---------- end voice ----------

// ---------- Tailscale identity login (docs/evidence/tailscale-auth/PLAN.md) ----------
// `tailscaleAuth` is the second nested object. When enabled, a request that tailscale serve
// delivers (from loopback) with a `Tailscale-User-Login` header in `allow` is signed in as
// `ts:<login>` without a token. Validated by normalizeTailscaleAuth; merged per key by loadConfig.
export const DEFAULT_TAILSCALE_AUTH = Object.freeze({
  enabled: false,
  allow: Object.freeze([]), // lowercase Tailscale logins (emails), e.g. "name@gmail.com"
});
// A login is an email as Tailscale reports it: printable ASCII, lowercase, no whitespace, one "@".
const TS_LOGIN_RE = /^[^\s@]+@[^\s@]+$/;
const ASCII_RE = /^[\x21-\x7e]+$/;
export const isTailscaleLogin = (v) => typeof v === 'string' && ASCII_RE.test(v) && TS_LOGIN_RE.test(v) && v === v.toLowerCase();

/**
 * A complete, validated tailscaleAuth config: {enabled, allow}. A bad `enabled` is false, a bad
 * `allow` is [], a bad entry is dropped; each with one WARN on `log`. Enabled with nothing
 * allowed is disabled (WARN): a bad config can never open the door. Never throws; never aliases
 * the input.
 */
export function normalizeTailscaleAuth(raw, log) {
  const out = { enabled: false, allow: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.(`config.tailscaleAuth must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}; using the defaults (disabled)`);
    return out;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else log?.warn?.(`config.tailscaleAuth.enabled: invalid value ${JSON.stringify(raw.enabled)}; using false`);
  }
  if (raw.allow !== undefined) {
    if (!Array.isArray(raw.allow)) {
      log?.warn?.(`config.tailscaleAuth.allow: must be an array of lowercase logins, got ${JSON.stringify(raw.allow)}; using []`);
    } else {
      for (const v of raw.allow) {
        if (isTailscaleLogin(v)) { if (!out.allow.includes(v)) out.allow.push(v); } else log?.warn?.(`config.tailscaleAuth.allow: dropped invalid login ${JSON.stringify(v)} (must be a lowercase email with no whitespace)`);
      }
    }
  }
  if (out.enabled && out.allow.length === 0) {
    log?.warn?.('config.tailscaleAuth.enabled is true but the allow list is empty; Tailscale login stays disabled (cw auth tailscale add <login>)');
    out.enabled = false;
  }
  return out;
}
// ---------- end tailscaleAuth ----------

// ---------- harness presets (docs/evidence/harnesses/PLAN.md) ----------
// `harnesses.<id>` overrides one preset from src/shared/harnesses.js:
//   path   existing file used instead of the command found on PATH
//   args   replaces the preset's own arguments
//   models replaces the model list (strings)
//   hidden leaves the preset out of the picker
//   bell   false turns off bell/OSC pushes for sessions of this harness
export const NOTIFY_BELL_VALUES = Object.freeze(['auto', true, false]);

const fileExists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * A validated harnesses config: only known ids, only valid keys. Every bad value is dropped with one
 * WARN on `log`; never throws; never aliases the input.
 */
export function normalizeHarnesses(raw, log) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.(`config.harnesses must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}; ignoring it`);
    return out;
  }
  const { getHarness, validModel } = globalThis.cwHarnesses;
  const checks = {
    path: (v) => typeof v === 'string' && v.trim() !== '' && fileExists(v),
    args: (v) => Array.isArray(v) && v.every((a) => typeof a === 'string'),
    models: (v) => Array.isArray(v) && v.every((m) => validModel(m)),
    hidden: (v) => typeof v === 'boolean',
    bell: (v) => typeof v === 'boolean',
  };
  for (const [id, entry] of Object.entries(raw)) {
    if (!getHarness(id)) { log?.warn?.(`config.harnesses.${id}: unknown harness; ignoring it`); continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      log?.warn?.(`config.harnesses.${id} must be an object; ignoring it`);
      continue;
    }
    const clean = {};
    for (const [k, v] of Object.entries(entry)) {
      if (!Object.hasOwn(checks, k)) { log?.warn?.(`config.harnesses.${id}.${k}: unknown key; ignoring it`); continue; }
      if (checks[k](v)) clean[k] = Array.isArray(v) ? [...v] : v;
      else log?.warn?.(`config.harnesses.${id}.${k}: invalid value ${JSON.stringify(v)}; ignoring it`);
    }
    out[id] = clean;
  }
  return out;
}

/** The default harness id: known, not hidden, and not needing a model (ollama), else 'claude' (one WARN). */
export function normalizeDefaultHarness(raw, harnesses = {}, log) {
  if (raw === undefined || raw === null) return 'claude';
  const h = typeof raw === 'string' ? globalThis.cwHarnesses.getHarness(raw) : null;
  if (!h || harnesses[h.id]?.hidden === true || h.modelRequired) {
    log?.warn?.(`config.defaultHarness: ${JSON.stringify(raw)} is not a known, visible harness that starts without a model; using "claude"`);
    return 'claude';
  }
  return h.id;
}
// ---------- end harnesses ----------

// ---------- session accent colors ----------
// `sessionColors` maps a folder to a color: {"C:\Dev\myproject": "#a78bfa"}. A session whose cwd is that
// folder (or inside it) gets that accent; every other folder gets a palette color picked by a hash of
// its path (src/shared/session-color.js).

/** A validated sessionColors map: folder -> "#rrggbb". Bad entries are dropped with one WARN; never throws. */
export function normalizeSessionColors(raw, log) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.(`config.sessionColors must be an object of folder -> "#rrggbb", got ${Array.isArray(raw) ? 'array' : typeof raw}; ignoring it`);
    return out;
  }
  const { normalizeColor } = globalThis.cwSessionColor;
  for (const [folder, color] of Object.entries(raw)) {
    const c = normalizeColor(color);
    if (folder.trim() !== '' && c) out[folder] = c;
    else log?.warn?.(`config.sessionColors[${JSON.stringify(folder)}]: invalid value ${JSON.stringify(color)} (want a hex color such as "#a78bfa"); ignoring it`);
  }
  return out;
}
// ---------- end session accent colors ----------

export const DEFAULT_CONFIG = Object.freeze({
  port: 4242,
  projectRoots: Object.freeze(['C:\\Dev']),
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: null,
  ntfyTopicDone: null, // null: derived as `${ntfyTopic}-done` by loadConfig (never written)
  notifyIdle: false,
  notifyBell: 'auto', // bell / OSC 9 pushes: 'auto' (harnesses without hooks), true (all), false (none)
  defaultHarness: 'claude',
  harnesses: Object.freeze({}),
  sessionColors: Object.freeze({}),
  terminalTint: true, // tint the text types inside session terminals per session (web/term-tint.js); false = one fixed palette
  notifyPreview: false, // "finished" push body = start of Claude's last message (transcript text leaves the PC via ntfy)
  browser: 'default',
  stripEnv: DEFAULT_STRIP_ENV,
  voice: DEFAULT_VOICE,
  tailscaleAuth: DEFAULT_TAILSCALE_AUTH,
});

/**
 * The data directory path, with no side effects: CW_DATA_DIR, else ~/.cw.
 * Not %LOCALAPPDATA%: a process inside an MSIX package (the Claude desktop app and every shell it
 * starts) sees a private, virtualized copy of %LOCALAPPDATA%, so hooks and `cw` run from there
 * would read a different token and topic than the hub. The user profile is not virtualized.
 */
export function dataDirPath() {
  return process.env.CW_DATA_DIR || path.join(os.homedir(), '.cw');
}

/** Data dir used before Task 8 (%LOCALAPPDATA%\cw), or null when LOCALAPPDATA is unset. */
export function legacyDataDir() {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'cw') : null;
}

/** Files carried over by the migration. Logs, hub.pid/hub.port and hub-start.vbs are not. */
export const MIGRATED_FILES = Object.freeze(['config.json', 'tokens.json', 'sessions.json']);

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * One-time migration: when `dest` does not exist and `source` holds any of MIGRATED_FILES, copies
 * them (same token, same ntfy topic) plus a MIGRATED-FROM.txt note into a staging dir and renames
 * it to `dest`. The rename is atomic, so a concurrent process either sees no `dest` or a complete
 * one; the loser discards its staging copy. Returns true if this call created `dest`.
 */
export function migrateLegacyDataDir(dest, source = legacyDataDir(), now = new Date()) {
  if (!source || fs.existsSync(dest)) return false;
  if (path.resolve(source).toLowerCase() === path.resolve(dest).toLowerCase()) return false;
  const files = MIGRATED_FILES.filter((f) => isFile(path.join(source, f)));
  if (files.length === 0) return false;
  const staging = `${dest}.migrating-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(source, f), path.join(staging, f));
    fs.writeFileSync(path.join(staging, 'MIGRATED-FROM.txt'), [
      `cw data dir migrated on ${now.toISOString()}`,
      `from: ${source}`,
      `copied: ${files.join(', ')}`,
      'not copied: logs, hub.pid, hub.port, hub-start.vbs',
      'The old folder is no longer used. Delete it once cw works from here.',
      '',
    ].join('\r\n'));
    fs.renameSync(staging, dest);
    return true;
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    if (fs.existsSync(dest)) return false; // another process migrated first
    throw new Error(`cannot migrate ${source} to ${dest}: ${e.message}`);
  }
}

/** Returns the data directory, migrating the legacy one on first use and creating it if needed. */
export function dataDir() {
  const dir = dataDirPath();
  if (!process.env.CW_DATA_DIR) migrateLegacyDataDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function claudeHome() {
  return process.env.CW_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function geminiHome() {
  return process.env.CW_GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

export function codexHome() {
  return process.env.CW_CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function configPath() {
  return path.join(dataDir(), 'config.json');
}

const tailscaleAuthCopy = (raw) => ({
  enabled: DEFAULT_TAILSCALE_AUTH.enabled,
  ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  allow: raw && Array.isArray(raw.allow) ? [...raw.allow] : [...DEFAULT_TAILSCALE_AUTH.allow],
});

function defaultsCopy() {
  return {
    ...DEFAULT_CONFIG,
    projectRoots: [...DEFAULT_CONFIG.projectRoots],
    stripEnv: [...DEFAULT_CONFIG.stripEnv],
    harnesses: {},
    sessionColors: {},
    voice: { ...DEFAULT_VOICE },
    tailscaleAuth: tailscaleAuthCopy(null),
  };
}

/**
 * Values that older versions wrote into config.json on first run (every code default, pinned).
 * A key whose value deep-equals one of these is not a user choice: it is dropped, so the current
 * default applies (final review I1). Includes the 4-name stripEnv list from before Task 8.
 * ntfyTopic is never listed: it is generated per install.
 */
export const PINNED_DEFAULTS = Object.freeze({
  port: [4242],
  projectRoots: [[...DEFAULT_CONFIG.projectRoots]],
  ntfyServer: ['https://ntfy.sh'],
  notifyIdle: [false],
  browser: ['default'],
  stripEnv: [
    ['CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT'],
    [...DEFAULT_STRIP_ENV],
  ],
});

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Keys of `fromFile` that hold a pinned old default (see PINNED_DEFAULTS). */
export function pinnedDefaultKeys(fromFile) {
  return Object.keys(fromFile).filter((k) => Object.hasOwn(PINNED_DEFAULTS, k)
    && PINNED_DEFAULTS[k].some((v) => deepEqual(fromFile[k], v)));
}

function envPort() {
  const raw = process.env.CW_PORT;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Returns DEFAULT_CONFIG merged with config.json. The file holds only generated values (ntfyTopic)
 * and keys the user set; defaults are merged here, at read time, so a later default reaches every
 * install. First call with no file writes only a generated ntfyTopic (`cw-` + 32 hex).
 * Keys holding a pinned old default (PINNED_DEFAULTS) are ignored; with `cleanup: true` (the hub,
 * at startup) they are also removed from the file, once, and the removal is logged to `log`.
 * Throws if config.json exists but is not valid JSON. The CW_PORT override and the derived
 * ntfyTopicDone (`<ntfyTopic>-done` unless the file sets it) are applied to the returned object
 * only (never persisted).
 * @param {{cleanup?: boolean, log?: {info: Function}}} [o]
 */
export function loadConfig({ cleanup = false, log } = {}) {
  const file = configPath();
  let fromFile = readConfigFile(file);
  if (fromFile === null) {
    fromFile = { ntfyTopic: 'cw-' + crypto.randomBytes(16).toString('hex') };
    saveConfig(fromFile);
  } else {
    const pinned = pinnedDefaultKeys(fromFile);
    if (pinned.length) {
      const kept = Object.fromEntries(Object.entries(fromFile).filter(([k]) => !pinned.includes(k)));
      if (cleanup) {
        saveConfig(kept);
        log?.info(`config cleanup: removed pinned default(s) ${pinned.join(', ')} from ${file}; built-in defaults apply`);
      }
      fromFile = kept;
    }
  }
  const cfg = { ...defaultsCopy(), ...fromFile };
  // voice is merged per key (a partial object in the file keeps the other defaults); values are
  // not validated here (the hub does that once, with a WARN per bad key: normalizeVoice).
  const rawVoice = fromFile.voice;
  cfg.voice = rawVoice && typeof rawVoice === 'object' && !Array.isArray(rawVoice) ? { ...DEFAULT_VOICE, ...rawVoice } : { ...DEFAULT_VOICE };
  // tailscaleAuth likewise (validated once by the hub: normalizeTailscaleAuth).
  const rawTs = fromFile.tailscaleAuth;
  cfg.tailscaleAuth = tailscaleAuthCopy(rawTs && typeof rawTs === 'object' && !Array.isArray(rawTs) ? rawTs : null);
  const port = envPort();
  if (port !== null) cfg.port = port;
  // Topics must be non-empty strings (they become a URL path segment); anything else is treated as
  // unset: no input topic disables notifications, no done topic falls back to <ntfyTopic>-done.
  const topicOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
  cfg.ntfyTopic = topicOrNull(cfg.ntfyTopic);
  cfg.ntfyTopicDone = topicOrNull(cfg.ntfyTopicDone) ?? (cfg.ntfyTopic ? `${cfg.ntfyTopic}-done` : null);
  // notifyPreview sends transcript text to the ntfy server, so only a boolean true turns it on.
  // Anything else (a "true" string, 1, null, ...) is off, with one WARN when a logger is given.
  if (typeof cfg.notifyPreview !== 'boolean') {
    log?.warn?.(`config.notifyPreview: invalid value ${JSON.stringify(cfg.notifyPreview)}; using false`);
    cfg.notifyPreview = false;
  }
  // terminalTint: a boolean; anything else is the default (true) with one WARN.
  if (typeof cfg.terminalTint !== 'boolean') {
    log?.warn?.(`config.terminalTint: invalid value ${JSON.stringify(cfg.terminalTint)}; using true`);
    cfg.terminalTint = true;
  }
  // notifyBell: 'auto' | true | false; anything else is 'auto' with one WARN.
  if (!NOTIFY_BELL_VALUES.includes(cfg.notifyBell)) {
    log?.warn?.(`config.notifyBell: invalid value ${JSON.stringify(cfg.notifyBell)}; using "auto"`);
    cfg.notifyBell = 'auto';
  }
  return cfg;
}

/** The raw object in config.json (only generated values and user-set keys), or null without a file. Throws on a malformed file. */
function readConfigFile(file = configPath()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${e.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`cannot read ${file}: not a JSON object`);
  return data;
}

/**
 * Edits config.json in place: `fn(raw)` gets the file's own object (never the merged defaults, so
 * no default is ever frozen into the file) and may mutate it; the result is written atomically.
 * Without a file, starts from a fresh generated ntfyTopic like loadConfig. Returns fn's result.
 */
export function editConfig(fn) {
  const raw = readConfigFile() ?? { ntfyTopic: 'cw-' + crypto.randomBytes(16).toString('hex') };
  const r = fn(raw);
  saveConfig(raw);
  return r;
}

/** Atomically writes obj to <dataDir>/config.json. */
export function saveConfig(obj) {
  writeJsonAtomic(configPath(), obj);
}
