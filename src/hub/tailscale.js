// Tailnet identity of this machine from `tailscale status --json` (read-only). Shared by the hub
// (Host allowlist + notification links) and the CLI (`cw`, `cw url`). Never throws: any failure
// (not installed, not logged in, not running, slow, malformed output) resolves to null.
import { execFile as nodeExecFile } from 'node:child_process';

export const WINDOWS_TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const DNS_RE = /^[A-Za-z0-9.-]+$/;

/**
 * Parses `tailscale status --json` output.
 * @returns {{dnsName:string, ips:string[]}|null} null unless BackendState is Running (when present)
 *   and Self.DNSName is a plain host name. The trailing dot is removed.
 */
export function parseTailscaleStatus(stdout) {
  let st;
  try { st = JSON.parse(stdout); } catch { return null; }
  if (!st || typeof st !== 'object' || Array.isArray(st)) return null;
  if (st.BackendState && st.BackendState !== 'Running') return null;
  const self = st.Self && typeof st.Self === 'object' ? st.Self : {};
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  if (!dnsName || !DNS_RE.test(dnsName)) return null;
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
  return { dnsName: dnsName.toLowerCase(), ips };
}

function run(execFileImpl, file, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(guard); resolve(v); } };
    // Our own deadline too, in case the child (or an injected execFile) never calls back.
    const guard = setTimeout(() => finish({ err: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }), timeoutMs + 250);
    guard.unref?.();
    try {
      execFileImpl(file, ['status', '--json'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout) => finish({ err, stdout }));
    } catch (err) {
      finish({ err });
    }
  });
}

/**
 * Runs `tailscale status --json` (PATH first; on ENOENT, the default Windows install path).
 * @param {object} [o]
 * @param {Function} [o.execFileImpl] execFile-compatible (tests inject it)
 * @param {number} [o.timeoutMs]
 * @param {string[]} [o.candidates] binaries to try in order
 * @returns {Promise<{dnsName:string, ips:string[]}|null>}
 */
export async function discoverTailscale({
  execFileImpl = nodeExecFile,
  timeoutMs = 2000,
  candidates = process.platform === 'win32' ? ['tailscale', WINDOWS_TAILSCALE] : ['tailscale'],
} = {}) {
  try {
    for (const file of candidates) {
      const { err, stdout } = await run(execFileImpl, file, timeoutMs);
      if (!err) return parseTailscaleStatus(String(stdout ?? ''));
      if (err.code !== 'ENOENT') return null; // installed but failing / slow: do not try another copy
    }
  } catch { /* never throws */ }
  return null;
}
