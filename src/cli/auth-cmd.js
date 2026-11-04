// `cw auth tailscale add <login> | remove <login> | list | enable | disable`: edits the
// `tailscaleAuth` block of config.json (docs/evidence/tailscale-auth/PLAN.md). A running hub
// re-reads config.json by itself; after `remove` and `disable` it is also asked to reload
// (POST /api/tokens/reload) so open connections of that login are closed at once.
import { loadConfig, editConfig, normalizeTailscaleAuth, isTailscaleLogin } from '../hub/config.js';
import { api, hubPort, probeHealth, CliError } from './client.js';

const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/**
 * The block as the hub sees it (validated: `enabled` is the effective state, false with an empty
 * allow list) plus `wanted`, the `enabled` flag as written in the file, which the commands keep.
 */
function current() {
  const raw = loadConfig().tailscaleAuth;
  return { ...normalizeTailscaleAuth(raw), wanted: raw?.enabled === true };
}

/** Writes {enabled, allow} into config.json, keeping every other key as it is. */
function write(enabled, allow) {
  editConfig((raw) => { raw.tailscaleAuth = { enabled, allow }; });
}

/** Asks a running hub to drop connections of logins that are no longer allowed. */
async function reloadHub(io, deps, what) {
  const port = hubPort();
  const p = await probeHealth(port, { fetchImpl: deps.fetchImpl });
  if (p.state !== 'cw') {
    io.out('cw: hub is not running, so no open connection used it');
    return 0;
  }
  try {
    const r = await api('POST', '/api/tokens/reload', {}, { port, fetchImpl: deps.fetchImpl });
    io.out(`cw: hub closed ${r?.closed ?? 0} open connection(s) ${what}`);
    return 0;
  } catch (e) {
    io.err(`cw: could not ask the hub to close connections (${e.message}); `
      + 'they stay open until the hub restarts: cw hub stop --force, then cw');
    return 1;
  }
}

/** deps (tests): {fetchImpl} */
export async function run(parsed, io = defaultIo, deps = {}) {
  if (parsed.provider !== 'tailscale') throw new Error(`unhandled auth provider ${parsed.provider}`);
  const ts = current();
  switch (parsed.sub) {
    case 'list': {
      const state = ts.enabled ? 'enabled' : ts.wanted ? 'enabled, but inactive: no logins allowed' : `disabled${ts.allow.length ? ' (enable with: cw auth tailscale enable)' : ''}`;
      io.out(`tailscale login: ${state}`);
      if (ts.allow.length === 0) io.out('  no logins allowed (add one with: cw auth tailscale add <email>)');
      for (const l of ts.allow) io.out(`  ${l}`);
      return 0;
    }
    case 'add': {
      const login = String(parsed.login).trim().toLowerCase();
      if (!isTailscaleLogin(login)) throw new CliError(`not a Tailscale login: "${parsed.login}" (expected the account email, e.g. name@gmail.com)`);
      if (ts.allow.includes(login)) throw new CliError(`login "${login}" is already allowed`);
      write(ts.wanted, [...ts.allow, login]);
      io.out(`cw: login "${login}" added; tailscale login is ${ts.wanted ? 'enabled' : 'disabled (turn it on with: cw auth tailscale enable)'}`);
      if (ts.wanted) io.out('cw: phones on the tailnet signed in to Tailscale as that account can open the hub without a token (see: cw url)');
      return 0;
    }
    case 'remove': {
      const login = String(parsed.login).trim().toLowerCase();
      if (!ts.allow.includes(login)) throw new CliError(`no allowed login "${login}" (see: cw auth tailscale list)`);
      const allow = ts.allow.filter((l) => l !== login);
      write(ts.wanted, allow); // the enabled flag is the user's; with no logins left the hub treats it as disabled
      io.out(`cw: login "${login}" removed${allow.length === 0 && ts.wanted ? '; no logins left, so tailscale login is inactive until one is added' : ''}`);
      return reloadHub(io, deps, `that used "${login}"`);
    }
    case 'enable': {
      if (ts.allow.length === 0) throw new CliError('refusing to enable tailscale login with an empty allow list; add one first: cw auth tailscale add <email>');
      if (ts.wanted) { io.out('cw: tailscale login is already enabled'); return 0; }
      write(true, ts.allow);
      io.out(`cw: tailscale login enabled for ${ts.allow.join(', ')}; a running hub picks it up by itself (see: cw url)`);
      return 0;
    }
    case 'disable': {
      if (!ts.wanted) { io.out('cw: tailscale login is already disabled'); return 0; }
      write(false, ts.allow);
      io.out('cw: tailscale login disabled; the allow list is kept (cw auth tailscale enable turns it back on)');
      return reloadHub(io, deps, 'that used a tailscale login');
    }
    default:
      throw new Error(`unhandled auth subcommand ${parsed.sub}`);
  }
}
