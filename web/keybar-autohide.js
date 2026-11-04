// cw key bar + title bar visibility. On a phone (coarse pointer, no hover, a touch screen, or a
// window under 768 px; see phoneReason) both bars get out of the way by themselves: they collapse
// to one thin grab handle at the top of the page after HIDE_AFTER_MS without a tap on the key bar,
// and at once when a finger starts scrolling the terminal. They come back on a tap or swipe on the
// handle, a two-finger tap on the terminal, the on-screen keyboard opening (visualViewport
// heuristic) or a text box (compose, paste, rename) taking focus, and stay while the keyboard is
// open. The preference lives in localStorage `cw.keybar`: auto | always | hidden (legacy '1'/'0'
// are migrated). A long-press on the handle or the ⌨ button in the top bar cycles it and shows a
// toast. On a desk `auto` keeps the old rule (key bar off until ⌨ turns it on, which stores
// `always`) and the title bar never collapses.
// The 📌 button in the title bar (phones only) pins the title bar on its own, whatever the key bar
// mode: pinned, it stays shown while the key bar still collapses behind the handle (which then
// sits under the title bar and shows the key bar only). localStorage `cw.topbarPin`: 1 | 0.
// Showing or hiding the bars changes the terminal area, so term.js's ResizeObserver refits the
// terminal (100 ms debounce) and reports the size only while this client owns the layout.
// window.cwKeybarAutohide holds the pure state machine (reduce/view), unit-tested from Node.
// Debug: cw.keybarAutohide.state ({phone, reason, mode, view, topbar, ...}) and one
// `keybar: ...` console.info line at startup.
(() => {
  'use strict';

  // ---------- tunables ----------
  const HIDE_AFTER_MS = 4000;    // idle time (no key bar tap, keyboard closed) before it collapses
  const TOAST_MS = 1500;         // "Key bar: always" message after a preference change
  const LONG_PRESS_MS = 600;     // on the handle: cycle the preference (same as copy.js's long-press)
  const KEYBOARD_MIN_PX = 120;   // visual viewport shorter than the window by this much = soft keyboard
  const SLOP = 10;               // px of finger travel on the terminal before it counts as a scroll
  const HANDLE_SWIPE_PX = 16;    // px of vertical travel on the handle that counts as a swipe (show)
  const BAR_SWIPE_PX = 32;       // px of downward travel on the bar that hides it
  const TWO_FINGER_MS = 400;     // two fingers down and up within this, without moving = show
  const PHONE_MAX_WIDTH = 768;   // narrower windows count as a phone, like keybar.js always did
  const MODES = ['auto', 'always', 'hidden'];
  const PIN_KEY = 'cw.topbarPin';

  // ---------- pure state machine (also exported for tests) ----------
  /**
   * The stored preference as a mode. Legacy values from the old on/off toggle: '1' (on) is `auto`
   * on a phone (its new normal) and `always` at a desk (where auto means off); '0' is `hidden`.
   * Anything else is null (the caller picks the default, `auto`).
   */
  function normalizeMode(raw, phone = true) {
    if (raw === '1') return phone ? 'auto' : 'always';
    if (raw === '0') return 'hidden';
    return MODES.includes(raw) ? raw : null;
  }
  /** Next preference in the cycle auto -> always -> hidden -> auto. */
  function nextMode(mode) {
    const i = MODES.indexOf(mode);
    return MODES[(i < 0 ? 0 : i + 1) % MODES.length];
  }
  /** True when the visual viewport is at least `min` px shorter than the tallest it has been. */
  function keyboardOpen(viewportHeight, maxHeight, min = KEYBOARD_MIN_PX) {
    return viewportHeight > 0 && maxHeight > 0 && maxHeight - viewportHeight >= min;
  }
  /**
   * Why this counts as a phone, or null at a desk. Any one rule is enough: `(pointer: coarse)`,
   * `(hover: none)`, a touch screen (navigator.maxTouchPoints > 0) or a window under 768 px, so a
   * browser that reports its media features oddly (a phone in "desktop site" mode, say) still
   * gets the auto-hide. The touch rule skips a browser that also reports a mouse
   * (`(pointer: fine) and (hover: hover)`, `mouse` here): a touch-screen desk keeps its title bar.
   * The first matching rule is the reason shown in the debug state. `embedded` (a split-view pane,
   * term.js cw.embedded) drops the width rule: a 700 px pane on a desk monitor is not a phone.
   */
  function phoneReason({ width = Infinity, coarse = false, hoverNone = false, touchPoints = 0, mouse = false, embedded = false } = {}) {
    if (coarse) return 'coarse';
    if (hoverNone) return 'hover-none';
    if (touchPoints > 0 && !mouse) return 'touch';
    if (width < PHONE_MAX_WIDTH && !embedded) return 'narrow';
    return null;
  }

  /**
   * @typedef {{mode:'auto'|'always'|'hidden', phone:boolean, keyboard:boolean, compose:boolean,
   *   expanded:boolean, deadline:number|null, topbarPin:boolean}} State
   * `expanded`: the bar is open (auto/hidden modes); `deadline`: when it collapses (ms, same clock
   * as the `now` passed to reduce) or null while pinned (keyboard open / text box focused in auto).
   * `topbarPin`: the user pinned the title bar (📌); only topbarView reads it, the key bar ignores it.
   */
  function initialState({ mode = 'auto', phone = true, now = 0, topbarPin = false } = {}) {
    const s = { mode, phone, keyboard: false, compose: false, expanded: true, deadline: null, topbarPin: !!topbarPin };
    return reduce(s, { type: 'mode', mode }, now);
  }

  /**
   * One event applied to a state at time `now`; returns the next state (the input is not changed).
   * Events: {type:'tap'} (a key bar button), {type:'handle'}, {type:'twofinger'}, {type:'scroll'},
   * {type:'keyboard', open}, {type:'compose', focused}, {type:'mode', mode}, {type:'env', phone},
   * {type:'timer'} (the deadline timer fired), {type:'topbarPin', pinned} (the 📌 button).
   */
  function reduce(state, ev, now) {
    const s = { ...state };
    const pinned = () => s.mode === 'auto' && (s.keyboard || s.compose);
    const arm = () => { s.expanded = true; s.deadline = pinned() ? null : now + HIDE_AFTER_MS; };
    const collapse = () => { s.expanded = false; s.deadline = null; };
    // Something that held the bar open ended: start the countdown unless something else holds it.
    const settle = () => { if (s.expanded) s.deadline = pinned() ? null : (s.deadline ?? now + HIDE_AFTER_MS); };
    switch (ev && ev.type) {
      case 'tap': case 'handle': case 'twofinger': arm(); break;
      case 'scroll': if (s.mode !== 'always') collapse(); break;
      // In `hidden` the keyboard and the text boxes only keep their flags: the bar is peeked by hand.
      case 'keyboard': s.keyboard = !!ev.open; if (s.mode === 'hidden') break; if (s.keyboard) arm(); else settle(); break;
      case 'compose': s.compose = !!ev.focused; if (s.mode === 'hidden') break; if (s.compose) arm(); else settle(); break;
      case 'mode': s.mode = normalizeMode(ev.mode, s.phone) || s.mode; if (s.mode === 'hidden') collapse(); else arm(); break;
      case 'env': s.phone = !!ev.phone; if (s.mode !== 'hidden') arm(); else collapse(); break;
      // The title bar pin leaves the key bar (expanded, deadline) exactly as it was.
      case 'topbarPin': s.topbarPin = !!ev.pinned; break;
      case 'timer':
        if (s.deadline !== null && now >= s.deadline) { if (pinned()) s.deadline = null; else collapse(); }
        break;
      default: break;
    }
    return s;
  }
  /** What the page shows: 'shown' (the bar), 'collapsed' (the handle only), 'off' (neither; desk). */
  function view(s) {
    if (!s.phone) return s.mode === 'always' ? 'shown' : 'off';
    if (s.mode === 'always') return 'shown';
    return s.expanded ? 'shown' : 'collapsed';
  }
  /**
   * The title bar follows the key bar on a phone: 'collapsed' behind the same handle whenever the
   * key bar is, 'shown' otherwise, unless the user pinned it (`topbarPin`), which keeps it shown in
   * every mode. At a desk it is always shown (the key bar is merely off there).
   */
  function topbarView(s) {
    if (s.topbarPin) return 'shown';
    return view(s) === 'collapsed' ? 'collapsed' : 'shown';
  }
  /** The stored pin ('1' / '0', or anything else) as a boolean: only '1' pins. */
  function normalizePin(raw) {
    return raw === '1';
  }
  /** Milliseconds until the timer should fire, or null when no countdown is running. */
  function timerMs(s, now) {
    if (s.deadline === null || view(s) !== 'shown' || s.mode === 'always') return null;
    return Math.max(0, s.deadline - now);
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.cwKeybarAutohide = {
    normalizeMode, nextMode, keyboardOpen, phoneReason, initialState, reduce, view, topbarView, normalizePin, timerMs,
    HIDE_AFTER_MS, TOAST_MS, LONG_PRESS_MS, KEYBOARD_MIN_PX, SLOP, HANDLE_SWIPE_PX, BAR_SWIPE_PX, TWO_FINGER_MS, PHONE_MAX_WIDTH, MODES, PIN_KEY,
  };

  // ---------- the page ----------
  const cw = root.cw;
  if (!cw || !cw.term || typeof document === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const bar = $('keybar');
  const handle = $('keybar-handle');
  const toggle = $('keybar-toggle');
  const toast = $('keybar-toast');
  const topbar = $('topbar'); // collapses with the key bar on a phone (optional: an older page lacks the id)
  const pinBtn = $('topbar-pin'); // 📌 in the title bar, phones only (optional like topbar)
  if (!bar || !handle || !toggle) return;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };
  const KEY = 'cw.keybar';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const media = (q) => { try { return !!window.matchMedia(q).matches; } catch { return false; } };
  const env = () => ({
    width: window.innerWidth,
    coarse: media('(pointer: coarse)'),
    hoverNone: media('(hover: none)'),
    touchPoints: (typeof navigator !== 'undefined' && Number(navigator.maxTouchPoints)) || 0,
    mouse: media('(pointer: fine) and (hover: hover)'),
    embedded: cw.embedded === true,
  });
  let reason = phoneReason(env());
  const isPhone = () => { reason = phoneReason(env()); return reason !== null; };
  const reducedMotion = () => media('(prefers-reduced-motion: reduce)');

  let state = initialState({
    mode: normalizeMode(store.get(KEY), isPhone()) || 'auto', phone: isPhone(), now: now(),
    topbarPin: normalizePin(store.get(PIN_KEY)),
  });
  let timer = null;
  let lastView = null;
  let lastTopbar = null;

  function render() {
    const v = view(state);
    const tv = topbarView(state);
    const phone = state.phone;
    bar.hidden = v === 'off';
    handle.hidden = v !== 'collapsed'; // the handle stands in for the bars, never beside them
    // The transition runs between .collapsed on and off (CSS max-height); `hidden` is only used
    // at a desk, where the bar is simply on or off.
    bar.classList.toggle('collapsed', v === 'collapsed');
    bar.setAttribute('aria-hidden', String(v !== 'shown'));
    if (topbar) {
      topbar.classList.toggle('collapsed', tv === 'collapsed');
      topbar.setAttribute('aria-hidden', String(tv !== 'shown'));
    }
    // Pinned title bar: CSS moves it above the handle, which then stands in for the key bar only.
    const pinned = phone && state.topbarPin;
    document.body.classList.toggle('topbar-pinned', pinned);
    handle.setAttribute('aria-controls', pinned ? 'keybar' : 'topbar keybar');
    handle.setAttribute('aria-label', pinned ? 'Show key bar' : 'Show title and key bars');
    handle.title = `${pinned ? 'Show key bar' : 'Show title and key bars'} (hold to change)`;
    handle.setAttribute('aria-expanded', String(v === 'shown'));
    if (pinBtn) {
      pinBtn.hidden = !phone; // a desk title bar never collapses: nothing to pin
      pinBtn.classList.toggle('on', state.topbarPin);
      pinBtn.setAttribute('aria-pressed', String(state.topbarPin));
      pinBtn.title = state.topbarPin ? 'Title bar pinned (tap to unpin)' : 'Pin the title bar';
    }
    const on = v === 'shown' || (phone && state.mode === 'auto');
    toggle.classList.toggle('on', on);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.title = phone ? `Key bar: ${state.mode} (tap to change)` : 'Key bar';
    if (v !== lastView || tv !== lastTopbar) { lastView = v; lastTopbar = tv; cw.relayout(); }
    clearTimeout(timer);
    timer = null;
    const ms = timerMs(state, now());
    if (ms !== null) timer = setTimeout(() => { timer = null; dispatch({ type: 'timer' }); }, ms);
  }
  function dispatch(ev) {
    state = reduce(state, ev, now());
    render();
  }
  // First paint now, before any listener is wired: the markup starts with `hidden` on the bar and
  // the handle, and a throw further down must not leave a phone without either.
  render();

  // ---------- preference ----------
  let toastTimer = null;
  function say(text) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; toast.textContent = ''; }, TOAST_MS);
  }
  function setMode(mode, { announce = true } = {}) {
    mode = normalizeMode(mode, state.phone) || 'auto';
    store.set(KEY, mode);
    dispatch({ type: 'mode', mode });
    if (announce) say(`Key bar: ${mode}`);
  }
  function cycleMode() { setMode(nextMode(state.mode)); }
  function setTopbarPin(pinned, { announce = true } = {}) {
    pinned = !!pinned;
    store.set(PIN_KEY, pinned ? '1' : '0');
    dispatch({ type: 'topbarPin', pinned });
    if (announce) say(pinned ? 'Top bar pinned' : 'Top bar unpinned');
  }
  if (pinBtn) {
    pinBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the keyboard) where it is
    pinBtn.addEventListener('click', () => setTopbarPin(!state.topbarPin));
  }
  toggle.addEventListener('click', () => {
    // A desk has no auto-hide, so the button stays a plain on/off switch there.
    if (state.phone) cycleMode(); else setMode(state.mode === 'always' ? 'hidden' : 'always', { announce: false });
  });

  // ---------- key bar taps keep it open ----------
  bar.addEventListener('touchstart', () => dispatch({ type: 'tap' }), { passive: true });
  bar.addEventListener('mousedown', () => dispatch({ type: 'tap' }));
  bar.addEventListener('click', () => dispatch({ type: 'tap' }));
  // A downward swipe on the bar itself hides it (the bar only scrolls sideways, so a vertical
  // drag is otherwise unused).
  let barTouch = null;
  bar.addEventListener('touchstart', (e) => { barTouch = e.touches.length === 1 ? { y0: e.touches[0].clientY, x0: e.touches[0].clientX } : null; }, { passive: true });
  bar.addEventListener('touchmove', (e) => {
    if (!barTouch || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - barTouch.y0;
    const dx = Math.abs(e.touches[0].clientX - barTouch.x0);
    if (dy >= BAR_SWIPE_PX && dy > dx && state.mode !== 'always') { barTouch = null; dispatch({ type: 'scroll' }); }
    else if (dx > SLOP) barTouch = null; // a sideways scroll of the bar
  }, { passive: true });
  bar.addEventListener('touchend', () => { barTouch = null; }, { passive: true });

  // ---------- the handle: tap or swipe shows, long-press cycles the preference ----------
  handle.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the keyboard) where it is
  let press = null; // {y0, timer, fired}
  function endPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }
  handle.addEventListener('touchstart', (e) => {
    endPress();
    if (e.touches.length !== 1) return;
    press = { y0: e.touches[0].clientY, fired: false, timer: setTimeout(() => { if (press) { press.fired = true; cycleMode(); } }, LONG_PRESS_MS) };
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if (!press || press.fired) return;
    if (Math.abs(e.touches[0].clientY - press.y0) >= HANDLE_SWIPE_PX) { press.fired = true; clearTimeout(press.timer); dispatch({ type: 'handle' }); }
  }, { passive: true });
  const handleEnd = (e) => {
    const fired = !!(press && press.fired);
    endPress();
    if (fired && e.cancelable) e.preventDefault(); // no click after a swipe or long-press
  };
  handle.addEventListener('touchend', handleEnd, { passive: false });
  handle.addEventListener('touchcancel', handleEnd, { passive: false });
  handle.addEventListener('contextmenu', (e) => e.preventDefault()); // Android's long-touch menu
  handle.addEventListener('click', () => dispatch({ type: 'handle' }));

  // ---------- the terminal: a scroll hides, a two-finger tap shows ----------
  const el = cw.term.element;
  let touch = null; // one finger: {id, x0, y0}
  let two = null;   // two fingers: {t0, moved, pts: [{id, x, y}]}
  const find = (list, id) => { for (const p of list) if (p.identifier === id) return p; return null; };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      touch = null;
      two = { t0: e.timeStamp, moved: false, pts: [...e.touches].map((p) => ({ id: p.identifier, x: p.clientX, y: p.clientY })) };
      return;
    }
    two = null;
    touch = e.touches.length === 1 ? { id: e.touches[0].identifier, x0: e.touches[0].clientX, y0: e.touches[0].clientY } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (two) {
      for (const p of e.changedTouches) {
        const q = find(two.pts, p.identifier);
        if (q && (Math.abs(p.clientX - q.x) >= SLOP || Math.abs(p.clientY - q.y) >= SLOP)) two.moved = true;
      }
      return;
    }
    if (!touch) return;
    const p = find(e.changedTouches, touch.id);
    if (!p) return;
    const dx = Math.abs(p.clientX - touch.x0);
    const dy = Math.abs(p.clientY - touch.y0);
    if (dx < SLOP && dy < SLOP) return;
    touch = null;
    if (dy >= dx) dispatch({ type: 'scroll' }); // the same rule touch-scroll.js uses for a vertical drag
  }, { passive: true });
  const termEnd = (e) => {
    if (e.touches.length !== 0) return;
    if (two && e.type === 'touchend' && !two.moved && e.timeStamp - two.t0 <= TWO_FINGER_MS) dispatch({ type: 'twofinger' });
    two = null;
    touch = null;
  };
  el.addEventListener('touchend', termEnd, { passive: true });
  el.addEventListener('touchcancel', termEnd, { passive: true });

  // ---------- soft keyboard (visual viewport) and text boxes ----------
  const vv = window.visualViewport;
  let maxH = 0;
  let lastW = 0;
  function checkKeyboard() {
    const h = Math.round(vv ? vv.height : window.innerHeight);
    const w = Math.round(vv ? vv.width : window.innerWidth);
    if (w !== lastW) { lastW = w; maxH = 0; } // rotated: the tallest height seen is stale
    maxH = Math.max(maxH, h, window.innerHeight);
    const open = state.phone && keyboardOpen(h, maxH);
    if (open !== state.keyboard) dispatch({ type: 'keyboard', open });
  }
  if (vv) vv.addEventListener('resize', checkKeyboard);
  window.addEventListener('resize', () => {
    const phone = isPhone();
    if (phone !== state.phone) {
      // The same stored value reads differently at a desk (legacy '1', see normalizeMode).
      const mode = normalizeMode(store.get(KEY), phone) || 'auto';
      state = { ...state, mode };
      dispatch({ type: 'env', phone });
    }
    checkKeyboard();
  });
  // The rename box lives in the title bar: typing a name must not collapse the bar under the finger.
  const fields = [$('compose-text'), $('paste-text'), $('t-rename')].filter(Boolean);
  document.addEventListener('focusin', (e) => { if (fields.includes(e.target)) dispatch({ type: 'compose', focused: true }); });
  document.addEventListener('focusout', (e) => {
    if (!fields.includes(e.target)) return;
    // Focus moving to another text box keeps the pin; anything else (or nowhere) releases it.
    if (fields.includes(e.relatedTarget)) return;
    dispatch({ type: 'compose', focused: false });
  });

  checkKeyboard();
  render();

  const debug = () => ({
    ...state, reason, view: view(state), topbar: topbarView(state), timerMs: timerMs(state, now()),
    reducedMotion: reducedMotion(), env: env(), stored: store.get(KEY), storedPin: store.get(PIN_KEY),
  });
  cw.keybarAutohide = {
    get state() { return debug(); },
    mode: () => state.mode, setMode, cycleMode, setTopbarPin, dispatch,
  };
  try {
    const d = debug();
    console.info(`keybar: phone=${d.phone} (${d.reason || 'desk'}, ${d.env.width}px) mode=${d.mode} stored=${d.stored ?? 'none'} view=${d.view} topbar=${d.topbar} pin=${d.topbarPin}`);
  } catch { /* console absent */ }
})();
