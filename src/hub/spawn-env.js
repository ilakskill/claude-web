// Builds the child environment for a session. Windows env names are case-insensitive, so all
// matching is case-insensitive. Spike C: a stale user-scope CLAUDE_CODE_OAUTH_TOKEN breaks auth,
// and a hub started from inside a Claude session inherits nested-session markers.

export const DEFAULT_STRIP_ENV = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  // Set in processes started by a Claude Code session; inherited by a hub started from one, it makes
  // every session run with transcript saving off, so Resume has nothing to resume (Task 8 ruling).
  'CLAUDE_CODE_CHILD_SESSION',
]);

/** Never stripped, whatever config.stripEnv says (a stray '*' would otherwise break every session). */
export const PROTECTED_ENV = Object.freeze(['PATH', 'SYSTEMROOT', 'USERPROFILE']);

/**
 * A strip entry ending in '*' is a case-insensitive prefix match; otherwise exact (case-insensitive).
 * PROTECTED_ENV names never match.
 */
function makeMatcher(strip) {
  const exact = new Set();
  const prefixes = [];
  for (const s of strip) {
    const u = String(s).toUpperCase();
    if (u.endsWith('*')) prefixes.push(u.slice(0, -1));
    else exact.add(u);
  }
  return (key) => {
    const u = key.toUpperCase();
    if (PROTECTED_ENV.includes(u)) return false;
    return exact.has(u) || prefixes.some((p) => u.startsWith(p));
  };
}

/**
 * config.stripEnv as a list: a non-array value (e.g. a string typed by hand) falls back to
 * DEFAULT_STRIP_ENV with a WARN instead of failing every session start (final review M8).
 */
export function normalizeStripEnv(value, log) {
  if (Array.isArray(value)) return value;
  if (value !== undefined && value !== null) {
    log?.warn(`config.stripEnv must be an array of names, got ${typeof value}; using the default list (${DEFAULT_STRIP_ENV.join(', ')})`);
  }
  return DEFAULT_STRIP_ENV;
}

/**
 * @returns {Record<string,string>} a new object; baseEnv is not modified.
 */
export function buildSpawnEnv(baseEnv, { sessionId, hubPort, strip = DEFAULT_STRIP_ENV, log } = {}) {
  const drop = makeMatcher([...normalizeStripEnv(strip, log), 'CW_SESSION_ID', 'CW_HUB_PORT']);
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined || drop(k)) continue;
    env[k] = v;
  }
  if (sessionId != null) env.CW_SESSION_ID = String(sessionId);
  if (hubPort != null) env.CW_HUB_PORT = String(hubPort);
  return env;
}
