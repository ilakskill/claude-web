// Pure size-ownership policy. One client (the most recently active) owns the PTY size;
// PTY resizes are trailing-debounced so a burst of window drags causes one ConPTY resize.

/**
 * @param {Iterable<{id:string, cols?:number, rows?:number, lastActivity:number}>|Map} clients
 * @returns the client with the greatest lastActivity (ties: later in iteration wins), or null.
 */
export function pickOwner(clients) {
  if (!clients) return null;
  const iter = clients instanceof Map ? clients.values() : clients;
  let best = null;
  for (const c of iter) {
    if (!c) continue;
    if (best === null || c.lastActivity >= best.lastActivity) best = c;
  }
  return best;
}

/**
 * Trailing debounce around applyResize(cols, rows).
 * Timer functions are resolved at call time so node:test mock.timers works with the defaults.
 */
export function createResizer({ applyResize, delayMs = 50, setTimeoutImpl, clearTimeoutImpl } = {}) {
  if (typeof applyResize !== 'function') throw new TypeError('applyResize is required');
  const st = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
  const ct = clearTimeoutImpl || ((h) => clearTimeout(h));
  let timer = null;
  let pending = null;

  function fire() {
    timer = null;
    if (!pending) return;
    const { cols, rows } = pending;
    pending = null;
    applyResize(cols, rows);
  }

  return {
    request(cols, rows) {
      pending = { cols, rows };
      if (timer !== null) ct(timer);
      timer = st(fire, delayMs);
    },
    flush() {
      if (timer !== null) { ct(timer); timer = null; }
      fire();
    },
    cancel() {
      if (timer !== null) { ct(timer); timer = null; }
      pending = null;
    },
  };
}
