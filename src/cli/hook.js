// `cw hook`: run by Claude Code for the Notification, Stop and PreToolUse[AskUserQuestion] hooks.
// Reads the hook JSON from stdin, adds cwSessionId (CW_SESSION_ID, set by the hub for sessions it
// started) and POSTs it to the hub. It must never block or disturb Claude: 2 s request timeout,
// every error swallowed, nothing on stdout (for PreToolUse an empty stdout is "no decision", so
// the tool always runs), always exit 0. stderr only when CW_DEBUG=1.
import fs from 'node:fs';
import path from 'node:path';

const HARD_DEADLINE_MS = 4000; // settings.json gives the hook 5 s
const debug = (msg) => { if (process.env.CW_DEBUG === '1') process.stderr.write(`cw hook: ${msg}\n`); };

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

const validPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;

/** CW_HUB_PORT (set by the hub for its sessions), else CW_PORT, else config.json port, else 4242. */
export function hookPort(dir) {
  for (const v of [process.env.CW_HUB_PORT, process.env.CW_PORT]) {
    if (v !== undefined && v !== '' && validPort(Number(v))) return Number(v);
  }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).port;
    if (validPort(p)) return p;
  } catch { /* missing or corrupt: default */ }
  return 4242;
}

async function send() {
  const raw = (await readStdin()).replace(/^\uFEFF/, '').trim();
  if (!raw) { debug('empty stdin'); return; }
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { debug(`malformed JSON: ${e.message}`); return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { debug('payload is not an object'); return; }
  payload.cwSessionId = process.env.CW_SESSION_ID || null;

  // Read-only: never create the data dir, migrate it, or write config.json (this runs for every
  // Claude session on the machine, including ones for users who never ran cw).
  const { dataDirPath } = await import('../hub/config.js');
  const dir = dataDirPath();
  let tokens;
  try { tokens = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).tokens; } catch (e) { debug(`no tokens: ${e.message}`); return; }
  const token = Array.isArray(tokens) && tokens[0] && typeof tokens[0].token === 'string' ? tokens[0].token : null;
  if (!token) { debug('no token'); return; }
  const port = hookPort(dir);

  const res = await fetch(`http://127.0.0.1:${port}/api/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `cw_token=${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
  debug(`hub answered ${res.status}`);
}

export async function runHook() {
  setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();
  try {
    await send();
  } catch (e) {
    debug(`error: ${e?.cause?.code || e?.message || e}`);
  }
  process.exit(0); // do not linger on a keep-alive socket
}
