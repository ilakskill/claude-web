// `cw token add <name> | ls | rm <name>`. The hub re-reads tokens.json, so no restart is needed.
// `rm` also asks a running hub (POST /api/tokens/reload) to close the removed token's WebSockets;
// with the hub down, only the file is changed (nothing is connected then).
import { dataDir } from '../hub/config.js';
import { addToken, listTokens, loadTokens, removeToken } from '../hub/auth.js';
import { api, hubPort, hubUrl, probeHealth, remoteBase, CliError } from './client.js';
import { table, fmtTime } from './commands.js';

const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** deps (tests): {fetchImpl} */
export async function run(parsed, io = defaultIo, deps = {}) {
  const dir = dataDir();
  if (parsed.sub === 'ls') {
    const list = listTokens(dir);
    io.out(list.length ? table([['NAME', 'CREATED'], ...list.map((t) => [t.name, fmtTime(t.createdAt)])]) : 'no tokens');
    return 0;
  }
  if (parsed.sub === 'add') {
    try {
      addToken(dir, parsed.name);
    } catch (e) {
      throw new CliError(e.message);
    }
    const tok = loadTokens(dir).find((t) => t.name === parsed.name).token;
    const port = hubPort();
    const remote = await remoteBase(port);
    io.out(`cw: token "${parsed.name}" added; log in once with:`);
    io.out(`  local:   ${hubUrl(port)}/?t=${tok}`);
    if (remote) io.out(`  tailnet: ${remote}/?t=${tok}`);
    return 0;
  }
  if (parsed.sub === 'rm') {
    const list = listTokens(dir);
    if (!list.some((t) => t.name === parsed.name)) throw new CliError(`no token named "${parsed.name}"`);
    if (list.length === 1) throw new CliError(`"${parsed.name}" is the last token; add another one first (cw token add <name>)`);
    removeToken(dir, parsed.name);
    io.out(`cw: token "${parsed.name}" removed; browsers logged in with it get "unauthorized" from now on`);
    const port = hubPort();
    const p = await probeHealth(port, { fetchImpl: deps.fetchImpl });
    if (p.state !== 'cw') {
      io.out('cw: hub is not running, so no open connection used it');
      return 0;
    }
    try {
      const r = await api('POST', '/api/tokens/reload', {}, { port, fetchImpl: deps.fetchImpl });
      io.out(`cw: hub closed ${r?.closed ?? 0} open connection(s) that used "${parsed.name}"`);
      return 0;
    } catch (e) {
      io.err(`cw: could not ask the hub to close "${parsed.name}" connections (${e.message}); `
        + 'they stay open until the hub restarts: cw hub stop --force, then cw');
      return 1;
    }
  }
  throw new Error(`unhandled token subcommand ${parsed.sub}`);
}
