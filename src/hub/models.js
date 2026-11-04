// Model lists for the harness picker. Each preset names where its list comes from (a command it
// runs, an HTTP endpoint, a config file, or a fixed list); a failure never throws: the answer then
// has an empty list and an `error`, and the form still offers "harness default" and "custom".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildSpawnEnv, DEFAULT_STRIP_ENV } from './spawn-env.js';
import '../shared/harnesses.js';
import { resolveLaunch } from './launch.js';
import { codexHome } from './config.js';

export const CACHE_MS = 10 * 60 * 1000;
export const EXEC_TIMEOUT_MS = 20000;
export const HTTP_TIMEOUT_MS = 5000;
export const REFRESH_MIN_MS = 30 * 1000;
export const HTTP_MAX_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

const entry = (id, label = id) => ({ id, label });
const lines = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// ---------- parsers (pure; fed with real CLI output in the tests) ----------

/** agy models: `id<TAB>label`, after a "Fetching available models..." line. */
export function parseTsv(text) {
  return lines(text).filter((l) => l.includes('\t')).map((l) => { const [id, label] = l.split('\t'); return entry(id.trim(), (label || id).trim()); });
}

/** copilot help config: the `model` setting lists its values as `- "name"` lines. */
export function parseCopilotConfig(text) {
  const all = String(text).split(/\r?\n/);
  const start = all.findIndex((l) => /^\s*`model`:/.test(l));
  const found = ['auto'];
  if (start >= 0) {
    for (let i = start + 1; i < all.length; i++) {
      if (/^\s*`[^`]+`:/.test(all[i])) break;
      const m = all[i].match(/^\s*-\s+"([^"]+)"/);
      if (m && !found.includes(m[1])) found.push(m[1]);
    }
  }
  return found.map((m) => entry(m));
}

/** opencode models: `provider/model` lines among log noise. */
export function parseSlashLines(text) {
  return lines(text).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((l) => entry(l));
}

/** opencode.json: `provider.<name>.models` keys, as `<name>/<key>`. */
export function parseOpencodeJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const [p, v] of Object.entries(j?.provider || {})) {
    for (const k of Object.keys(v?.models || {})) out.push(entry(`${p}/${k}`));
  }
  return out;
}

/** pi --list-models: a table whose first two columns are provider and model. */
export function parsePiTable(text) {
  return lines(text).slice(1).map((l) => l.split(/\s+/)).filter((c) => c.length >= 2).map((c) => entry(`${c[0]}/${c[1]}`));
}

/** ollama list: a header line, then the model name in the first column. */
export function parseOllamaList(text) {
  return lines(text).slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean).map((m) => entry(m));
}

/** ollama /api/tags JSON; embedding-only models cannot chat and are left out. */
export function parseOllamaTags(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  return (Array.isArray(j?.models) ? j.models : []).map((m) => m?.name).filter((n) => typeof n === 'string' && !/embed/i.test(n)).map((n) => entry(n));
}

/**
 * NVIDIA GET /v1/models JSON ({data:[{id}]}) as OpenCode model names (`nvidia/<id>`, the provider
 * prefix in front of NVIDIA's own `org/model` id). Embedding, reranking and image models are left out.
 */
export function parseNvidiaModels(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(j?.data) ? j.data : []) {
    const id = m?.id;
    if (typeof id !== 'string' || !/^[\w.:-]+\/[\w.:-]+$/.test(id) || /embed|rerank|flux|diffusion|safety|guard|retriev|clip/i.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry(`nvidia/${id}`));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** ~/.codex/config.toml: the top-level `model = "..."` line (before the first [table]). */
export function parseTomlModel(text) {
  for (const l of lines(text)) {
    if (l.startsWith('[')) break;
    const m = l.match(/^model\s*=\s*"([^"]+)"/);
    if (m) return [entry(m[1])];
  }
  return [];
}

/** ~/.hermes/config.yaml: `default:` or `model:` values inside the top-level `model:` block. */
export function parseHermesYaml(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^model:\s*$/.test(raw)) { inBlock = true; continue; }
    if (inBlock && /^\S/.test(raw)) break;
    if (!inBlock) continue;
    const m = raw.match(/^\s+(?:default|model):\s*["']?([^"'\s#]+)/);
    if (m && !out.some((e) => e.id === m[1])) out.push(entry(m[1]));
  }
  return out;
}

const PARSERS = {
  tsv: parseTsv, 'copilot-config': parseCopilotConfig, lines: parseSlashLines, 'opencode-json': parseOpencodeJson,
  'pi-table': parsePiTable, 'ollama-list': parseOllamaList, 'toml-model': parseTomlModel, 'hermes-yaml': parseHermesYaml,
};

// ---------- sources ----------

function expandHome(p) {
  if (p.startsWith('~/') && p.includes('/.codex/')) return path.join(codexHome(), p.slice('~/.codex/'.length));
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Kills a child and (on Windows) everything it started; best effort. */
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
    } else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

function runCommand(command, argv, { env, resolve, timeout, stripEnv }) {
  return new Promise((resolveP, reject) => {
    let l;
    const childEnv = buildSpawnEnv(env, { strip: [...stripEnv, ...globalThis.cwHarnesses.HARNESSES.filter((h) => h.requiresEnv).map((h) => h.requiresEnv)] });
    try { l = resolveLaunch(command, argv, { env: childEnv, resolve }); } catch (e) { reject(e); return; }
    let timedOut = false;
    let timer = null;
    const child = execFile(l.file, l.args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: childEnv, encoding: 'utf8', windowsVerbatimArguments: l.via === 'cmd' }, (err, stdout) => {
      clearTimeout(timer);
      // A CLI that crashes after printing a list still gave us a list; only an empty answer is an error.
      if (stdout && String(stdout).trim()) resolveP(String(stdout));
      else reject(timedOut ? new Error('timed out') : (err || new Error('no output')));
    });
    timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    timer.unref?.();
  });
}

/**
 * @param {object} o
 * @param {Function} o.resolve the hub's resolveCommand
 * @param {object} [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {() => object} [o.harnessConfig] config.harnesses (validated), read per call
 * @param {string[]} [o.stripEnv] env names removed from the environment of model-listing commands
 * @param {() => number} [o.now]
 */
export function createModels({ resolve, env = process.env, fetchImpl = globalThis.fetch, harnessConfig = () => ({}), stripEnv = DEFAULT_STRIP_ENV, now = Date.now, execTimeoutMs = EXEC_TIMEOUT_MS, httpTimeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const cache = new Map();
  const inflight = new Map(); // harness id -> the one fetch in progress
  const lastRefresh = new Map(); // harness id -> when a refresh last ran

  async function fromSpec(h, spec) {
    if (spec.kind === 'static') return { source: 'static', models: spec.list.map((m) => entry(m)) };
    if (spec.kind === 'file') {
      const text = fs.readFileSync(expandHome(spec.path), 'utf8');
      return { source: 'file', models: PARSERS[spec.parse](text) };
    }
    if (spec.kind === 'http') {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), httpTimeoutMs);
      try {
        const r = await fetchImpl(spec.url, { signal: ac.signal, redirect: 'error' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (text.length > HTTP_MAX_BYTES) throw new Error('response too large');
        return { source: 'http', models: parseOllamaTags(text) };
      } finally { clearTimeout(timer); }
    }
    if (spec.kind === 'nvidia') {
      // The key comes from the environment at request time and goes only into the Authorization
      // header: never into the URL, the cache, the answer or an error message.
      const key = env.NVIDIA_API_KEY;
      if (!key || !String(key).trim()) throw new Error('NVIDIA_API_KEY is not set in the hub environment');
      const base = String(env.CW_NVIDIA_BASE_URL || NVIDIA_BASE_URL).replace(/\/+$/, '');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), httpTimeoutMs);
      try {
        const r = await fetchImpl(`${base}/models`, { signal: ac.signal, redirect: 'error', headers: { authorization: `Bearer ${String(key).trim()}`, accept: 'application/json' } });
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'NVIDIA rejected the API key' : `NVIDIA HTTP ${r.status}`);
        const text = await r.text();
        if (text.length > HTTP_MAX_BYTES) throw new Error('response too large');
        return { source: 'http', models: parseNvidiaModels(text) };
      } catch (e) {
        throw new Error(e?.name === 'AbortError' ? 'NVIDIA model list timed out' : (/^(NVIDIA|response)/.test(e?.message) ? e.message : 'could not reach NVIDIA'));
      } finally { clearTimeout(timer); }
    }
    if (spec.kind === 'command') {
      const cfg = harnessConfig()[h.id] || {};
      const text = await runCommand(cfg.path || h.command, spec.argv, { env, resolve, timeout: execTimeoutMs, stripEnv });
      return { source: 'command', models: PARSERS[spec.parse](text) };
    }
    throw new Error(`unknown model source ${spec.kind}`);
  }

  /** @returns {Promise<{id:string, models:{id:string,label:string}[], source:string|null, fetchedAt:string, error:string|null}>} */
  async function list(id, { refresh = false } = {}) {
    const h = globalThis.cwHarnesses.getHarness(id);
    if (!h) return null;
    const cfg = harnessConfig()[id];
    const stamp = () => new Date(now()).toISOString();
    if (cfg?.models) return { id, models: cfg.models.slice(0, MAX_MODELS).map((m) => entry(m)), source: 'config', fetchedAt: stamp(), error: null };
    if (!h.models) return { id, models: [], source: null, fetchedAt: stamp(), error: null };
    const hit = cache.get(id);
    // A refresh inside REFRESH_MIN_MS of the last one is served from the cache.
    const force = refresh && now() - (lastRefresh.get(id) ?? -Infinity) >= REFRESH_MIN_MS;
    if (!force && hit && now() - hit.at < CACHE_MS) return hit.value;
    if (inflight.has(id)) return inflight.get(id);
    if (force) lastRefresh.set(id, now());
    const p = load(h, id, stamp).finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  async function load(h, id, stamp) {
    let value;
    const attempts = [h.models, h.models.fallback].filter(Boolean);
    let lastError = null;
    for (const spec of attempts) {
      try {
        const r = await fromSpec(h, spec);
        if (r.models.length || spec === attempts[attempts.length - 1]) {
          value = { id, models: r.models.slice(0, MAX_MODELS), source: r.source, fetchedAt: stamp(), error: null };
          break;
        }
      } catch (e) { lastError = e; }
    }
    value ??= { id, models: [], source: null, fetchedAt: stamp(), error: String(lastError?.message || lastError || 'no models found').slice(0, 200) };
    // Failures are not cached for long: a server that was down a moment ago may be up now.
    if (!value.error) cache.set(id, { at: now(), value });
    return value;
  }

  return { list };
}
