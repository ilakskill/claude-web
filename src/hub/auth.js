// Token store (<dataDir>/tokens.json = {tokens:[{name,token,createdAt}]}) and request auth.
// Token values are only ever returned by loadTokens(); add/remove/list never expose them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './util.js';

export const COOKIE_NAME = 'cw_token';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const tokensFile = (dataDir) => path.join(dataDir, 'tokens.json');
const newToken = () => crypto.randomBytes(32).toString('hex');

function writeTokens(dataDir, tokens) {
  writeJsonAtomic(tokensFile(dataDir), { tokens }, { mode: 0o600 });
}

/**
 * Returns [{name, token, createdAt}]. Creates tokens.json with one `default` token on first run.
 * Throws if the file exists but is unreadable or malformed.
 */
export function loadTokens(dataDir) {
  const file = tokensFile(dataDir);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${e.message}`);
    const tokens = [{ name: 'default', token: newToken(), createdAt: new Date().toISOString() }];
    writeTokens(dataDir, tokens);
    return tokens;
  }
  if (!data || !Array.isArray(data.tokens)) throw new Error(`cannot read ${file}: missing tokens array`);
  return data.tokens.filter((t) => t && typeof t.name === 'string' && typeof t.token === 'string');
}

/** Adds a token. Returns {name, createdAt} (no value; read it with loadTokens). Throws code EXISTS on duplicate. */
export function addToken(dataDir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('token name must be 1-64 chars of letters, digits, dot, dash or underscore');
  }
  const tokens = loadTokens(dataDir);
  if (tokens.some((t) => t.name === name)) {
    throw Object.assign(new Error(`token "${name}" already exists`), { code: 'EXISTS' });
  }
  const entry = { name, token: newToken(), createdAt: new Date().toISOString() };
  writeTokens(dataDir, [...tokens, entry]);
  return { name, createdAt: entry.createdAt };
}

/** Removes the named token. Returns true if one was removed. */
export function removeToken(dataDir, name) {
  const tokens = loadTokens(dataDir);
  const kept = tokens.filter((t) => t.name !== name);
  if (kept.length === tokens.length) return false;
  writeTokens(dataDir, kept);
  return true;
}

/** Returns [{name, createdAt}] — never token values. */
export function listTokens(dataDir) {
  return loadTokens(dataDir).map(({ name, createdAt }) => ({ name, createdAt }));
}

/** Parses a Cookie header into {name: value}. First occurrence wins; undecodable values kept raw. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key || Object.hasOwn(out, key)) continue;
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep raw */ }
    out[key] = value;
  }
  return out;
}

/** Constant-time comparison against every token; returns the matching name or null. */
function matchToken(candidate, tokens) {
  const c = Buffer.from(candidate, 'utf8');
  let found = null;
  for (const t of tokens) {
    const b = Buffer.from(String(t.token), 'utf8');
    if (b.length === c.length && crypto.timingSafeEqual(b, c) && found === null) found = t.name;
  }
  return found;
}

// ---------- Tailscale identity (docs/evidence/tailscale-auth/PLAN.md) ----------
// `tailscale serve` terminates TLS on the tailnet, authenticates the device, strips any Tailscale-*
// headers the client sent, and proxies to the hub from loopback with the tailnet user's identity in
// these headers. Only the login is trusted, and only when the peer is loopback: a request from any
// other address carrying the header is a spoof (the hub binds loopback, so none can arrive, but the
// check stands on its own).
export const TS_LOGIN_HEADER = 'tailscale-user-login';
export const TS_NAME_PREFIX = 'ts:';
const TS_HEADER_RE = /^[\x21-\x7e]+$/;

/** 127.0.0.0/8, ::1, or an IPv4-mapped 127.x address. Anything else (including undefined) is false. */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr === '') return false;
  const a = addr.toLowerCase();
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(v4);
}

/**
 * The Tailscale identity of a request, if it may be trusted.
 * @param {{headers?:object, socket?:{remoteAddress?:string}}} req
 * @param {{enabled?:boolean, allow?:string[]}} [tsAuth] validated config (normalizeTailscaleAuth)
 * @returns {{name:string, login:string, via:'tailscale'} | {reason:string}}
 */
export function tailscaleIdentity(req, tsAuth) {
  const allow = Array.isArray(tsAuth?.allow) ? tsAuth.allow : [];
  if (tsAuth?.enabled !== true || allow.length === 0) return { reason: 'tailscale auth disabled' };
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return { reason: 'not from loopback' };
  const raw = req?.headers?.[TS_LOGIN_HEADER];
  if (typeof raw !== 'string' || raw.trim() === '') return { reason: `no ${TS_LOGIN_HEADER} header` };
  // Printable ASCII only (review F1): a login is an email; anything else is never compared.
  if (!TS_HEADER_RE.test(raw.trim())) return { reason: `invalid ${TS_LOGIN_HEADER} header` };
  const login = raw.trim().toLowerCase();
  if (!allow.includes(login)) return { reason: 'not in tailscaleAuth.allow' };
  return { name: `${TS_NAME_PREFIX}${login}`, login, via: 'tailscale' };
}

/**
 * Checks cookie `cw_token`, then URL query `t` (cookie wins when both are valid; a stale cookie
 * falls through to a valid query token), then, with `tailscaleAuth` given, the Tailscale identity
 * (tailscaleIdentity). Returns {name, via:'cookie'|'query'|'tailscale', login?} or null.
 * @param {{headers?:object, url?:string, socket?:object}} req
 * @param {Array<{name:string, token:string}>} tokens as returned by loadTokens()
 * @param {{tailscaleAuth?:{enabled:boolean, allow:string[]}}} [o]
 */
export function authenticate(req, tokens, { tailscaleAuth } = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length > 0) {
    const cookie = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    if (cookie) {
      const name = matchToken(cookie, list);
      if (name !== null) return { name, via: 'cookie' };
    }
    let query = null;
    try { query = new URL(req?.url || '/', 'http://localhost').searchParams.get('t'); } catch { query = null; }
    if (query) {
      const name = matchToken(query, list);
      if (name !== null) return { name, via: 'query' };
    }
  }
  if (tailscaleAuth) {
    const id = tailscaleIdentity(req, tailscaleAuth);
    if (id.name) return id;
  }
  return null;
}

export function cookieHeader(token, { secure = false } = {}) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

export function isSecure(req) {
  return req?.headers?.['x-forwarded-proto'] === 'https';
}
