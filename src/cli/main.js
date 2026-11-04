// `cw` entry: pure argument parsing plus dispatch. Command modules are imported lazily so that
// `cw hook` (run by Claude Code on every notification) loads as little as possible.
import fs from 'node:fs';

const pkgUrl = new URL('../../package.json', import.meta.url);

function readVersion() {
  return JSON.parse(fs.readFileSync(pkgUrl, 'utf8')).version;
}

export const USAGE = `usage:
  cw [--web|--no-web] [--harness <id>] [claude args or prompt...]
                                 start claude in the current directory and attach to it in this
                                 terminal (detach: Ctrl+\\); --web opens the browser instead
                                 (also the fallback when not in a terminal); --no-web forces the terminal
  cw [--web|--no-web] -- <command> [args...]  start any command instead of claude
  cw [--web|--no-web] --harness <id> [args...]  start an agent preset (claude, agy, copilot, gemini,
                                 codex, opencode, hermes, pi, ollama, shell) instead of claude; the
                                 args go to it; not combinable with --
  cw ls [--all]                  list running and recent sessions with their titles (recent
                                 sessions without a Claude transcript are hidden unless renamed;
                                 --all shows them)
  cw clear [--all]               forget recent sessions without a transcript, unless renamed
                                 (--all: every recent session); running sessions are never touched
  cw attach [--web|--no-web] <n|id>  attach to a running session in this terminal (--web: browser)
  cw kill <n|id>                 end a running session
  cw rename <n|id> <title...>    give a running or recent session a custom title (shown in cw ls and
                                 the web list); cw rename <n|id> --clear removes it
  cw resume [--web|--no-web] <n|id>  resume a recent session (claude --resume, or that harness's own
                                 resume/continue) and attach to it
  cw copy [--label <text>] [--session <n|id>] [<text...>]
                                 put exact text (the args, else stdin) in the session's snippet tray,
                                 where the phone copies it with one tap; default session: the one
                                 this runs in (CW_SESSION_ID); -- before text that starts with -
  cw url [--qr]                  print the login URLs and the two ntfy topics (--qr: QR codes for all)
  cw notify test                 send a test notification through the hub to the ntfy app
  cw hub status|start|stop [--force]|install|uninstall
  cw token add <name> | ls | rm <name>
  cw auth tailscale add <login> | remove <login> | list | enable | disable
                                 let a Tailscale login (your Google account email) use the hub
                                 from the tailnet without a token (see README "Tailscale login")
  cw hooks install|uninstall [--harness claude|gemini|codex]
                                 add/remove the notification hooks in ~/.claude/settings.json
                                 (gemini: ~/.gemini/settings.json, codex: ~/.codex/hooks.json)
  cw --version | -h | --help`;

const SUBCOMMANDS = new Set(['ls', 'clear', 'attach', 'kill', 'rename', 'resume', 'copy', 'url', 'notify', 'hub', 'token', 'auth', 'hooks', 'hook']);
const TARGET_RE = /^(?:[1-9]\d{0,8}|[0-9a-f]{8})$/;
const bad = (error) => ({ cmd: 'error', error });

function noExtra(rest, result) {
  return rest.length ? bad(`unexpected argument: ${rest[0]}`) : result;
}

function target(cmd, rest) {
  if (rest.length !== 1) return bad(`${cmd} needs exactly one session number or id`);
  if (!TARGET_RE.test(rest[0])) return bad(`not a session number or 8-hex id: ${rest[0]}`);
  return { cmd, target: rest[0] };
}

/**
 * Parses argv (without node and script). Pure; never exits.
 * @returns {{cmd:string, [k:string]:any}} `cmd` is a command name, or 'error' with `error`.
 */
const VIEW_FLAGS = { '--web': true, '--no-web': false };

/**
 * Takes cw's own flags (--web, --no-web: the last one wins; --harness <id> or --harness=<id>) out of
 * the leading flags, i.e. everything before `--` or the first argument that does not start with `-`.
 * Later occurrences belong to the command. Ids are not validated here (the hub answers 400).
 * @returns {{argv:string[], web:boolean|undefined, harness:string|undefined, dashdash:boolean, error?:string}}
 */
export function takeViewFlags(argv) {
  const kept = [];
  let web;
  let harness;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' || !a.startsWith('-')) break;
    if (Object.hasOwn(VIEW_FLAGS, a)) web = VIEW_FLAGS[a];
    else if (a === '--harness' || a.startsWith('--harness=')) {
      const v = a === '--harness' ? argv[++i] : a.slice('--harness='.length);
      if (v === undefined || v === '' || v.startsWith('-')) {
        return { argv, web, harness, dashdash: false, error: '--harness needs a harness id (e.g. --harness codex)' };
      }
      harness = v;
    } else kept.push(a);
  }
  return { argv: [...kept, ...argv.slice(i)], web, harness, dashdash: argv[i] === '--' };
}

export function parseArgs(argv) {
  if (!SUBCOMMANDS.has(argv[0])) {
    const { argv: rest, web, harness, dashdash, error } = takeViewFlags(argv);
    if (error) return bad(error);
    if (harness !== undefined && dashdash) return bad('use either --harness or --');
    if (web !== undefined || harness !== undefined) {
      // cw's own flags; the command never sees them.
      const r = parseArgs(rest);
      if (r.cmd === 'error') return r;
      if (r.cmd !== 'default') return bad('--web/--no-web/--harness go with starting a session; use: cw attach --web <n|id>');
      return { ...r, ...(web !== undefined ? { web } : {}), ...(harness !== undefined ? { harness } : {}) };
    }
  }
  const [first, ...rest] = argv;
  if (first === undefined) return { cmd: 'default', args: [] };
  if (first === '--version' || first === '-v') return noExtra(rest, { cmd: 'version' });
  if (first === '-h' || first === '--help') return { cmd: 'help' };
  if (first === '--') {
    if (rest.length === 0) return { cmd: 'default', args: [] };
    if (rest[0] === '') return bad('empty command after --');
    return { cmd: 'default', command: rest[0], args: rest.slice(1) };
  }
  if (!SUBCOMMANDS.has(first)) {
    // Parity with `claude "prompt"` / `claude -p hi`: everything goes to claude as args.
    // A later `--` would be ambiguous.
    if (argv.includes('--')) return bad('arguments before -- are not allowed; use: cw -- <command> [args...]');
    return { cmd: 'default', args: [...argv] };
  }
  switch (first) {
    case 'ls':
    case 'clear':
      return noExtra(rest.filter((a) => a !== '--all'), { cmd: first, all: rest.includes('--all') });
    case 'kill':
      return target(first, rest);
    case 'rename': {
      const [t, ...words] = rest;
      if (t === undefined) return bad('rename needs a session number or id and a title (or --clear)');
      if (!TARGET_RE.test(t)) return bad(`not a session number or 8-hex id: ${t}`);
      if (words.includes('--clear')) {
        return words.length === 1 ? { cmd: first, target: t, title: '' } : bad('--clear takes no title');
      }
      if (words.length === 0) return bad('rename needs a title (or --clear to remove the name)');
      return { cmd: first, target: t, title: words.join(' ') };
    }
    case 'attach':
    case 'resume': {
      const r = target(first, rest.filter((a) => !Object.hasOwn(VIEW_FLAGS, a)));
      const flags = rest.filter((a) => Object.hasOwn(VIEW_FLAGS, a));
      return r.cmd === 'error' || flags.length === 0 ? r : { ...r, web: VIEW_FLAGS[flags.at(-1)] };
    }
    case 'copy': {
      // Flags only before the text (or before `--`), so text that contains `--label` stays text.
      const r = { cmd: 'copy' };
      let i = 0;
      for (; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--') { i++; break; }
        const f = /^--(label|session)(?:=([\s\S]*))?$/.exec(a);
        if (!f) {
          if (a.startsWith('-')) return bad(`unknown copy option: ${a} (put -- before text that starts with -)`);
          break;
        }
        const v = f[2] !== undefined ? f[2] : rest[++i];
        if (v === undefined) return bad(`--${f[1]} needs a value`);
        if (f[1] === 'session' && !TARGET_RE.test(v)) return bad(`not a session number or 8-hex id: ${v}`);
        r[f[1]] = v;
      }
      const words = rest.slice(i);
      if (words.length) r.text = words.join(' ');
      return r;
    }
    case 'url': {
      const extra = rest.filter((a) => a !== '--qr');
      return noExtra(extra, { cmd: 'url', qr: rest.includes('--qr') });
    }
    case 'notify': {
      const [sub, ...more] = rest;
      if (sub === 'test') return noExtra(more, { cmd: 'notify', sub });
      return bad(sub === undefined ? 'notify needs a subcommand (test)' : `unknown notify subcommand: ${sub}`);
    }
    case 'hub': {
      const [sub, ...more] = rest;
      if (sub === 'stop') {
        const extra = more.filter((a) => a !== '--force');
        return noExtra(extra, { cmd: 'hub', sub, force: more.includes('--force') });
      }
      if (['status', 'start', 'install', 'uninstall'].includes(sub)) return noExtra(more, { cmd: 'hub', sub });
      return bad(sub === undefined ? 'hub needs a subcommand' : `unknown hub subcommand: ${sub}`);
    }
    case 'token': {
      const [sub, ...more] = rest;
      if (sub === 'ls') return noExtra(more, { cmd: 'token', sub });
      if (sub === 'add' || sub === 'rm') {
        if (more.length !== 1) return bad(`token ${sub} needs exactly one name`);
        return { cmd: 'token', sub, name: more[0] };
      }
      return bad(sub === undefined ? 'token needs a subcommand' : `unknown token subcommand: ${sub}`);
    }
    case 'auth': {
      const [provider, sub, ...more] = rest;
      if (provider === undefined) return bad('auth needs a provider: cw auth tailscale ...');
      if (provider !== 'tailscale') return bad(`unknown auth provider: ${provider} (only tailscale)`);
      const alias = { ls: 'list', rm: 'remove' };
      const s = Object.hasOwn(alias, sub) ? alias[sub] : sub;
      if (s === 'list' || s === 'enable' || s === 'disable') return noExtra(more, { cmd: 'auth', provider, sub: s });
      if (s === 'add' || s === 'remove') {
        if (more.length !== 1) return bad(`auth tailscale ${s} needs exactly one login (an email)`);
        return { cmd: 'auth', provider, sub: s, login: more[0] };
      }
      return bad(sub === undefined ? 'auth tailscale needs a subcommand (add, remove, list, enable, disable)' : `unknown auth tailscale subcommand: ${sub}`);
    }
    case 'hooks': {
      const [sub, ...more] = rest;
      if (sub === 'install' || sub === 'uninstall') {
        // --harness <id> / --harness=<id>: claude (default), gemini or codex.
        let harness;
        const extra = [];
        for (let i = 0; i < more.length; i++) {
          const a = more[i];
          if (a === '--harness' || a.startsWith('--harness=')) {
            const v = a === '--harness' ? more[++i] : a.slice('--harness='.length);
            if (!['claude', 'gemini', 'codex'].includes(v)) return bad(`--harness needs claude, gemini or codex${v ? `, not ${v}` : ''}`);
            harness = v;
          } else extra.push(a);
        }
        return noExtra(extra, { cmd: 'hooks', sub, ...(harness ? { harness } : {}) });
      }
      return bad(sub === undefined ? 'hooks needs a subcommand' : `unknown hooks subcommand: ${sub}`);
    }
    case 'hook':
      return { cmd: 'hook' }; // internal; extra args are ignored so a future Claude change cannot break it
    default:
      return bad(`unknown command: ${first}`); // unreachable: guarded by SUBCOMMANDS
  }
}

/** Runs the command and resolves to the process exit code. Never rejects. */
export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.cmd === 'hook') {
    const { runHook } = await import('./hook.js');
    return runHook();
  }
  if (parsed.cmd === 'error') {
    console.error(`cw: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.cmd === 'version') {
    console.log(`cw ${readVersion()}`);
    return 0;
  }
  if (parsed.cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  try {
    const mod = await import({
      default: './commands.js', ls: './commands.js', clear: './commands.js', attach: './commands.js', kill: './commands.js',
      rename: './commands.js', resume: './commands.js', url: './commands.js', notify: './commands.js', hub: './hub-cmd.js', token: './token-cmd.js',
      auth: './auth-cmd.js', hooks: './hooks-cmd.js', copy: './copy-cmd.js',
    }[parsed.cmd]);
    return await mod.run(parsed);
  } catch (e) {
    console.error(`cw: ${e.message}`);
    if (process.env.CW_DEBUG === '1') console.error(e.stack);
    return 1;
  }
}
