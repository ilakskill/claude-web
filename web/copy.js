// cw copy overlay: xterm.js has no touch selection, and touch-scroll.js owns finger drags on the
// terminal, so the phone cannot select text in it. The Copy key (key bar) or a 600 ms long-press on
// the terminal opens a full-screen read-only textarea holding the terminal text, where the
// browser's own selection works. Copy all / Copy selection write to the clipboard.
// Text source: every line of the active buffer (scrollback + screen in the normal buffer; the
// screen in the alternate one, where Claude's fullscreen mode lives), newest 5000 lines.
// window.cwCopy.bufferText is the pure buffer -> text helper (unit-tested from Node).
(() => {
  'use strict';
  const MAX_LINES = 5000;
  const LONG_PRESS_MS = 600;
  const SLOP = 10; // px; the same as touch-scroll.js, so a drag that scrolls never also long-presses
  const STATUS_MS = 1500;

  /**
   * Text of an xterm buffer (term.buffer.active): one string, lines joined by '\n'. Soft-wrapped
   * rows are joined back into their logical line, every line is trimmed on the right, and the
   * trailing blank lines (the unused screen rows) are dropped. Only the newest `maxLines` logical
   * lines are kept.
   * @param {{length:number, getLine(i:number):{translateToString(trim?:boolean):string, isWrapped?:boolean}|undefined}} buffer
   */
  function bufferText(buffer, { maxLines = MAX_LINES } = {}) {
    if (!buffer || !(buffer.length > 0)) return '';
    const lines = [];
    let cur = null; // the logical line being assembled, as an array of row strings
    const flush = () => {
      if (cur === null) return;
      // Only the last row of a logical line is trimmed: the earlier rows are full width, and a
      // space in their last cell is part of the text.
      const n = cur.length;
      lines.push(cur.slice(0, n - 1).join('') + cur[n - 1]);
      cur = null;
    };
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) { flush(); cur = ['']; flush(); continue; }
      if (cur !== null && line.isWrapped) {
        cur[cur.length - 1] = buffer.getLine(i - 1).translateToString(false);
        cur.push(line.translateToString(true));
        continue;
      }
      flush();
      cur = [line.translateToString(true)];
    }
    flush();
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    const start = Math.max(0, end - Math.max(0, maxLines | 0));
    return lines.slice(start, end).join('\n');
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.cwCopy = { bufferText, MAX_LINES, LONG_PRESS_MS };

  const cw = root.cw;
  if (!cw || !cw.term || typeof document === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const term = cw.term;
  const panel = $('copy-overlay');
  const ta = $('copy-text');
  const status = $('copy-status');
  if (!panel || !ta) return;
  // Primary pointer (not any-pointer): a touchscreen laptop has a physical keyboard, so refocusing
  // the terminal there costs nothing; a phone would raise its on-screen keyboard.
  const coarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

  // ---------- status ----------
  let statusTimer = null;
  function say(text, isError = false) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.classList.toggle('error', isError);
    status.hidden = !text;
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; status.hidden = true; }, STATUS_MS);
  }

  // ---------- clipboard ----------
  /**
   * Writes text to the clipboard: the async API, else execCommand on a textarea selection (the
   * overlay's own at `range`, or, without a range, a temporary off-screen one: the snippet tray).
   */
  async function writeClipboard(text, range) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* denied or not a secure context: fall through */ }
    if (!range) return execCopy(text);
    try {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(range[0], range[1]);
      return document.execCommand('copy');
    } catch { return false; }
  }
  /** execCommand('copy') from a temporary read-only textarea (read-only: no phone keyboard). */
  function execCopy(text) {
    const t = document.createElement('textarea');
    t.value = text;
    t.readOnly = true;
    t.tabIndex = -1;
    t.setAttribute('aria-hidden', 'true');
    t.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    const prev = document.activeElement;
    document.body.appendChild(t);
    try {
      t.focus({ preventScroll: true });
      t.setSelectionRange(0, text.length);
      return document.execCommand('copy');
    } catch { return false; } finally {
      t.remove();
      // At a desk focus goes back (the terminal); a phone would raise its keyboard for it.
      if (prev && prev !== document.body && prev.focus && !coarse()) prev.focus({ preventScroll: true });
    }
  }
  async function copy(all) {
    const text = ta.value;
    let range = [0, text.length];
    if (!all) {
      range = [ta.selectionStart, ta.selectionEnd];
      if (range[0] === range[1]) { say('select some text first', true); return; }
    }
    const chunk = text.slice(range[0], range[1]);
    if (!chunk) { say('nothing to copy', true); return; }
    const ok = await writeClipboard(chunk, range);
    const lines = chunk.split('\n').length;
    say(ok ? `Copied ${all ? 'all' : 'selection'} (${lines} line${lines === 1 ? '' : 's'})` : 'copy failed: clipboard blocked', !ok);
  }

  // ---------- open / close ----------
  let opened = false;
  function open() {
    if (opened) return;
    ta.value = bufferText(term.buffer.active);
    say('');
    panel.hidden = false;
    opened = true;
    // Blur the terminal (closes a phone keyboard) and move focus to a button, never the textarea:
    // focusing it would open the keyboard on some phones. The textarea is scrolled to the end.
    $('copy-all').focus({ preventScroll: true });
    ta.scrollTop = ta.scrollHeight;
    document.addEventListener('keydown', onKey, true);
  }
  function close() {
    if (!opened) return;
    opened = false;
    fired = false;
    panel.hidden = true;
    ta.value = '';
    say('');
    document.removeEventListener('keydown', onKey, true);
    // Reading, not typing: on a phone the keyboard stays closed; at a desk the terminal takes focus back.
    if (coarse()) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } else cw.focus();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  $('copy-all').addEventListener('click', () => copy(true));
  $('copy-sel').addEventListener('click', () => copy(false));
  for (const b of [$('copy-close'), $('copy-close-2')]) if (b) b.addEventListener('click', close);
  // Keep the textarea's selection (and focus) when tapping a button.
  for (const b of panel.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());

  // ---------- long-press on the terminal ----------
  // Same touch events as touch-scroll.js, tracked independently: the timer is cancelled by any
  // movement beyond SLOP (a drag, which that shim turns into scrolling), a second finger, or lift.
  const el = term.element;
  let fired = false; // the next touchend/click belongs to a long-press: do not focus the terminal
  let press = null; // {id, x0, y0, timer}
  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }
  el.addEventListener('touchstart', (e) => {
    cancelPress();
    fired = false;
    if (e.touches.length !== 1 || opened) return;
    const p = e.touches[0];
    press = {
      id: p.identifier, x0: p.clientX, y0: p.clientY,
      timer: setTimeout(() => { press = null; fired = true; open(); }, LONG_PRESS_MS),
    };
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!press) return;
    for (const p of e.changedTouches) {
      if (p.identifier !== press.id) continue;
      if (Math.abs(p.clientX - press.x0) >= SLOP || Math.abs(p.clientY - press.y0) >= SLOP) cancelPress();
    }
  }, { passive: true });
  const end = (e) => {
    cancelPress();
    // The lift after a long-press must not become a click/focus on the terminal (keyboard).
    if (fired && e.cancelable) e.preventDefault();
  };
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });
  // Android fires contextmenu for a long touch; the overlay replaces it.
  el.addEventListener('contextmenu', (e) => { if (fired || press) e.preventDefault(); });

  cw.copy = { open, close, isOpen: () => opened, bufferText, writeClipboard: (text) => writeClipboard(text) };
})();
