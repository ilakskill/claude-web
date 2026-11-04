// `cw hooks install|uninstall [--harness claude|gemini|codex]`: adds/removes the hooks that run
// `cw hook`: Notification, Stop and PreToolUse[AskUserQuestion] in <claudeHome>/settings.json
// (CW_CLAUDE_HOME overrides ~/.claude); Notification and AfterAgent in <geminiHome>/settings.json
// (CW_GEMINI_HOME); Stop in <codexHome>/hooks.json (CW_CODEX_HOME). Always backs up first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, geminiHome, codexHome } from '../hub/config.js';
import { writeFileAtomic } from '../hub/util.js';
import { cwJsPath, CliError } from './client.js';

/**
 * One entry per hook event. `matcher` limits a tool event to one tool: PreToolUse fires for every
 * tool call, and only AskUserQuestion (a clarifying question Claude waits on) is a "needs input".
 * The hook prints nothing and exits 0, which for PreToolUse means "no decision": the tool runs.
 */
export const HOOK_SPECS = Object.freeze([
  Object.freeze({ event: 'Notification' }),
  Object.freeze({ event: 'Stop' }),
  Object.freeze({ event: 'PreToolUse', matcher: 'AskUserQuestion' }),
]);
export const HOOK_EVENTS = HOOK_SPECS.map((s) => s.event);
export const HOOK_LABELS = HOOK_SPECS.map((s) => (s.matcher ? `${s.event}[${s.matcher}]` : s.event));

// Gemini CLI (~/.gemini/settings.json) and Codex (~/.codex/hooks.json) read the same
// `{hooks:{<Event>:[{hooks:[{type:'command',command,timeout}]}]}}` shape as Claude Code. Gemini's
// timeout is in milliseconds, Claude's and Codex's in seconds. No matcher: every event of the kind.
export const GEMINI_SPECS = Object.freeze([
  Object.freeze({ event: 'Notification', timeout: 5000 }),
  Object.freeze({ event: 'AfterAgent', timeout: 5000 }),
]);
export const CODEX_SPECS = Object.freeze([Object.freeze({ event: 'Stop' })]);

/** Where `cw hooks install --harness <id>` writes and which events it adds. */
export const HARNESS_TARGETS = Object.freeze({
  claude: Object.freeze({ label: 'Claude Code', specs: HOOK_SPECS, file: () => path.join(claudeHome(), 'settings.json'), name: 'settings.json' }),
  gemini: Object.freeze({ label: 'Gemini CLI', specs: GEMINI_SPECS, file: () => path.join(geminiHome(), 'settings.json'), name: 'settings.json' }),
  codex: Object.freeze({ label: 'Codex', specs: CODEX_SPECS, file: () => path.join(codexHome(), 'hooks.json'), name: 'hooks.json' }),
});
const specOf = (specs, ev) => specs.find((s) => s.event === ev);
const specLabel = (s) => (s.matcher ? `${s.event}[${s.matcher}]` : s.event);
/** A new cw hook group for `ev`: `{matcher?, hooks:[...]}` (matcher first, as Claude Code writes it). */
const cwGroup = (specs, ev, command) => {
  const spec = specOf(specs, ev);
  return { ...(spec?.matcher ? { matcher: spec.matcher } : {}), hooks: [{ type: 'command', command, timeout: spec?.timeout ?? 5 }] };
};
export const CW_MARKER = 'cw.js" hook';
const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

// The hook command must survive whichever shell Claude Code uses on Windows (Git Bash `sh -c`,
// `cmd.exe /c` with or without /s, PowerShell). Form: `<node> "<cw.js>" hook`, forward slashes.
//  - node is unquoted: `cmd /c` without /s strips the first and last quote of a line that starts
//    with a quote (so `"node" "cw.js" hook` breaks), and PowerShell treats a leading "..." as a
//    string, not a command. A node path with spaces is replaced by its 8.3 short path.
//  - forward slashes: sh eats unquoted backslashes; cmd, PowerShell and node accept `/`.
//  - cw.js stays double-quoted (the repo path may contain spaces; this also keeps CW_MARKER).
// Verified by test/integration/hook-shells.test.js.
const BARE_SAFE = /^[A-Za-z0-9:/._~+-]+$/; // needs no quoting in cmd, sh or PowerShell
const QUOTED_SAFE = /^[^"%$`!\\]+$/; // nothing inside "..." that sh or cmd would expand
const fwd = (p) => String(p).replace(/\\/g, '/');

/** 8.3 short path of an existing file or directory (Windows), or null. */
export function shortPath(p) {
  if (process.platform !== 'win32' || /["%^&|<>()!]/.test(p)) return null;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`],
      { windowsVerbatimArguments: true, windowsHide: true, timeout: 3000 }).toString().trim();
    return out && !/\s/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function hookCommand(execPath = process.execPath, cwJs = cwJsPath, { toShort = shortPath } = {}) {
  let node = fwd(execPath);
  if (!BARE_SAFE.test(node)) {
    const s = toShort(execPath);
    node = s && BARE_SAFE.test(fwd(s)) ? fwd(s) : `"${node}"`; // last resort: works in sh and cmd /s only
  }
  let script = fwd(cwJs);
  if (!QUOTED_SAFE.test(script)) {
    const s = toShort(cwJs);
    if (s && QUOTED_SAFE.test(fwd(s))) script = fwd(s);
  }
  return `${node} "${script}" hook`;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

const isCwHook = (h) => h && typeof h.command === 'string' && h.command.includes(CW_MARKER);
const groupHasCw = (g) => g && Array.isArray(g.hooks) && g.hooks.some(isCwHook);
// A legacy flat entry ({type, command} directly in the event array, no `hooks` group) holding cw.
const isFlatCw = (g) => g && !Array.isArray(g.hooks) && isCwHook(g);
const hasCw = (g) => groupHasCw(g) || isFlatCw(g);
const BOM = String.fromCharCode(0xfeff);

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: null, data: {} };
    throw new CliError(`cannot read ${file}: ${e.message}`);
  }
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { throw new CliError(`${file} is not valid JSON (${e.message}); not modified`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError(`${file} is not a JSON object; not modified`);
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks))) {
    throw new CliError(`${file}: "hooks" is not an object; not modified`);
  }
  return { raw, data };
}

/** Copies the current bytes to settings.json.bak-<stamp> (never overwrites). Returns the path or null. */
function backup(file, raw, now) {
  if (raw === null) return null;
  let bak = `${file}.bak-${stamp(now)}`;
  for (let i = 1; fs.existsSync(bak); i++) bak = `${file}.bak-${stamp(now)}-${i}`;
  fs.writeFileSync(bak, raw, { flag: 'wx' });
  return bak;
}

/** Writes JSON keeping the original file's UTF-8 BOM, line endings (CRLF or LF) and final newline. */
function write(file, data, raw) {
  const crlf = raw !== null && raw.includes('\r\n');
  const nl = crlf ? '\r\n' : '\n';
  const trailing = raw === null || /\n$/.test(raw) ? nl : '';
  let text = JSON.stringify(data, null, 2) + trailing;
  if (crlf) text = text.replace(/\r?\n/g, '\r\n'); // (JSON.stringify escapes newlines inside strings)
  if (raw !== null && raw.startsWith(BOM)) text = BOM + text;
  writeFileAtomic(file, text);
}

/**
 * Adds the cw hook to events lacking one; rewrites in place a cw hook whose command differs from
 * `command` (stale node/cw.js path). An identical entry is left alone (idempotent).
 * @returns {{changed:boolean, backup:string|null, added:string[], updated:string[]}}
 */
export function installHooks(file, { command = hookCommand(), now = new Date(), specs = HOOK_SPECS } = {}) {
  const { raw, data } = readSettings(file);
  const hooks = data.hooks ?? {};
  const events = specs.map((s) => s.event);
  for (const ev of events) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) throw new CliError(`${file}: "hooks.${ev}" is not an array; not modified`);
  }
  // "Installed" means a cw entry in the group for our matcher: a cw hook someone put under another
  // PreToolUse matcher (or none) is not ours. A legacy flat entry has no matcher and is rewritten
  // below into a group with the right one, so it counts.
  const isOurs = (ev, g) => hasCw(g) && (isFlatCw(g) || !specOf(specs, ev)?.matcher || g.matcher === specOf(specs, ev).matcher);
  const added = events.filter((ev) => !(hooks[ev] || []).some((g) => isOurs(ev, g)));
  const isStale = (h) => isCwHook(h) && h.command !== command;
  const updated = events.filter((ev) => (hooks[ev] || []).some((g) => isFlatCw(g) || (groupHasCw(g) && g.hooks.some(isStale))));
  if (added.length === 0 && updated.length === 0) return { changed: false, backup: null, added, updated };
  const bak = backup(file, raw, now);
  data.hooks = hooks;
  for (const ev of updated) {
    // Stale node or cw.js path: rewrite the command in place, keeping the entry's position and other
    // fields. A legacy flat entry becomes a proper group (same position).
    hooks[ev] = hooks[ev].map((g) => {
      if (isFlatCw(g)) return cwGroup(specs, ev, command);
      return groupHasCw(g) ? { ...g, hooks: g.hooks.map((h) => (isStale(h) ? { ...h, command } : h)) } : g;
    });
  }
  for (const ev of added) {
    hooks[ev] = [...(hooks[ev] || []), cwGroup(specs, ev, command)];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, data, raw);
  return { changed: true, backup: bak, added, updated };
}

/**
 * Removes only hook entries whose command contains `cw.js" hook`; drops groups and event arrays
 * that this emptied. @returns {{changed:boolean, backup:string|null, removed:number}}
 */
export function uninstallHooks(file, { now = new Date() } = {}) {
  const { raw, data } = readSettings(file);
  if (raw === null || !data.hooks) return { changed: false, backup: null, removed: 0 };
  let removed = 0;
  const next = {};
  for (const [ev, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) { next[ev] = groups; continue; }
    const kept = [];
    for (const g of groups) {
      if (isFlatCw(g)) { removed += 1; continue; }
      if (!groupHasCw(g)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isCwHook(h));
      removed += g.hooks.length - rest.length;
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (kept.length || groups.length === 0) next[ev] = kept;
  }
  if (removed === 0) return { changed: false, backup: null, removed };
  const bak = backup(file, raw, now);
  data.hooks = next;
  write(file, data, raw);
  return { changed: true, backup: bak, removed };
}

export const settingsPath = () => HARNESS_TARGETS.claude.file();

export async function run(parsed, io = defaultIo) {
  const target = HARNESS_TARGETS[parsed.harness ?? 'claude'];
  if (!target) throw new CliError(`unknown harness for hooks: ${parsed.harness} (claude, gemini or codex)`);
  const file = target.file();
  const flag = parsed.harness && parsed.harness !== 'claude' ? ` --harness ${parsed.harness}` : '';
  if (parsed.sub === 'install') {
    const names = target.specs.map(specLabel);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    io.out(`cw: warning: modifying ${file} (adds ${list} hooks that run cw hook; undo: cw hooks uninstall${flag})`);
    const r = installHooks(file, { specs: target.specs });
    if (!r.changed) { io.out(`cw: hooks already installed; ${target.name} not modified`); return 0; }
    io.out(r.backup ? `cw: backup: ${r.backup}` : `cw: ${file} did not exist; created it (no backup needed)`);
    const label = (ev) => { const s = specOf(target.specs, ev); return s ? specLabel(s) : ev; };
    if (r.added.length) io.out(`cw: added hooks: ${r.added.map(label).join(', ')}`);
    if (r.updated.length) io.out(`cw: updated stale cw hook command in: ${r.updated.join(', ')}`);
    return 0;
  }
  if (parsed.sub === 'uninstall') {
    io.out(`cw: warning: modifying ${file} (removes only the cw hook entries)`);
    const r = uninstallHooks(file);
    if (!r.changed) { io.out(`cw: no cw hooks found; ${target.name} not modified`); return 0; }
    io.out(`cw: backup: ${r.backup}`);
    io.out(`cw: removed ${r.removed} hook entr${r.removed === 1 ? 'y' : 'ies'}`);
    return 0;
  }
  throw new Error(`unhandled hooks subcommand ${parsed.sub}`);
}
