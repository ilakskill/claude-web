// cw touch scrolling for phones. xterm.js 6.0 has no touch scrolling (xtermjs/xterm.js#5489), so a
// vertical finger drag on the terminal becomes: local scrollback in the normal buffer; SGR wheel
// reports when a full-screen app in the alternate buffer tracks the mouse (Claude's fullscreen TUI
// scrolls itself); arrow keys otherwise. Under 10 px of movement it stays a tap, so the terminal
// still takes focus and opens the keyboard. Finger down = content down = back in history.
//
// Smoothness: finger travel is accumulated in pixels and turned into whole lines as it crosses the
// real cell height (the remainder carries over, so a slow drag still scrolls); lifting the finger
// while moving starts a fling that decays frame by frame (a touch stops it); in the alternate
// buffer the wheel/arrow steps are batched into at most one pty write per frame.
// window.cwTouchScroll holds the pure helpers (velocity, decay, line stepper), unit-tested from Node.
(() => {
  'use strict';

  // ---------- tunables ----------
  const SLOP = 10;                 // px of movement before a touch is a scroll rather than a tap
  const FRAME_MS = 1000 / 60;      // velocities below are in px per 60 Hz frame
  const VELOCITY_WINDOW_MS = 100;  // only touchmoves this recent at lift-off set the fling velocity
  const FLING_MIN_START = 1;       // px/frame (~60 px/s): a slower lift-off does not fling
  const FLING_MAX = 80;            // px/frame (~4800 px/s): cap, so a hard flick cannot run away
  const FRICTION = 0.95;           // velocity multiplier per frame during a fling
  const FLING_STOP = 0.1;          // px/frame: the fling ends once slower than this
  const MAX_FRAME_CATCHUP = 3;     // frames one fling tick may cover after a stall (hidden tab)
  const REPORT_INTERVAL_MS = 16;   // alternate buffer: at most one batch of reports per ~frame (~60/s)
  const MAX_STEPS_PER_FLUSH = 8;   // alternate buffer: steps per batch; the rest is dropped, never queued
  const WHEEL_MODES = ['vt200', 'drag', 'any']; // x10 mode never reports the wheel

  // ---------- pure helpers (also exported for tests) ----------
  /**
   * Fling velocity in px per frame (down = positive) from touchmove samples [{t, y}] (ms, px),
   * judged at time `now` (the lift-off): the newest sample must fall inside the window, the
   * velocity is the slope from the oldest sample inside it (or the one just before, so a single
   * fresh sample still has a baseline). Slower than `minStart` returns 0; faster than `max` is capped.
   */
  function flingVelocity(samples, now, { windowMs = VELOCITY_WINDOW_MS, frameMs = FRAME_MS, minStart = FLING_MIN_START, max = FLING_MAX } = {}) {
    if (!Array.isArray(samples) || samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    if (!(now - last.t <= windowMs)) return 0; // the finger paused before lifting
    let i = samples.length - 1;
    while (i > 0 && now - samples[i - 1].t <= windowMs) i--;
    if (i === samples.length - 1) i--; // only the newest is inside: use the one before as baseline
    const first = samples[i];
    const dt = last.t - first.t;
    if (!(dt > 0)) return 0;
    let v = ((last.y - first.y) / dt) * frameMs;
    if (Math.abs(v) < minStart) return 0;
    if (Math.abs(v) > max) v = Math.sign(v) * max;
    return v;
  }

  /**
   * One fling tick: velocity `v` (px/frame) over `dtMs` with exponential decay (`friction` per
   * frame). Returns {v, dy}: the velocity afterwards (0 once below `stop`) and the distance covered,
   * i.e. the sum of the geometric series over dt / frameMs frames (at most `maxFrames`).
   */
  function decayStep(v, dtMs, { friction = FRICTION, frameMs = FRAME_MS, stop = FLING_STOP, maxFrames = MAX_FRAME_CATCHUP } = {}) {
    if (!(Math.abs(v) >= stop) || !(friction > 0 && friction < 1)) return { v: 0, dy: 0 };
    let k = dtMs / frameMs;
    if (!(k > 0)) return { v, dy: 0 };
    if (k > maxFrames) k = maxFrames;
    const f = Math.pow(friction, k);
    const dy = (v * (1 - f)) / (1 - friction);
    const next = v * f;
    return { v: Math.abs(next) < stop ? 0 : next, dy };
  }

  /**
   * Accumulates pixel travel and hands out whole lines each time it crosses the cell height; the
   * fractional remainder carries over to the next push. `push(dy, cell)` returns the lines to
   * scroll: positive = finger moved down = scroll back (content follows the finger), i.e. the
   * negative of xterm's scrollLines direction.
   */
  function lineStepper() {
    let acc = 0;
    return {
      push(dy, cell) {
        if (!(cell > 0) || !Number.isFinite(dy)) return 0;
        acc += dy;
        const steps = Math.trunc(acc / cell);
        acc -= steps * cell;
        return steps;
      },
      reset() { acc = 0; },
      get remainder() { return acc; },
    };
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.cwTouchScroll = {
    flingVelocity, decayStep, lineStepper,
    SLOP, FRAME_MS, VELOCITY_WINDOW_MS, FLING_MIN_START, FLING_MAX, FRICTION, FLING_STOP, REPORT_INTERVAL_MS, MAX_STEPS_PER_FLUSH,
  };

  // ---------- the shim ----------
  const cw = root.cw;
  if (!cw || !cw.term || !cw.term.element || typeof document === 'undefined') return;
  let coarse = false;
  // any-pointer: touchscreen laptops have a fine primary pointer but still get finger drags.
  try { coarse = window.matchMedia('(any-pointer: coarse)').matches; } catch { /* no matchMedia */ }
  if (!coarse) return;

  const term = cw.term;
  const el = term.element;
  const wrap = document.getElementById('term-wrap');
  const now = () => performance.now();
  const stepper = lineStepper(); // shared by the drag and its fling, so the remainder carries over
  let t = null; // the tracked touch: {id, x0, y0, x, y, scrolling, stoppedFling, samples}
  let fling = null; // {v, x, y, last, raf}

  function screenRect() {
    const s = el.querySelector('.xterm-screen');
    return (s || el).getBoundingClientRect();
  }
  /** Rendered cell height in CSS px: xterm's render dimensions, else a row element, else screen/rows. */
  function cellHeight() {
    try {
      const h = term._core._renderService.dimensions.css.cell.height;
      if (h > 0) return h;
    } catch { /* private API moved */ }
    const row = el.querySelector('.xterm-rows > *');
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h > 0) return h;
    }
    return screenRect().height / term.rows;
  }
  /** 1-based cell under a client point, clamped to the terminal. */
  function cellAt(x, y) {
    const r = screenRect();
    const col = Math.floor((x - r.left) / (r.width / term.cols)) + 1;
    const row = Math.floor((y - r.top) / (r.height / term.rows)) + 1;
    return { col: Math.min(term.cols, Math.max(1, col)), row: Math.min(term.rows, Math.max(1, row)) };
  }
  // Following a taller owner: the wrapper pans vertically by itself (style.css .follow-y), so
  // vertical drags are left to the browser. Only-wider owners still get touch scrolling.
  const nativeVertical = () => !!wrap && wrap.classList.contains('follow') && wrap.scrollHeight > wrap.clientHeight + 1;
  const find = (list) => { for (const x of list) if (x.identifier === t.id) return x; return null; };

  // ---------- alternate buffer: batched reports ----------
  // Steps wait in `pending` (signed, < 0 = back) and leave in one cw.send per REPORT_INTERVAL_MS,
  // so a burst of touchmoves is one pty write and the TUI never queues up behind the finger.
  let pending = 0;
  let pendingAt = { x: 0, y: 0 }; // where the finger was: the cell in the wheel report
  let lastFlush = -Infinity;
  let flushTimer = null;
  function flush() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending) return;
    const back = pending < 0;
    const n = Math.min(Math.abs(pending), MAX_STEPS_PER_FLUSH);
    pending = 0;
    lastFlush = now();
    let seq;
    if (WHEEL_MODES.includes(term.modes.mouseTrackingMode)) {
      const { col, row } = cellAt(pendingAt.x, pendingAt.y);
      seq = `\x1b[<${back ? 64 : 65};${col};${row}M`;
    } else {
      seq = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + (back ? 'A' : 'B');
    }
    cw.send(seq.repeat(n), { filter: false });
  }
  function scheduleFlush() {
    if (flushTimer !== null) return;
    const wait = REPORT_INTERVAL_MS - (now() - lastFlush);
    if (wait <= 0) { flush(); return; }
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
  }

  /**
   * Scrolls by `lines` (xterm direction: < 0 back). Returns false when the normal buffer could
   * not move (top or bottom of the scrollback), so a fling can stop there.
   */
  function scroll(lines, x, y) {
    if (term.buffer.active.type === 'normal') {
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      return term.buffer.active.viewportY !== before;
    }
    pending += lines;
    pendingAt = { x, y };
    scheduleFlush();
    return true;
  }
  /** Finger (or fling) travel of `dy` px at (x, y): scrolls whole lines as the accumulator crosses a cell. */
  function travel(dy, x, y) {
    const steps = stepper.push(dy, cellHeight());
    if (!steps) return true;
    return scroll(-steps, x, y);
  }

  // ---------- fling ----------
  function stopFling() {
    if (!fling) return;
    cancelAnimationFrame(fling.raf);
    fling = null;
  }
  function flingTick(ts) {
    if (!fling) return;
    const { v, dy } = decayStep(fling.v, ts - fling.last);
    fling.last = ts;
    fling.v = v;
    const moved = travel(dy, fling.x, fling.y);
    if (!v || !moved) { fling = null; flush(); return; }
    fling.raf = requestAnimationFrame(flingTick);
  }
  function startFling(v, x, y) {
    stopFling();
    fling = { v, x, y, last: now(), raf: 0 };
    fling.raf = requestAnimationFrame(flingTick);
  }

  // ---------- touch events ----------
  el.addEventListener('touchstart', (e) => {
    const wasFlinging = !!fling;
    stopFling(); // any touch stops a fling, as it does in a native scroller
    if (e.touches.length !== 1) { t = null; return; } // pinch and the like
    const p = e.touches[0];
    stepper.reset();
    t = {
      id: p.identifier, x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY,
      scrolling: false, stoppedFling: wasFlinging, samples: [{ t: e.timeStamp, y: p.clientY }],
    };
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!t) return;
    const p = find(e.changedTouches);
    if (!p) return;
    if (!t.scrolling) {
      const dx = Math.abs(p.clientX - t.x0);
      const dy = Math.abs(p.clientY - t.y0);
      if (dx < SLOP && dy < SLOP) return;
      if (dx > dy || nativeVertical()) { t = null; return; } // horizontal, or a native vertical pan
      t.scrolling = true;
    }
    if (e.cancelable) e.preventDefault();
    const dy = p.clientY - t.y;
    t.x = p.clientX;
    t.y = p.clientY;
    t.samples.push({ t: e.timeStamp, y: p.clientY });
    if (t.samples.length > 20) t.samples.shift();
    travel(dy, p.clientX, p.clientY);
  }, { passive: false });

  const end = (e) => {
    if (!t || !find(e.changedTouches)) return;
    const done = t;
    t = null;
    if (done.scrolling) {
      flush(); // the drag's last steps go out now, ahead of any fling
      if (e.type === 'touchend') {
        const v = flingVelocity(done.samples, e.timeStamp);
        if (v) startFling(v, done.x, done.y);
      }
      return;
    }
    // A tap that only stopped a fling is not a tap on the terminal: no click, no keyboard.
    if (done.stoppedFling && e.cancelable) e.preventDefault();
  };
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });

  cw.touchScroll = { stopFling, isFlinging: () => !!fling, cellHeight };
})();
