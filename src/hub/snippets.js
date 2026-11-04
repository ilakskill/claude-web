// Snippet tray: exact text a session wants the user to copy on the phone (a command, a path, a
// code block). Copying from the terminal itself fails there because agent CLIs hard-wrap long lines.
// Two sources: `cw copy` (POST /api/sessions/<id>/snippets, server.js) and OSC 52 clipboard writes
// in the PTY output (session.js). Each session keeps the newest SNIPPET_KEEP in memory only; they
// reach attached clients as {t:'snippet'} and are replayed after init as {t:'snippets'}.
// The text is the program's (untrusted): it is never logged, and the web UI shows it as text only.

export const SNIPPET_MAX_BYTES = 64 * 1024; // UTF-8 bytes of one snippet's text
export const SNIPPET_KEEP = 10; // per session, newest kept
export const LABEL_MAX = 40;
export const OSC52_LABEL = 'clipboard';

/** A label worth showing (control characters removed, whitespace collapsed, cut to LABEL_MAX), or null. */
export function normalizeLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
}

class SnippetError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Checks a POST body {text, label?}. The text is kept exactly as sent (no trimming: it is what the
 * user pastes). @returns {{text:string, label:string|null}} @throws SnippetError with an HTTP status
 */
export function validateSnippet(body) {
  const { text, label } = body || {};
  if (typeof text !== 'string' || text.trim() === '') throw new SnippetError(400, 'text must be a non-empty string');
  if (Buffer.byteLength(text, 'utf8') > SNIPPET_MAX_BYTES) throw new SnippetError(413, `text too large (${SNIPPET_MAX_BYTES / 1024} KB max)`);
  if (label !== undefined && label !== null && typeof label !== 'string') throw new SnippetError(400, 'label must be a string');
  return { text, label: normalizeLabel(label) };
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Base64 longer than this cannot decode to SNIPPET_MAX_BYTES or less.
const B64_MAX = Math.ceil(SNIPPET_MAX_BYTES / 3) * 4;

/**
 * The text of an OSC 52 clipboard write, given the OSC payload after `52;` (xterm's
 * registerOscHandler(52) data): `<selection>;<base64>`. Null for the query form (`?`), a clear
 * (empty data), malformed or non-UTF-8 base64, blank text, or text over SNIPPET_MAX_BYTES.
 */
export function parseOsc52(data) {
  if (typeof data !== 'string') return null;
  const i = data.indexOf(';');
  if (i < 0) return null;
  const sel = data.slice(0, i);
  const b64 = data.slice(i + 1);
  if (!/^[cpqs0-7]*$/.test(sel)) return null;
  if (b64 === '' || b64 === '?' || b64.length > B64_MAX) return null;
  if (!B64_RE.test(b64) || b64.length % 4 === 1 || (b64.includes('=') && b64.length % 4 !== 0)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > SNIPPET_MAX_BYTES) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  return text.trim() === '' ? null : text;
}
