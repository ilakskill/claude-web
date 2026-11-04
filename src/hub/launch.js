// Turns "run this command" into what node-pty can start. node-pty runs a file directly, so the npm
// `.cmd` shims (copilot, gemini, codex, opencode, pi) cannot be started as they are. The shim is a
// batch file that ends in `node.exe "<dp0>\<target>" %*`; we read the target out of it and run
// `node <target> ...args` ourselves, so no cmd.exe sits in the kill chain (spike: SPIKE.md). A shim
// whose target is itself an .exe (opencode's native build) is started directly, without node.
import fs from 'node:fs';
import path from 'node:path';

const SHIM_EXTS = ['.cmd', '.bat'];
const MAX_SHIM_BYTES = 64 * 1024;
const CMD_UNSAFE = /[&|<>^%"\r\n]/;

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** Finds `<command>.cmd|.bat` on PATH (bare names only). Returns the full path or null. */
export function findShim(command, env = process.env) {
  if (/[\\/]/.test(command) || path.extname(command)) return null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of SHIM_EXTS) {
      const f = path.join(d, command + ext);
      if (isFile(f)) return f;
    }
  }
  return null;
}

/**
 * The script an npm `.cmd` shim runs: the last `"%dp0%\<relative>"` (or `%~dp0`) entry that is not
 * node.exe itself, any extension (opencode's has none). Null if the shim has no such entry or the
 * target does not exist.
 */
export function parseShimTarget(shimFile) {
  let text;
  try {
    const fd = fs.openSync(shimFile, 'r');
    try {
      const buf = Buffer.alloc(MAX_SHIM_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_SHIM_BYTES, 0);
      text = buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let target = null;
  for (const m of text.matchAll(/"%~?dp0%?\\([^"\r\n%]+)"/gi)) {
    if (/(^|\\)node(\.exe)?$/i.test(m[1])) continue;
    target = m[1];
  }
  if (!target) return null;
  const full = path.join(path.dirname(shimFile), target);
  return isFile(full) ? full : null;
}

/**
 * @param {string} file a resolved command path (from resolveCommand)
 * @param {string[]} args
 * @param {{nodePath?:string, comSpec?:string}} [o]
 * @returns {{file:string, args:string[], commandLine?:string, via:'exe'|'node-shim'|'cmd'}}
 */
export function launchFor(file, args = [], { nodePath = process.execPath, comSpec = process.env.ComSpec || 'cmd.exe' } = {}) {
  if (!SHIM_EXTS.includes(path.extname(file).toLowerCase())) return { file, args: [...args], via: 'exe' };
  const target = parseShimTarget(file);
  // A shim that wraps a native binary (opencode >= 1.19 ships bin/opencode.exe) is run directly:
  // `node <x>.exe` would try to parse the binary as JavaScript and exit 1 at once.
  if (target && /\.(exe|com)$/i.test(target)) return { file: target, args: [...args], via: 'exe' };
  if (target) return { file: nodePath, args: [target, ...args], via: 'node-shim' };
  // Best effort: ONE command line for cmd.exe, each part quoted and the whole line wrapped in
  // quotes (what /s expects). cmd metacharacters cannot be quoted safely, so they are refused.
  const parts = [file, ...args].map((a) => {
    const t = String(a);
    if (CMD_UNSAFE.test(t)) throw new Error('argument contains characters that cannot be passed through cmd.exe (& | < > ^ % " or a line break)');
    return `"${t}"`;
  });
  const line = `"${parts.join(' ')}"`;
  // commandLine: the same arguments as one string, for spawners that take a raw Windows command line
  // (node-pty given a string; execFile with windowsVerbatimArguments). Arrays get re-quoted by them.
  return { file: comSpec, args: ['/d', '/s', '/c', line], commandLine: `/d /s /c ${line}`, via: 'cmd' };
}

/**
 * Resolves `command` (a name or path) like resolveCommand, additionally finding `.cmd` / `.bat`
 * shims, and returns how to start it.
 * @param {string} command
 * @param {string[]} args
 * @param {{env?:object, cwd?:string, resolve:(c:string,env:object,cwd:string)=>string, nodePath?:string, comSpec?:string}} o
 *   `resolve` is the hub's resolveCommand (throws err.code === 'ENOENT').
 */
export function resolveLaunch(command, args, { env = process.env, cwd = process.cwd(), resolve, nodePath, comSpec } = {}) {
  let file;
  try {
    file = resolve(command, env, cwd);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    file = findShim(command, env);
    if (!file) throw e;
  }
  return { ...launchFor(file, args, { nodePath, comSpec }), command: file };
}

/** True if `command` resolves to something startable. Never throws. */
export function isAvailable(command, { env = process.env, resolve } = {}) {
  try { return !!resolveLaunch(command, [], { env, resolve }).file; } catch { return false; }
}
