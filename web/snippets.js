// cw snippet tray: exact text the session pushed for the phone to copy (`cw copy`, or an OSC 52
// clipboard write; src/hub/snippets.js), as chips with a one-tap Copy just above the key bar.
// Copying a command out of the terminal fails because agent CLIs hard-wrap long lines; this text
// is the original. The hub sends {t:'snippet', id, label, text, at, source} live and, after init,
// {t:'snippets', snippets:[...]} (oldest first), which replaces the list.
// Layout: hidden (takes no space) while empty, so the terminal keeps its size until the first
// snippet; one or two chips side by side; more than two collapse to the newest chip plus an
// "N snippets" pill whose list opens above the tray (floating, so opening it never resizes the
// terminal). × hides the tray until a newer snippet arrives.
// window.cwSnippets holds the pure logic (chipLabel, merge, replace, view; unit-tested from Node).
(() => {
  'use strict';
  const KEEP = 10; // the hub's SNIPPET_KEEP
  const COLLAPSE_AFTER = 2;
  const PREVIEW = 32; // characters of text a chip shows without a label
  const TITLE_MAX = 500; // characters of text in a chip's tooltip
  const COPIED_MS = 1500;

  const isSnippet = (s) => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.text === 'string';
  const oneLine = (s) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/ +/g, ' ').trim();

  /** What a chip shows: the label, else the first non-blank line of the text, cut to PREVIEW. */
  function chipLabel(s) {
    if (s.label) return s.label;
    const lines = s.text.split(/\r?\n/).map(oneLine);
    const first = lines.findIndex((l) => l !== '');
    if (first < 0) return '(blank)';
    let t = lines[first];
    const more = lines.slice(first + 1).some((l) => l !== '');
    if (t.length > PREVIEW - 1) return `${t.slice(0, PREVIEW - 1)}…`;
    if (more) t += '…';
    return t;
  }

  /** A live snippet added to the list (oldest first): duplicates and junk ignored, newest KEEP kept. */
  function merge(list, s) {
    if (!isSnippet(s) || list.some((x) => x.id === s.id)) return list;
    const next = [...list, s];
    return next.length > KEEP ? next.slice(next.length - KEEP) : next;
  }

  /** The hub's replay after init (authoritative). */
  function replace(snippets) {
    const list = Array.isArray(snippets) ? snippets.filter(isSnippet) : [];
    return list.slice(Math.max(0, list.length - KEEP));
  }

  /**
   * What the tray shows for `list` (oldest first). `expanded`: the pill's list is open;
   * `dismissedId`: the newest id when the user hid the tray (hidden until a newer one arrives).
   * @returns {{hidden:boolean, chips:object[], pill:string|null, panel:object[]|null}} newest first
   */
  function view(list, { expanded = false, dismissedId = null } = {}) {
    const newest = [...list].reverse();
    if (newest.length === 0 || newest[0].id === dismissedId) return { hidden: true, chips: [], pill: null, panel: null };
    if (newest.length <= COLLAPSE_AFTER) return { hidden: false, chips: newest, pill: null, panel: null };
    return { hidden: false, chips: newest.slice(0, 1), pill: `${newest.length} snippets`, panel: expanded ? newest : null };
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.cwSnippets = { chipLabel, merge, replace, view, KEEP, COLLAPSE_AFTER, PREVIEW };

  const cw = root.cw;
  if (!cw || typeof cw.onControl !== 'function' || typeof document === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const tray = $('snippets');
  const row = $('snip-row');
  const panel = $('snip-panel');
  const live = $('snip-status');
  if (!tray || !row || !panel) return;

  let list = [];
  let expanded = false;
  let dismissedId = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function copyButton(s, name) {
    const b = el('button', 'btn snip-copy', 'Copy');
    b.type = 'button';
    b.dataset.id = s.id;
    b.setAttribute('aria-label', `Copy ${name}`);
    return b;
  }
  function chip(s) {
    const name = chipLabel(s);
    const c = el('div', 'snip');
    c.setAttribute('role', 'group');
    c.setAttribute('aria-label', `Snippet: ${name}`);
    const label = el('span', 'snip-label', name);
    label.title = s.text.length > TITLE_MAX ? `${s.text.slice(0, TITLE_MAX)}…` : s.text;
    c.append(label, copyButton(s, name));
    return c;
  }
  function item(s) {
    const name = chipLabel(s);
    const li = el('div', 'snip-item');
    li.setAttribute('role', 'listitem');
    const body = el('div', 'snip-body');
    body.append(el('span', 'snip-name', name), el('code', 'snip-text', s.text.length > TITLE_MAX ? `${s.text.slice(0, TITLE_MAX)}…` : s.text));
    li.append(body, copyButton(s, name));
    return li;
  }

  function render() {
    const v = view(list, { expanded, dismissedId });
    const wasHidden = tray.hidden;
    tray.hidden = v.hidden;
    row.replaceChildren(...v.chips.map(chip));
    if (v.pill) {
      const p = el('button', 'btn snip-pill', `${v.pill} ${v.panel ? '▴' : '▾'}`);
      p.type = 'button';
      p.dataset.act = 'toggle';
      p.setAttribute('aria-expanded', String(!!v.panel));
      p.setAttribute('aria-controls', 'snip-panel');
      p.setAttribute('aria-label', `${v.pill}: ${v.panel ? 'hide the list' : 'show all'}`);
      row.append(p);
    }
    if (!v.hidden) {
      const x = el('button', 'btn snip-x', '×');
      x.type = 'button';
      x.dataset.act = 'dismiss';
      x.title = 'Hide snippets until the next one';
      x.setAttribute('aria-label', 'Hide snippets until the next one');
      row.append(x);
    }
    panel.hidden = !v.panel;
    panel.replaceChildren(...(v.panel || []).map(item));
    if (wasHidden !== tray.hidden) cw.relayout(); // the terminal area changed
  }

  function announce(text) { if (live) live.textContent = text; }

  cw.onControl((msg) => {
    if (msg.t === 'snippet') {
      const before = list;
      list = merge(list, msg);
      if (list === before) return;
      announce(`New snippet: ${chipLabel(msg)}`);
      render();
    } else if (msg.t === 'snippets') {
      list = replace(msg.snippets);
      render();
    }
  });

  // ---------- copy / toggle / dismiss ----------
  const copiedTimers = new WeakMap();
  async function copy(btn) {
    const s = list.find((x) => x.id === btn.dataset.id);
    if (!s || !cw.copy || !cw.copy.writeClipboard) return;
    const ok = await cw.copy.writeClipboard(s.text);
    const name = chipLabel(s);
    announce(ok ? `Copied ${name}` : 'Copy failed: clipboard blocked');
    if (ok && expanded && panel.contains(btn)) { expanded = false; render(); return; }
    // The button may have been re-rendered meanwhile; feedback goes to whichever is current.
    const b = btn.isConnected ? btn : tray.querySelector(`.snip-copy[data-id="${s.id}"]`);
    if (!b) return;
    clearTimeout(copiedTimers.get(b));
    b.textContent = ok ? 'Copied' : 'Failed';
    b.classList.toggle('ok', ok);
    b.classList.toggle('bad', !ok);
    copiedTimers.set(b, setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('ok', 'bad'); }, COPIED_MS));
  }
  // Keep focus where it is (terminal or compose) when a tray button is pressed, like the key bar.
  tray.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  tray.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('snip-copy')) { copy(b); return; }
    if (b.dataset.act === 'toggle') { expanded = !expanded; render(); return; }
    if (b.dataset.act === 'dismiss') {
      dismissedId = list.length ? list[list.length - 1].id : null;
      expanded = false;
      render();
    }
  });
  // The open list closes on Esc or a tap anywhere else.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expanded) { expanded = false; render(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (expanded && !tray.contains(e.target)) { expanded = false; render(); }
  }, true);

  cw.snippets = { list: () => list.slice(), render };
})();
