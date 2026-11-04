// Opens a URL in the browser without ever throwing. config.browser === 'edge-app' opens an Edge
// app window; anything else uses the default browser via `start`.
import { spawn as nodeSpawn } from 'node:child_process';
import { loadConfig } from '../hub/config.js';

// cmd.exe expands %VAR% even inside quotes and ends the quoted string at `"`; our URLs never
// contain either, so anything outside this set is refused rather than escaped.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:/?=&_~-]+$/;

/** Builds the cmd.exe command line (verbatim arguments). Exported for tests. */
export function startCommandLine(url, browser) {
  const inner = browser === 'edge-app' ? `start "" msedge "--app=${url}"` : `start "" "${url}"`;
  return ['/d', '/s', '/c', `"${inner}"`];
}

/**
 * @returns {Promise<boolean>} true if the launcher started; false (URL printed to stderr) otherwise.
 */
export async function open(url, { spawnImpl = nodeSpawn, browser } = {}) {
  const fallback = (why) => {
    // The token is never printed here; `cw url` prints a login URL when the browser needs one.
    console.error(`cw: could not open a browser (${why}); open this URL yourself: ${url.replace(/[?&]t=[^&]*/, '')}`
      + ' (if it answers "unauthorized", log in once with the URL from: cw url)');
    return false;
  };
  if (!SAFE_URL.test(url)) return fallback('unexpected characters in URL');
  let which = browser;
  if (which === undefined) {
    try { which = loadConfig().browser; } catch { which = 'default'; }
  }
  try {
    const child = spawnImpl(process.env.ComSpec || 'cmd.exe', startCommandLine(url, which), {
      detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true,
    });
    const ok = await new Promise((resolve) => {
      child.once?.('error', () => resolve(false));
      child.once?.('spawn', () => resolve(true));
      if (!child.once) resolve(true);
    });
    child.unref?.();
    return ok || fallback('spawn failed');
  } catch (e) {
    return fallback(e.message);
  }
}
