// cw compose bar: a textarea for phone keyboards (autocorrect, dictation). Enter sends the text
// followed by Enter (\r); Shift+Enter inserts a newline. Focus stays in the textarea.
(() => {
  'use strict';
  const cw = window.cw;
  if (!cw) return;
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };
  const KEY = 'cw.compose';
  const box = $('compose');
  const ta = $('compose-text');
  const sendBtn = $('compose-send');
  const toggles = [$('compose-toggle'), document.querySelector('#keybar [data-key="compose"]')].filter(Boolean);

  let shown = store.get(KEY) === '1';
  function apply() {
    box.hidden = !shown;
    for (const t of toggles) {
      t.classList.toggle('on', shown);
      t.setAttribute('aria-pressed', String(shown));
    }
    cw.relayout();
  }
  cw.toggleCompose = () => {
    shown = !shown;
    store.set(KEY, shown ? '1' : '0');
    apply();
    if (shown) ta.focus(); else cw.focus();
  };
  $('compose-toggle').addEventListener('click', cw.toggleCompose);
  /** Shows or hides the bar; save: false leaves the remembered preference alone (focus.js). */
  cw.setCompose = (on, { save = true } = {}) => {
    shown = !!on;
    if (save) store.set(KEY, shown ? '1' : '0');
    apply();
  };
  cw.composeShown = () => shown;
  cw.focusCompose = () => ta.focus();
  apply();

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.3))}px`;
    cw.relayout();
  }
  ta.addEventListener('input', autosize);

  /** Types `text` into the session and presses Enter (the compose bar's Send, and Talk mode's voice input). */
  function submit(text) {
    if (cw.keybar && cw.keybar.disarm) cw.keybar.disarm(); // an armed Ctrl must not outlive this send
    const term = cw.term;
    if (text) {
      if (/[\r\n]/.test(text) && term.modes.bracketedPasteMode) {
        // Multi-line: deliver as one bracketed paste so the newlines do not submit early.
        cw.send(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`, { filter: false });
      } else {
        cw.send(text, { filter: false });
      }
    }
    // Enter goes in its own frame, a moment later, so the app sees a keypress rather than a
    // paste that happens to end in a carriage return.
    setTimeout(() => cw.send('\r', { filter: false }), text ? 30 : 0);
  }
  cw.submitText = submit;

  function send() {
    submit(ta.value);
    ta.value = '';
    autosize();
    ta.focus();
  }

  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  });
  // Keep the textarea focused (and the phone keyboard open) when tapping Send.
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
  sendBtn.addEventListener('click', send);
})();
