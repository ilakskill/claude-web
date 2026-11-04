// WebSocket framing: binary frames are raw PTY bytes (both directions); text frames are JSON
// control messages with a string `t` field.

export const INIT = 'init';
export const RESIZE = 'resize';
export const EXIT = 'exit';
export const PING = 'ping';
export const PONG = 'pong';
export const SESSIONS = 'sessions';
// Snippet tray (snippets.js): one new snippet {t, id, label, text, at, source}, and after init the
// session's current ones {t, snippets: [...]} (oldest first; sent only when there are any).
export const SNIPPET = 'snippet';
export const SNIPPETS = 'snippets';

export function encodeControl(obj) {
  return JSON.stringify(obj);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer)); // ws fragments
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError('unsupported message data type');
}

/**
 * @returns {{kind:'input', bytes:Buffer} | {kind:'control', msg:object}}
 * @throws on malformed JSON or a control message without a string `t`.
 */
export function decodeMessage(data, isBinary) {
  if (isBinary) return { kind: 'input', bytes: toBuffer(data) };
  const text = typeof data === 'string' ? data : toBuffer(data).toString('utf8');
  const msg = JSON.parse(text);
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
    throw new Error('control message must be a JSON object with a string t field');
  }
  return { kind: 'control', msg };
}
