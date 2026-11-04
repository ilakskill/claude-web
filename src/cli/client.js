// Hub REST client for the CLI. Always talks to 127.0.0.1:<port> (the hub's Host allowlist), sends
// the token as a Cookie header (never in the URL) and never sends an Origin header.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, dataDir } from '../hub/config.js';
import { loadTokens, COOKIE_NAME } from '../hub/auth.js';
import { discoverTailscale } from '../hub/tailscale.js';

export const HOST = '127.0.0.1';
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const hubJsPath = path.join(repoRoot, 'src', 'hub', 'hub.js');
export const cwJsPath = path.join(repoRoot, 'bin', 'cw.js');

export class CliError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Port from config.json, overridden by CW_PORT. */
export function hubPort() {
  return loadConfig().port;
}

export function hubUrl(port = hubPort()) {
  return `http://${HOST}:${port}`;
}

/**
 * Base URL for phones: CW_PUBLIC_BASE / config.publicBase if set (same precedence as the hub), else
 * https://<tailnet name>:<port> when tailscale answers, else null.
 */
export async function remoteBase(port = hubPort(), { discover = discoverTailscale } = {}) {
  const configured = process.env.CW_PUBLIC_BASE || loadConfig().publicBase;
  if (configured) return String(configured).replace(/\/+$/, '');
  const ts = await discover();
  return ts ? `https://${ts.dnsName}:${port}` : null;
}

/** First token in tokens.json (created with the `default` token on first run). */
export function token() {
  const tokens = loadTokens(dataDir());
  if (tokens.length === 0) throw new CliError(`no tokens in ${path.join(dataDir(), 'tokens.json')}; run: cw token add <name>`);
  return tokens[0].token;
}

export const isRefused = (e) => e?.cause?.code === 'ECONNREFUSED' || e?.code === 'ECONNREFUSED';

/**
 * Calls the hub. Resolves to the parsed JSON body (null for an empty body).
 * Throws CliError with `status` on an HTTP error, or a "not running" CliError when refused.
 */
export async function api(method, urlPath, body, { port = hubPort(), timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const headers = { cookie: `${COOKIE_NAME}=${token()}` };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(`${hubUrl(port)}${urlPath}`, init);
  } catch (e) {
    if (isRefused(e)) throw new CliError(`hub is not running on ${HOST}:${port} (start it with: cw hub start)`);
    if (e?.name === 'TimeoutError') throw new CliError(`hub did not answer ${method} ${urlPath} within ${timeoutMs / 1000} s`);
    throw new CliError(`cannot reach hub on ${HOST}:${port}: ${e?.cause?.message || e.message}`);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string') ? data.error : (text.trim() || res.statusText);
    throw new CliError(`hub answered ${res.status}: ${msg}`, { status: res.status, body: data });
  }
  return data;
}

/**
 * GET /api/health (no auth). Resolves to {state:'cw', health} | {state:'refused'} |
 * {state:'unresponsive'} (something accepted the connection but did not answer in time: a busy
 * or still-starting cw hub, or a hung program) | {state:'foreign', reason}.
 */
export async function probeHealth(port = hubPort(), { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${hubUrl(port)}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (isRefused(e)) return { state: 'refused' };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { state: 'unresponsive', reason: `no answer within ${timeoutMs / 1000} s` };
    return { state: 'foreign', reason: e?.cause?.code || e.message };
  }
  let health = null;
  try { health = await res.json(); } catch { health = null; }
  if (res.ok && health && health.app === 'cw') return { state: 'cw', health };
  return { state: 'foreign', reason: `HTTP ${res.status}` };
}

/** Finds a session by index or id in a list. Returns the first match (lists are newest first). */
export function findSession(list, target) {
  const s = String(target);
  if (/^[0-9a-f]{8}$/.test(s)) {
    const byId = list.find((x) => x.id === s);
    if (byId) return byId;
  }
  if (/^\d+$/.test(s)) return list.find((x) => x.index === Number(s)) || null;
  return null;
}
