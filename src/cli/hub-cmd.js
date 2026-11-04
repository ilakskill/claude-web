// `cw hub status|start|stop [--force]|install|uninstall`.
import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { dataDir } from '../hub/config.js';
import { api, hubPort, probeHealth, hubJsPath, CliError, HOST } from './client.js';
import { ensureHub } from './ensure-hub.js';

export const TASK_NAME = 'cw-hub';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** Runs a PowerShell script via -EncodedCommand (no command-line quoting pitfalls). */
export function runPwsh(script, { execFileImpl = nodeExecFile, timeoutMs = 60_000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFileImpl('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (err && typeof err.code !== 'number' ? err.message : ''),
      }));
  });
}

/** Exit code of `schtasks /query /tn cw-hub` (0 = installed). */
function schtasksQuery({ execFileImpl = nodeExecFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('schtasks', ['/query', '/tn', TASK_NAME], { windowsHide: true, timeout: 10_000 },
      (err) => resolve(err ? (typeof err.code === 'number' ? err.code : -1) : 0));
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const vbsPath = (dir = dataDir()) => path.join(dir, 'hub-start.vbs');

export const RELAUNCH_MAX_ATTEMPTS = 20;
export const RELAUNCH_DELAY_MS = 5000;
export const RELAUNCH_RESET_S = 60;

/**
 * hub-start.vbs: a relaunch loop around `"<node>" "<hub.js>"` (hidden window, waits for it).
 *  - exit code 0 (`cw hub stop`, or "a cw hub is already running") ends the loop: Quit 0;
 *  - anything else (crash, killed) reruns the hub after 5 s;
 *  - node.exe or hub.js missing (Run raises): Quit 2 at once, so the task records a failure;
 *  - at most 20 attempts in a row; a run that lasted 60 s or more resets the count, so only a hub
 *    that keeps failing at startup gives up. Then it quits with the last exit code.
 * Task Scheduler's RestartOnFailure does not restart a task whose action exited non-zero
 * (observed in Task 7), so the loop does it. The task stays Running while the loop runs.
 */
export function vbsContent(execPath = process.execPath, hubJs = hubJsPath, {
  maxAttempts = RELAUNCH_MAX_ATTEMPTS, delayMs = RELAUNCH_DELAY_MS, resetS = RELAUNCH_RESET_S,
} = {}) {
  return [
    "' cw hub launcher, written by `cw hub install`. Relaunches the hub unless it exits 0.",
    'Option Explicit',
    'Dim sh, cmd, code, attempts, started',
    'Set sh = CreateObject("WScript.Shell")',
    `cmd = """${execPath}"" ""${hubJs}"""`,
    'attempts = 0',
    'Do',
    '  attempts = attempts + 1',
    '  started = Now',
    // A missing node.exe or hub.js makes Run raise instead of returning a code: without this the
    // script would abort (error dialog, exit 0) and Task Scheduler would record success.
    '  On Error Resume Next',
    '  code = sh.Run(cmd, 0, True)',
    '  If Err.Number <> 0 Then WScript.Quit 2',
    '  On Error GoTo 0',
    '  If code = 0 Then WScript.Quit 0',
    `  If DateDiff("s", started, Now) >= ${resetS} Then attempts = 1`,
    `  If attempts >= ${maxAttempts} Then WScript.Quit code`,
    `  WScript.Sleep ${delayMs}`,
    'Loop',
    '',
  ].join('\r\n');
}

/** Plain ASCII when possible, else UTF-16LE with BOM (both are read by wscript). */
function vbsBytes(text) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

export function registerScript(vbs) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(`"${vbs}"`)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 '
      + '-RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries '
      + '-DontStopIfGoingOnBatteries -StartWhenAvailable',
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings `
      + '-RunLevel Limited -Force | Out-Null',
    `Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}`,
  ].join('\n');
}

export const exportScript = () => "$ErrorActionPreference = 'Stop'\n"
  + `([xml](Export-ScheduledTask -TaskName ${psQuote(TASK_NAME)})).Task.Settings.ExecutionTimeLimit`;

export const unregisterScript = () => "$ErrorActionPreference = 'Stop'\n"
  + `if (Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue) {\n`
  + `  Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false\n  'removed'\n} else { 'absent' }`;

async function waitHealth(port, want, { timeoutMs, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await probeHealth(port, { fetchImpl, timeoutMs: 1000 });
    if (want(p)) return p;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

async function status(io, deps) {
  const port = hubPort();
  const [p, task] = await Promise.all([probeHealth(port, deps), schtasksQuery(deps)]);
  let pid = '-';
  try { pid = fs.readFileSync(path.join(dataDir(), 'hub.pid'), 'utf8').trim() || '-'; } catch { /* none */ }
  if (p.state === 'cw') {
    const h = p.health;
    io.out(`hub: running on ${HOST}:${port} (version ${h.version}, ${h.sessions} running session(s), up ${h.uptime} s)`);
  } else if (p.state === 'refused') {
    io.out(`hub: not running (port ${port})`);
  } else if (p.state === 'unresponsive') {
    io.out(`hub: port ${port} is in use but not answering (${p.reason}); a busy or hung hub? see ${path.join(dataDir(), 'hub.log')}`);
  } else {
    io.out(`hub: port ${port} is used by another program (${p.reason})`);
  }
  io.out(`pid: ${pid}${p.state !== 'cw' && pid !== '-' ? ' (stale pid file)' : ''}`);
  io.out(`scheduled task ${TASK_NAME}: ${task === 0 ? 'installed' : 'not installed'}`);
  return p.state === 'cw' ? 0 : 1;
}

async function start(io, deps) {
  const r = await ensureHub(deps);
  io.out(r.started ? `cw: started hub on ${HOST}:${r.port}` : `cw: hub already running on ${HOST}:${r.port}`);
  return 0;
}

async function stop(force, io, deps) {
  const port = hubPort();
  const p = await probeHealth(port, deps);
  if (p.state === 'refused') { io.out('cw: hub is not running'); return 0; }
  if (p.state === 'foreign') throw new CliError(`port ${port} is used by another program (${p.reason})`);
  if (p.state === 'unresponsive') {
    throw new CliError(`port ${port} is in use but not answering (${p.reason}); if the hub is hung, end its node.exe `
      + `(pid in ${path.join(dataDir(), 'hub.pid')}) in Task Manager`);
  }
  try {
    await api('POST', '/api/hub/stop', { force }, { port, fetchImpl: deps.fetchImpl });
  } catch (e) {
    if (e.status === 409) {
      const n = e.body?.running ?? '?';
      io.err(`cw: ${n} session(s) still running; to stop the hub and kill them: cw hub stop --force`);
      return 1;
    }
    throw e;
  }
  const down = await waitHealth(port, (x) => x.state === 'refused', { timeoutMs: 10_000, fetchImpl: deps.fetchImpl });
  if (!down) { io.err('cw: the hub accepted the stop request but is still answering after 10 s'); return 1; }
  io.out('cw: hub stopped');
  return 0;
}

/**
 * Refuses while a hub answers: under `-MultipleInstances IgnoreNew` a running task instance keeps
 * its old relaunch loop (the new vbs is ignored), and a new instance next to a hub started by `cw`
 * exits 0 at once ("already running"), leaving no relaunch loop at all (final review M1).
 */
async function install(io, deps) {
  const prePort = hubPort();
  const pre = await probeHealth(prePort, deps);
  if (pre.state === 'cw' || pre.state === 'unresponsive') {
    io.err(`cw: a hub is running on ${HOST}:${prePort}; install cannot replace it (a running task keeps its old `
      + 'launcher, and a hub started by cw would leave the task without a relaunch loop)');
    io.err('cw: stop it first (--force kills running sessions; list them with: cw ls), then install:');
    io.err('  cw hub stop --force');
    io.err('  cw hub install');
    return 1;
  }
  io.out(`cw: warning: this creates a persistent Windows logon task "${TASK_NAME}" that starts the hub hidden `
    + 'at every logon (undo: cw hub uninstall)');
  const pwsh = deps.runPwsh || runPwsh;
  const vbs = vbsPath();
  fs.writeFileSync(vbs, vbsBytes(vbsContent()));
  io.out(`cw: wrote ${vbs}`);
  const reg = await pwsh(registerScript(vbs));
  if (reg.code !== 0) throw new CliError(`Register-ScheduledTask failed (exit ${reg.code}): ${reg.stderr.trim() || reg.stdout.trim()}`);
  io.out(`cw: registered and started scheduled task ${TASK_NAME}`);
  const port = hubPort();
  const up = await waitHealth(port, (x) => x.state === 'cw', { timeoutMs: deps.healthTimeoutMs ?? 10_000, fetchImpl: deps.fetchImpl });
  let code = 0;
  if (up) io.out(`cw: hub is running on ${HOST}:${port}`);
  else { io.err(`cw: hub did not answer on ${HOST}:${port} within 10 s; see ${path.join(dataDir(), 'hub.log')}`); code = 1; }
  const exp = await pwsh(exportScript());
  const limit = exp.stdout.trim();
  if (exp.code !== 0) { io.err(`cw: could not read the task XML: ${exp.stderr.trim()}`); return 1; }
  io.out(`cw: task ExecutionTimeLimit = ${limit}`);
  if (limit !== 'PT0S') { io.err('cw: expected PT0S (no time limit); the hub would be stopped after that time'); return 1; }
  return code;
}

async function uninstall(io, deps) {
  io.out(`cw: warning: removing the Windows logon task "${TASK_NAME}" (a running hub keeps running; stop it with: cw hub stop)`);
  const pwsh = deps.runPwsh || runPwsh;
  const r = await pwsh(unregisterScript());
  if (r.code !== 0) throw new CliError(`Unregister-ScheduledTask failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  io.out(r.stdout.trim() === 'absent' ? `cw: scheduled task ${TASK_NAME} was not installed` : `cw: removed scheduled task ${TASK_NAME}`);
  const vbs = vbsPath();
  if (fs.existsSync(vbs)) { fs.rmSync(vbs, { force: true }); io.out(`cw: deleted ${vbs}`); }
  return 0;
}

/** deps (tests): {fetchImpl, spawnImpl, execFileImpl, runPwsh, healthTimeoutMs} */
export async function run(parsed, io = defaultIo, deps = {}) {
  switch (parsed.sub) {
    case 'status': return status(io, deps);
    case 'start': return start(io, deps);
    case 'stop': return stop(parsed.force === true, io, deps);
    case 'install': return install(io, deps);
    case 'uninstall': return uninstall(io, deps);
    default: throw new Error(`unhandled hub subcommand ${parsed.sub}`);
  }
}
