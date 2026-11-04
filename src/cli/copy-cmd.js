// `cw copy [--label <text>] [--session <n|id>] [<text...>]`: puts exact text in the session's
// snippet tray, where the phone copies it with one tap (agent CLIs hard-wrap long lines, so copying
// a command out of the terminal itself breaks it). Run by an agent inside a cw session: the hub sets
// CW_SESSION_ID and CW_HUB_PORT in every session's environment (spawn-env.js), so the snippet goes
// to that session on that hub. The text is the arguments joined by spaces, else stdin (without its
// trailing line breaks, so a paste does not run the command by itself).
import { api, hubPort, CliError } from './client.js';

const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };
const TARGET_RE = /^(?:[1-9]\d{0,8}|[0-9a-f]{8})$/;
const validPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;

/** stdin as sent, minus a UTF-8 BOM and the trailing line breaks. */
export function stdinText(raw) {
  return String(raw).replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/** The session to post to: --session, else CW_SESSION_ID. @throws CliError when neither is usable */
function targetSession(parsed, env) {
  if (parsed.session !== undefined) return parsed.session;
  const id = env.CW_SESSION_ID;
  if (!id) throw new CliError('not inside a cw session (CW_SESSION_ID is not set); pass --session <n|id> (see: cw ls)');
  if (!TARGET_RE.test(id)) throw new CliError(`CW_SESSION_ID is not a session id (${String(id).slice(0, 20)}); pass --session <n|id>`);
  return id;
}

/** CW_HUB_PORT (the hub that started this session), else the configured port (CW_PORT, config.json). */
function targetPort(env) {
  const p = Number(env.CW_HUB_PORT);
  return env.CW_HUB_PORT && validPort(p) ? p : hubPort();
}

export async function run(parsed, io = defaultIo, { env = process.env, stdin = process.stdin, fetchImpl } = {}) {
  const session = targetSession(parsed, env);
  let text = parsed.text;
  if (text === undefined) {
    if (stdin.isTTY) throw new CliError('nothing to copy: give the text as arguments or pipe it in (... | cw copy)');
    text = stdinText(await readAll(stdin));
  }
  if (text.trim() === '') throw new CliError('nothing to copy (the text is empty)');
  const body = { text };
  if (parsed.label !== undefined) body.label = parsed.label;
  let r;
  try {
    r = await api('POST', `/api/sessions/${session}/snippets`, body, { port: targetPort(env), fetchImpl });
  } catch (e) {
    if (e instanceof CliError && e.status === 404) throw new CliError(`no running session ${session} (see: cw ls)`);
    throw e;
  }
  io.out(`cw: snippet added to session #${r?.index ?? '?'} (${r?.bytes ?? text.length} bytes${r?.label ? `, "${r.label}"` : ''}); tap Copy in its snippet tray`);
  return 0;
}
