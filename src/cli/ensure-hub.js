// Starts the hub in the background when nothing is listening on its port.
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { dataDir } from '../hub/config.js';
import { hubPort, probeHealth, hubJsPath, repoRoot, CliError, HOST } from './client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [o]
 * @param {number} [o.port]
 * @param {Function} [o.fetchImpl]  injected for tests
 * @param {Function} [o.spawnImpl]  injected for tests (child_process.spawn signature)
 * @param {number} [o.timeoutMs=5000] how long to wait for a spawned (or unresponsive) hub
 * @param {number} [o.pollMs=100]
 * @returns {Promise<{port:number, started:boolean, health:object}>}
 */
export async function ensureHub({
  port = hubPort(), fetchImpl = fetch, spawnImpl = nodeSpawn, timeoutMs = 5000, pollMs = 100,
} = {}) {
  const logPath = path.join(dataDir(), 'hub.log');
  const foreign = (reason) => new CliError(`port ${port} is used by another program (${reason}); `
    + 'free it or set a different port in config.json / CW_PORT');
  const unresponsive = () => new CliError(`port ${port} is in use but not answering (unresponsive for ${timeoutMs / 1000} s). `
    + `If it is the cw hub, it may be busy or hung: see ${logPath}, or restart it (cw hub stop --force, cw hub start); `
    + 'otherwise free the port or set a different one in config.json / CW_PORT');
  const first = await probeHealth(port, { fetchImpl });
  if (first.state === 'cw') return { port, started: false, health: first.health };
  if (first.state === 'foreign') throw foreign(first.reason);

  // Unresponsive: something holds the port (maybe a busy or still-starting hub). Do not spawn a
  // second hub; wait for it to answer.
  let spawnError = null;
  const spawned = first.state === 'refused';
  if (spawned) {
    const child = spawnImpl(process.execPath, [hubJsPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
      cwd: repoRoot, // never pin the user's current directory for the hub's lifetime
    });
    child.on?.('error', (e) => { spawnError = e; });
    child.unref?.();
  }

  const deadline = Date.now() + timeoutMs;
  let last = first;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (spawnError) throw new CliError(`could not start the hub: ${spawnError.message}`);
    last = await probeHealth(port, { fetchImpl, timeoutMs: 1000 });
    if (last.state === 'cw') return { port, started: spawned, health: last.health };
    if (last.state === 'foreign') throw foreign(last.reason);
  }
  if (last.state === 'unresponsive') throw unresponsive();
  throw new CliError(`hub did not start on ${HOST}:${port} within ${timeoutMs / 1000} s; see ${logPath}`);
}
