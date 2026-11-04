// cw phone key bar: Esc, Tab, Shift+Tab, Ctrl modifier, Ctrl+C, arrows (cursor-mode aware),
// Enter, PgUp/PgDn (cw.scrollPage), Copy (cw.copy, the copy overlay), '/', Paste (clipboard, with
// an inline textarea fallback), compose toggle. Whether the bar is shown (and the phone's
// auto-hide, the ⌨ toggle and the `cw.keybar` preference) lives in web/keybar-autohide.js.
(() => {
  'use strict';
  const cw = window.cw;
  if (!cw) return;
  const $ = (id) => document.getElementById(id);
  const bar = $('keybar');
  const ctrlBtn = bar.querySelector('[data-key="ctrl"]');

  // ---------- Ctrl modifier ----------
  let ctrlArmed = false;
  function setCtrl(on) {
    ctrlArmed = on;
    ctrlBtn.classList.toggle('on', on);
    ctrlBtn.setAttribute('aria-pressed', String(on));
  }
  /** Control character for a printable key (a-z -> 1-26, plus the usual @[\]^_ /? forms), or null. */
  function ctrlChar(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return null;
    const c = ch.charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    if (c >= 65 && c <= 90) return String.fromCharCode(c - 64);
    switch (ch) {
      case '@': case ' ': case '2': return '\x00';
      case '[': case '3': return '\x1b';
      case '\\': case '4': return '\x1c';
      case ']': case '5': return '\x1d';
      case '^': case '6': return '\x1e';
      case '_': case '/': case '7': return '\x1f';
      case '?': case '8': return '\x7f';
      default: return null;
    }
  }
  // Applies to keys typed into the terminal (on-screen or physical keyboard).
  cw.inputFilters.push((data) => {
    if (!ctrlArmed) return data;
    setCtrl(false);
    const c = ctrlChar(data);
    return c === null ? data : c;
  });

  // ---------- keys ----------
  const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };
  const FIXED = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', ctrlc: '\x03', enter: '\r', slash: '/' };
  function sequence(key) {
    if (key in ARROWS) return (cw.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[key];
    return FIXED[key] ?? null;
  }

  function press(key) {
    if (key === 'ctrl') { setCtrl(!ctrlArmed); cw.focus(); return; }
    if (key === 'paste') { paste(); return; }
    if (key === 'compose') { if (cw.toggleCompose) cw.toggleCompose(); return; }
    // Reading back, not typing: no focus() (it would open the phone keyboard), Ctrl stays armed.
    if (key === 'pgup' || key === 'pgdn') { cw.scrollPage(key === 'pgup' ? -1 : 1); return; }
    if (key === 'copy') { if (cw.copy) cw.copy.open(); return; }
    let seq = sequence(key);
    if (seq === null) return;
    if (ctrlArmed) {
      const c = ctrlChar(seq);
      if (c !== null) seq = c;
      setCtrl(false);
    }
    cw.send(seq, { filter: false });
    cw.focus();
  }

  // Keep focus where it is (terminal or compose) when a bar button is pressed.
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (b) press(b.dataset.key);
  });

  // ---------- paste ----------
  const box = $('pastebox');
  const boxText = $('paste-text');
  function closeBox() {
    box.hidden = true;
    boxText.value = '';
    cw.relayout();
  }
  async function paste() {
    let text = null;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
    } catch { text = null; }
    if (text === null) {
      box.hidden = false;
      cw.relayout();
      boxText.focus();
      return;
    }
    if (text) cw.term.paste(text);
    cw.focus();
  }
  $('paste-send').addEventListener('click', () => {
    const text = boxText.value;
    closeBox();
    if (text) cw.term.paste(text);
    cw.focus();
  });
  $('paste-cancel').addEventListener('click', () => { closeBox(); cw.focus(); });

  /** Drops an armed Ctrl (compose send, session exit) so it cannot modify an unrelated later key. */
  const disarm = () => { if (ctrlArmed) setCtrl(false); };
  cw.keybar = { press, ctrlChar, sequence, disarm, isCtrlArmed: () => ctrlArmed };
})();
