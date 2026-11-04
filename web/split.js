// cw split view (/split?s=<id>,<id>): up to four live sessions in one desktop tab. 1 pane fills
// the page, 2 sit side by side, 3-4 make a 2x2 grid (the free cell of 3 offers more sessions).
// Each pane frames the normal session page as /s/<id>?embed=1 (same origin: the cookie, the
// WebSocket and every session feature, drop/paste included, work unchanged); term.js hides its
// title bar there and this page draws a thin pane header instead: title, needs-input dot, A-/A+
// (the pane's cw.fontStep), open in a tab, close. The ids live in the URL (history.replaceState on
// every change), so the view can be bookmarked and reloaded. Titles and needs-input come from
// /ws/list (polling /api/sessions while it is down), so a rename made anywhere (list page, phone,
// `cw rename`) shows in the pane header as soon as the hub broadcasts it.
// Rename from the header: double-click the title or press ✎. The title turns into an input in this
// page (not the frame, so typing never reaches the terminal): Enter or ✓ saves through the same
// PATCH /api/sessions/:id as the list and session pages (same trimming, 80-char cap, empty clears),
// Esc cancels, focus leaving it cancels (like those pages); save and Esc give focus back to the
// pane's terminal. A failure keeps the editor open, marks it and says why in the bar.
// Panes are never moved in the DOM once created: re-parenting an iframe reloads it (and re-attaches
// its session). Layout changes are CSS only (.n1-.n4 on the grid).
// Pane sizes: one column divider (2-4 panes) and one row divider (3-4 panes) cross the whole grid,
// so they are just the grid's two track pairs (--split-cols / --split-rows) and every pane keeps
// its cell. Drag, double-click (back to 50/50) or focus + arrow keys. The split is kept in the URL
// as percentages of the left column / top row (&w=62&h=40, left out at 50). Each pane's terminal
// refits through its own ResizeObserver (term.js, debounced) and reports its size only while it
// owns it; during a drag the panes hold their layout (cw.holdLayout), so a drag ends with one PTY
// resize per pane, not one per pause of the pointer.
// New session: the free cell also starts one (project or typed path + harness, POST /api/sessions)
// and opens it as a pane, so an empty pane never needs a trip to the list page. The header's
// "+ new session…" option reaches the same form at any pane count: it focuses the form in the free
// cell, or (1-2 panes, no free cell) moves that one form into a popover under the header
// (#add-pop) until Esc, a click outside, or a successful start puts it back.
// window.cwSplit holds the pure helpers (parseIds, layoutFor, ...), unit-tested from Node.
// Needs /app/recent-filter.js loaded first (displayTitle).
(() => {
  'use strict';

  const MAX_PANES = 4;
  const ID_RE = /^[0-9a-f]{8}$/;

  // ---------- pure helpers (also exported for tests) ----------
  /**
   * Session ids from a query string: every `s` parameter, comma-separated, lower-cased, only valid
   * 8-hex ids, duplicates dropped (one session twice would make two panes fight over its size),
   * at most MAX_PANES.
   */
  function parseIds(search) {
    let q;
    try { q = new URLSearchParams(search || ''); } catch { return []; }
    const out = [];
    for (const part of q.getAll('s').join(',').split(',')) {
      const id = part.trim().toLowerCase();
      if (!ID_RE.test(id) || out.includes(id)) continue;
      out.push(id);
      if (out.length === MAX_PANES) break;
    }
    return out;
  }
  /**
   * The split URL for these ids (commas kept readable), plus the divider positions that apply to
   * this many panes and differ from 50 (w: left column % from 2 panes, h: top row % from 3).
   */
  function splitUrl(ids, sizes) {
    if (!ids.length) return '/split';
    let url = `/split?s=${ids.join(',')}`;
    if (sizes && ids.length >= 2 && sizes.w !== EVEN) url += `&w=${sizes.w}`;
    if (sizes && ids.length >= 3 && sizes.h !== EVEN) url += `&h=${sizes.h}`;
    return url;
  }
  /** Grid shape for n panes: {cols, rows, cells, free} (free: empty cells, filled by the add cell). */
  function layoutFor(n) {
    const k = Math.max(0, Math.min(MAX_PANES, n | 0));
    if (k <= 1) return { cols: 1, rows: 1, cells: 1, free: 1 - k };
    if (k === 2) return { cols: 2, rows: 1, cells: 2, free: 0 };
    return { cols: 2, rows: 2, cells: 4, free: 4 - k };
  }
  /** ids plus id (unchanged when invalid, already there, or full). */
  function addId(ids, id) {
    const v = String(id || '').toLowerCase();
    if (!ID_RE.test(v) || ids.includes(v) || ids.length >= MAX_PANES) return ids.slice();
    return [...ids, v];
  }
  const removeId = (ids, id) => ids.filter((x) => x !== id);
  /** `from` replaced by `to` in place (a resumed session); drops `from` if `to` is already shown. */
  function replaceId(ids, from, to) {
    if (!ID_RE.test(String(to)) || !ids.includes(from)) return ids.slice();
    if (ids.includes(to)) return removeId(ids, from);
    return ids.map((x) => (x === from ? to : x));
  }
  /**
   * Session list entries with the user's title of `id` set to userTitle (null clears), so a saved
   * name shows before the /ws/list broadcast lands. New array; other entries kept as they are.
   */
  function withUserTitle(list, id, userTitle) {
    if (!Array.isArray(list)) return [];
    return list.map((s) => (s && s.id === id ? { ...s, userTitle: userTitle || null } : s));
  }

  // ---------- pane sizes (pure) ----------
  // A size is the first pane's share of a divider's span, in percent (one decimal): w = left
  // column, h = top row. Each side keeps at least MIN_PCT and, when the span is known, MIN_PANE_PX.
  const EVEN = 50;
  const MIN_PCT = 15;
  const MIN_PANE_PX = 120;
  const KEY_STEP = 2; // % per arrow key; Shift: KEY_STEP_BIG
  const KEY_STEP_BIG = 10;
  const round1 = (v) => Math.round(v * 10) / 10;
  /** Smallest allowed share (%) for a span of totalPx (0 / unknown: MIN_PCT only); at most 50. */
  function minPct(totalPx) {
    const lo = totalPx > 0 ? Math.max(MIN_PCT, (MIN_PANE_PX * 100) / totalPx) : MIN_PCT;
    return Math.min(EVEN, lo);
  }
  /** v clamped so neither side gets less than minPct(totalPx); junk gives 50. */
  function clampPct(v, totalPx) {
    const n = typeof v === 'number' ? v : NaN;
    if (!Number.isFinite(n)) return EVEN;
    const lo = minPct(totalPx);
    return round1(Math.min(100 - lo, Math.max(lo, n)));
  }
  /** {w, h} from a query string (&w=62.5&h=40); missing or junk values are 50. */
  function parseSizes(search) {
    let q;
    try { q = new URLSearchParams(search || ''); } catch { return { w: EVEN, h: EVEN }; }
    const one = (k) => {
      const s = (q.get(k) || '').trim();
      return /^\d{1,3}(\.\d+)?$/.test(s) ? clampPct(Number(s)) : EVEN;
    };
    return { w: one('w'), h: one('h') };
  }
  /**
   * Sizes for a grid of n panes: 0-1 panes have no divider (both 50); 2 panes only the column
   * divider, so the row size goes back to 50 (a 4 -> 2 -> 3 sequence starts the new row even);
   * 3-4 panes keep both (adding or closing a pane in the 2x2 keeps the cross where it was).
   */
  function adaptSizes(sizes, n) {
    const s = sizes || {};
    if (n <= 1) return { w: EVEN, h: EVEN };
    const w = clampPct(s.w);
    return n === 2 ? { w, h: EVEN } : { w, h: clampPct(s.h) };
  }
  /** Size after a drag of deltaPx across a span of trackPx, starting from startPct. */
  function dragPct(startPct, deltaPx, trackPx) {
    if (!(trackPx > 0)) return clampPct(startPct);
    return clampPct(startPct + (deltaPx * 100) / trackPx, trackPx);
  }
  /**
   * Size after a key on a divider (axis 'w': Left/Right, 'h': Up/Down; Shift: bigger step;
   * Home/End: smallest/largest), or null when the key does nothing there.
   */
  function nudgePct(pct, key, { axis = 'w', shift = false, totalPx = 0 } = {}) {
    const step = shift ? KEY_STEP_BIG : KEY_STEP;
    const [less, more] = axis === 'h' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const lo = minPct(totalPx);
    if (key === less) return clampPct(pct - step, totalPx);
    if (key === more) return clampPct(pct + step, totalPx);
    if (key === 'Home') return round1(lo);
    if (key === 'End') return round1(100 - lo);
    return null;
  }
  /** A grid track pair for a split at pct: `minmax(0, 62fr) minmax(0, 38fr)`. */
  function tracks(pct) {
    const a = clampPct(pct);
    return `minmax(0, ${a}fr) minmax(0, ${round1(100 - a)}fr)`;
  }

  /** POST /api/sessions body from the add-cell form: the typed path wins; null without a cwd. */
  function newSessionBody({ project, path, harness } = {}) {
    const typed = typeof path === 'string' ? path.trim() : '';
    const picked = typeof project === 'string' ? project.trim() : '';
    const cwd = typed || picked;
    if (!cwd) return null;
    const h = typeof harness === 'string' ? harness.trim() : '';
    return h ? { cwd, harness: h } : { cwd };
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.cwSplit = {
    MAX_PANES, parseIds, splitUrl, layoutFor, addId, removeId, replaceId, withUserTitle, newSessionBody,
    EVEN, MIN_PCT, MIN_PANE_PX, minPct, clampPct, parseSizes, adaptSizes, dragPct, nudgePct, tracks,
  };

  // ---------- the page ----------
  if (typeof document === 'undefined' || !document.getElementById('split-grid')) return;
  const $ = (id) => document.getElementById(id);
  const { displayTitle, normalizeTitle, isSameTitle, TITLE_MAX } = window.cwRecentFilter;
  const grid = $('split-grid');
  const addCell = $('add-cell');
  const addList = $('add-list');
  const addSelect = $('split-add');
  const addPop = $('add-pop');
  const NEW_VALUE = '__new__';
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };
  const basename = (p) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) || s : s;
  };

  let ids = parseIds(location.search);
  let sizes = adaptSizes(parseSizes(location.search), ids.length);
  let running = [];
  let recent = [];
  let listed = false; // a session list has arrived at least once
  let renameErr = ''; // the last failed rename, kept in the bar while its editor stays open
  const panes = new Map(); // id -> {node, frame, title, edit, form, input, ok, idx, dot, badge}

  const find = (id) => running.find((s) => s.id === id) || recent.find((s) => s.id === id) || null;
  const nameOf = (s, id) => (s ? displayTitle(s) || basename(s.cwd) : id);
  const paneCw = (id) => {
    const p = panes.get(id);
    try { return p && p.frame.contentWindow ? p.frame.contentWindow.cw || null : null; } catch { return null; }
  };

  function status(text) { $('split-status').textContent = text || ''; }

  let urlTimer = null;
  function syncUrl() {
    clearTimeout(urlTimer);
    urlTimer = null;
    const url = splitUrl(ids, sizes);
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }
  // Held arrow keys repeat fast; browsers throttle bursts of replaceState.
  function syncUrlSoon() {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(syncUrl, 300);
  }

  // ---------- dividers ----------
  const dividers = { w: $('split-col'), h: $('split-row') };
  /** The span a divider splits (both tracks, without padding and gap), in CSS px. */
  function trackPx(axis) {
    const cs = getComputedStyle(grid);
    const px = (v) => parseFloat(v) || 0;
    return axis === 'w'
      ? grid.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.columnGap)
      : grid.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.rowGap);
  }
  function applySizes() {
    grid.style.setProperty('--split-cols', tracks(sizes.w));
    grid.style.setProperty('--split-rows', tracks(sizes.h));
    grid.style.setProperty('--split-w', String(sizes.w / 100));
    grid.style.setProperty('--split-h', String(sizes.h / 100));
    for (const [axis, d] of Object.entries(dividers)) {
      const v = sizes[axis];
      const lo = d.hidden ? MIN_PCT : Math.round(minPct(trackPx(axis)));
      d.setAttribute('aria-valuemin', String(lo));
      d.setAttribute('aria-valuemax', String(100 - lo));
      d.setAttribute('aria-valuenow', String(v));
      d.setAttribute('aria-valuetext', axis === 'w'
        ? `left ${Math.round(v)}%, right ${Math.round(100 - v)}%`
        : `top ${Math.round(v)}%, bottom ${Math.round(100 - v)}%`);
    }
  }
  function setSize(axis, v, { url = 'now' } = {}) {
    if (sizes[axis] !== v) { sizes = { ...sizes, [axis]: v }; applySizes(); }
    if (url === 'now') syncUrl();
    else if (url === 'soon') syncUrlSoon();
  }
  // While a divider is dragged the panes' terminals neither refit nor report a size (term.js
  // cw.holdLayout); on release each refits once. Without it a slow drag sends a resize per pause.
  function holdPanes(on) {
    for (const id of panes.keys()) {
      const c = paneCw(id);
      if (c && typeof c.holdLayout === 'function') c.holdLayout(on);
    }
  }
  function wireDivider(axis) {
    const d = dividers[axis];
    let drag = null; // {id, start, from, track}
    let frame = 0;
    let want = null;
    const pos = (e) => (axis === 'w' ? e.clientX : e.clientY);
    // A mouse press must not move focus off the terminal (Tab still reaches the divider).
    d.addEventListener('mousedown', (e) => e.preventDefault());
    const move = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      want = dragPct(drag.start, pos(e) - drag.from, drag.track);
      // One layout per frame; the panes' own resize debounce turns the drag into one PTY resize.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (drag && want !== null) setSize(axis, want, { url: 'none' }); });
    };
    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      drag = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      document.body.classList.remove('split-dragging', 'drag-x', 'drag-y');
      d.classList.remove('dragging');
      setSize(axis, want === null ? sizes[axis] : want);
      want = null;
      holdPanes(false); // each pane refits once to its final size and reports it (if it owns it)
    };
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      end(); // a drag whose release never arrived must not block this one
      drag = { id: e.pointerId, start: sizes[axis], from: pos(e), track: trackPx(axis) };
      // Pointer capture keeps the moves coming when the pointer leaves the window; the window
      // listeners cover a capture that did not take. Frames swallow pointer events, so they are
      // switched off for the drag (CSS body.split-dragging).
      try { d.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
      document.body.classList.add('split-dragging', axis === 'w' ? 'drag-x' : 'drag-y');
      d.classList.add('dragging');
      holdPanes(true);
    });
    d.addEventListener('lostpointercapture', end);
    d.addEventListener('dblclick', () => setSize(axis, EVEN));
    d.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const v = nudgePct(sizes[axis], e.key, { axis, shift: e.shiftKey, totalPx: trackPx(axis) });
      if (v === null) return;
      e.preventDefault();
      setSize(axis, v, { url: 'soon' });
    });
  }
  wireDivider('w');
  wireDivider('h');

  function focusPane(id) {
    const c = paneCw(id);
    if (c && typeof c.focus === 'function') c.focus();
    else { const p = panes.get(id); if (p) p.frame.focus(); }
  }
  function setActive(id) {
    for (const [pid, p] of panes) p.node.classList.toggle('active', pid === id);
  }

  // ---------- rename (pane header) ----------
  function openRename(p) {
    if (!p.form.hidden) { p.input.focus(); return; }
    const s = find(p.id);
    p.input.value = s ? displayTitle(s) || '' : '';
    p.input.placeholder = s ? s.title || basename(s.cwd) : p.id;
    p.input.classList.remove('bad');
    p.input.title = '';
    p.title.hidden = true;
    p.edit.hidden = true;
    p.form.hidden = false;
    p.input.focus();
    p.input.select();
  }
  /** Back to the title; focus: true hands the keyboard back to the pane's terminal. */
  function closeRename(p, { focus = false } = {}) {
    if (renameErr) { renameErr = ''; status(''); }
    p.form.hidden = true;
    p.title.hidden = false;
    p.edit.hidden = false;
    if (focus && panes.get(p.id) === p) focusPane(p.id);
  }
  async function saveRename(p) {
    if (p.saving) return;
    const id = p.id;
    const s = find(id);
    // Unchanged (including Claude's title saved as is): nothing to store, so a transcript title is
    // never pinned as the user's name. Same check as the list and session pages.
    if (s && isSameTitle(s, normalizeTitle(p.input.value))) { closeRename(p, { focus: true }); return; }
    p.saving = true;
    p.input.readOnly = true;
    p.ok.disabled = true;
    renameErr = '';
    status('');
    try {
      const r = await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: p.input.value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // The /ws/list broadcast brings the same; apply it now so the old name does not flash.
      running = withUserTitle(running, id, j.userTitle);
      recent = withUserTitle(recent, id, j.userTitle);
      // Focus goes back to the terminal only if it was still in the editor (not if the user
      // clicked elsewhere while the request ran).
      closeRename(p, { focus: p.form.contains(document.activeElement) });
      render();
    } catch (e) {
      renameErr = `rename failed: ${e.message}`;
      status(renameErr);
      p.input.classList.add('bad');
      p.input.title = renameErr;
      if (!p.form.hidden) p.input.focus(); // keep the editor usable (✓ was disabled while saving)
    } finally {
      p.saving = false;
      p.input.readOnly = false;
      p.ok.disabled = false;
    }
  }
  function wireRename(p) {
    p.input.maxLength = TITLE_MAX;
    p.title.addEventListener('dblclick', (e) => { e.preventDefault(); openRename(p); });
    p.form.addEventListener('submit', (e) => { e.preventDefault(); saveRename(p); });
    p.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (p.saving) return;
      closeRename(p, { focus: true });
    });
    // mousedown keeps focus in the input, so pressing ✓ never blurs it first (which would cancel).
    p.ok.addEventListener('mousedown', (e) => e.preventDefault());
    p.form.addEventListener('focusout', (e) => {
      if (p.saving || (e.relatedTarget && p.form.contains(e.relatedTarget))) return;
      closeRename(p);
    });
  }

  function makePane(id) {
    const dot = el('span', { class: 'dot warn' });
    const title = el('span', { class: 'pane-title', text: id });
    const idx = el('span', { class: 'pane-idx' });
    const badge = el('span', { class: 'badge', text: 'needs input', hidden: true });
    const frame = el('iframe', { class: 'pane-frame', src: `/s/${id}?embed=1`, title: `session ${id}` });
    const btn = (text, label, fn, cls = 'btn') => el('button', {
      class: cls, type: 'button', title: label, 'aria-label': label, text,
      on: { mousedown: (e) => e.preventDefault(), click: (e) => { e.stopPropagation(); fn(); } },
    });
    const edit = btn('✎', 'Rename this session', () => openRename(p), 'btn pane-edit');
    const input = el('input', {
      class: 'pane-rename', type: 'text', name: 'title', enterkeyhint: 'done', autocomplete: 'off',
      spellcheck: 'false', 'aria-label': 'Session name (empty clears it)',
    });
    const ok = el('button', { class: 'btn pane-rename-ok', type: 'submit', title: 'Save name', 'aria-label': 'Save name', text: '✓' });
    const form = el('form', { class: 'pane-rename-form', hidden: true }, input, ok);
    const open = el('a', { class: 'btn', href: `/s/${id}`, target: '_blank', rel: 'noopener', title: 'Open in its own tab', 'aria-label': 'Open in its own tab', text: '↗' });
    // Codex sessions only: the pane's Focus view (web/focus.js), which reports its state back here.
    const focusBtn = btn('Focus', 'Focus: show only the conversation', () => {
      const c = paneCw(p.id);
      if (c && c.focusMode) c.focusMode.toggle();
    }, 'btn pane-focus');
    focusBtn.hidden = true;
    focusBtn.setAttribute('aria-pressed', 'false');
    const head = el('header', { class: 'pane-head', title: 'Click to focus this terminal; drop a file here to upload it to this session' },
      dot, title, form, edit, idx, badge, el('span', { class: 'spacer' }),
      focusBtn,
      btn('A−', 'Smaller font', () => { const c = paneCw(p.id); if (c && c.fontStep) c.fontStep(-1); }),
      btn('A+', 'Larger font', () => { const c = paneCw(p.id); if (c && c.fontStep) c.fontStep(1); }),
      open,
      btn('×', 'Close this pane', () => closePane(p.id)));
    const node = el('section', { class: 'pane', 'data-id': id }, head, frame);
    const p = { id, node, frame, title, edit, form, input, ok, idx, dot, badge, open, focusBtn, focusAvail: null, saving: false };
    wireRename(p);
    head.addEventListener('click', (e) => { if (!e.target.closest('a, button, form')) focusPane(p.id); });
    // A file dropped on the header goes to this pane's session (the frame handles drops on itself).
    head.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    head.addEventListener('drop', (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const c = paneCw(p.id);
      if (c && c.drop) c.drop.upload([...e.dataTransfer.files]);
      else status('that pane is not ready for uploads');
    });
    frame.addEventListener('load', () => {
      // Same origin: the pane's own window tells us when it gets focus (clicks inside the frame
      // never reach this page).
      try {
        frame.contentWindow.addEventListener('focus', () => setActive(p.id));
        if (p.wantFocus) { p.wantFocus = false; focusPane(p.id); }
      } catch { /* not same-origin (should not happen) */ }
    });
    return p;
  }

  function renderPane(p) {
    const s = find(p.id);
    const name = nameOf(s, p.id);
    p.title.textContent = name;
    p.title.title = `${s ? s.cwd : p.id} · double-click to rename`;
    p.idx.textContent = s ? `#${s.index}` : '';
    const live = s && s.state === 'running' && running.includes(s);
    p.badge.hidden = !(live && s.needsInput);
    p.dot.className = `dot ${live ? (s.needsInput ? 'warn' : 'ok') : (listed ? 'bad' : 'warn')}`;
    p.node.classList.toggle('ended', listed && !live);
    if (s) window.cwAccent.paint(p.node, s.cwd); // --sc: pane border / header stripe
    p.frame.title = `session ${name}`;
    // The pane says whether it can focus (its harness); until it has, trust the session list.
    p.focusBtn.hidden = !(p.focusAvail ?? (!!s && s.harness === 'codex'));
  }

  // ---------- new session (add cell) ----------
  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text.trim() }; } }
    if (!res.ok) {
      throw new Error(res.status === 401
        ? 'unauthorized: open the login URL from `cw url` once'
        : (data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }
  const joinPath = (r, name) => {
    const sep = r.includes('\\') || !r.includes('/') ? '\\' : '/';
    return r.replace(/[\\/]+$/, '') + sep + name;
  };
  const newForm = { form: $('add-new'), project: $('add-project'), path: $('add-path'),
    harness: $('add-harness'), start: $('add-start'), error: $('add-error') };
  async function loadProjects() {
    try {
      const p = await api('GET', '/api/projects');
      const rec = Array.isArray(p.recent) ? p.recent : [];
      const roots = Array.isArray(p.roots) ? p.roots : [];
      newForm.project.replaceChildren(
        el('option', { value: '', text: '— project —' }),
        ...(rec.length ? [el('optgroup', { label: 'Recent' },
          ...rec.map((r) => el('option', { value: r.cwd, title: r.cwd, text: basename(r.cwd) })))] : []),
        ...roots.map((r) => el('optgroup', { label: r.root },
          el('option', { value: r.root, title: r.root, text: `${basename(r.root)} (root)` }),
          ...(r.dirs || []).map((d) => {
            const full = joinPath(r.root, d);
            return el('option', { value: full, title: full, text: d });
          }))));
    } catch (e) {
      newForm.project.replaceChildren(el('option', { value: '', text: 'unavailable' }));
      newForm.error.textContent = `could not load projects: ${e.message}`;
    }
  }
  async function loadHarnesses() {
    try {
      const j = await api('GET', '/api/harnesses');
      const list = Array.isArray(j.harnesses) ? j.harnesses : [];
      newForm.harness.replaceChildren(...list.map((x) => el('option', {
        value: x.id, disabled: x.available === false, title: x.unavailableReason || '',
        text: x.available === false ? `${x.label} (unavailable)` : x.label,
      })));
      const usable = (id) => list.some((x) => x.id === id && x.available !== false);
      newForm.harness.value = [j.default, 'claude'].find((id) => id && usable(id)) || '';
    } catch {
      newForm.harness.replaceChildren(); // no harness: the hub picks its default
    }
  }
  newForm.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ids.length >= MAX_PANES) return;
    newForm.error.textContent = '';
    const body = newSessionBody({
      project: newForm.project.value, path: newForm.path.value, harness: newForm.harness.value,
    });
    if (!body) { newForm.error.textContent = 'pick a project or type a path'; return; }
    newForm.start.disabled = true;
    newForm.start.textContent = 'Starting…';
    try {
      const r = await api('POST', '/api/sessions', body);
      if (!r || !r.id) throw new Error('hub returned no session id');
      newForm.path.value = '';
      newForm.project.value = '';
      closePop();
      addPane(r.id);
    } catch (err) {
      newForm.error.textContent = err.message;
    } finally {
      newForm.start.disabled = false;
      newForm.start.textContent = 'Start session';
    }
  });

  // Popover for the new-session form when the free cell is not on screen. One form node: it moves
  // into #add-pop while open and back to the end of #add-cell on close.
  const popOpen = () => !addPop.hidden;
  function closePop() {
    if (!popOpen()) return;
    addPop.hidden = true;
    addCell.append(newForm.form);
    newForm.error.textContent = '';
  }
  function openNewSession() {
    if (ids.length >= MAX_PANES) return;
    if (!addCell.hidden) { closePop(); newForm.project.focus(); return; }
    if (!popOpen()) addPop.append(newForm.form);
    addPop.hidden = false;
    newForm.project.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popOpen()) closePop(); });
  document.addEventListener('pointerdown', (e) => {
    if (popOpen() && !addPop.contains(e.target) && e.target !== addSelect) closePop();
  });
  // Clicks inside a pane frame never bubble here: losing focus to the frame closes it too.
  window.addEventListener('blur', () => {
    if (popOpen() && document.activeElement && document.activeElement.tagName === 'IFRAME') closePop();
  });

  function render() {
    const lay = layoutFor(ids.length);
    grid.className = `split-grid n${ids.length}`;
    addCell.hidden = lay.free === 0;
    dividers.w.hidden = lay.cols < 2;
    dividers.h.hidden = lay.rows < 2;
    applySizes();
    const free = running.filter((s) => !ids.includes(s.id));
    addList.replaceChildren(...(free.length
      ? free.map((s) => el('button', {
        class: 'btn add-item', type: 'button', title: s.cwd,
        text: `#${s.index} ${nameOf(s, s.id)}${s.needsInput ? ' · needs input' : ''}`,
        on: { click: () => addPane(s.id) },
      }))
      : [el('div', { class: 'empty', text: listed ? 'No other running sessions.' : 'loading…' })]));
    if (ids.length >= MAX_PANES) closePop();
    else if (!addCell.hidden && popOpen()) closePop(); // the free cell appeared: use the form there
    addSelect.replaceChildren(
      el('option', { value: '', text: ids.length >= MAX_PANES ? `full (${MAX_PANES} panes)` : '+ add session…' }),
      ...(ids.length >= MAX_PANES ? [] : [el('option', { value: NEW_VALUE, text: '+ new session…' })]),
      ...free.map((s) => el('option', { value: s.id, text: `#${s.index} ${nameOf(s, s.id)}` })));
    addSelect.disabled = ids.length >= MAX_PANES;
    for (const p of panes.values()) renderPane(p);
    $('split-count').textContent = ids.length ? `${ids.length} of ${MAX_PANES}` : '';
    const attn = ids.some((id) => { const s = find(id); return s && s.needsInput && running.includes(s); });
    document.title = `${attn ? '! ' : ''}split (${ids.length}) · cw`;
  }

  function addPane(id, { focus = true } = {}) {
    const next = addId(ids, id);
    if (next.length === ids.length) return;
    ids = next;
    sizes = adaptSizes(sizes, ids.length);
    const p = makePane(id);
    p.wantFocus = focus;
    panes.set(id, p);
    grid.insertBefore(p.node, addCell); // new nodes only; existing panes are never moved
    syncUrl();
    render();
  }

  function closePane(id) {
    const p = panes.get(id);
    if (!p) return;
    panes.delete(id);
    p.node.remove(); // the frame unloads: its socket closes and the hub detaches that client
    ids = removeId(ids, id);
    sizes = adaptSizes(sizes, ids.length);
    syncUrl();
    render();
  }

  addSelect.addEventListener('change', () => {
    const id = addSelect.value;
    addSelect.value = '';
    if (id === NEW_VALUE) openNewSession();
    else if (id) addPane(id);
  });

  // A pane's Focus view changed (web/focus.js): mirror it on the header button.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.cwSplit !== 'focus') return;
    const p = panes.get(String(e.data.id));
    if (!p || e.source !== p.frame.contentWindow) return;
    p.focusAvail = !!e.data.available;
    p.focusBtn.hidden = !p.focusAvail;
    p.focusBtn.classList.toggle('on', !!e.data.on);
    p.focusBtn.setAttribute('aria-pressed', String(!!e.data.on));
  });

  // A pane resumed its exited session (term.js): it already loads the new one, so only the id moves.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.cwSplit !== 'replace') return;
    const { from, to } = e.data;
    const p = panes.get(from);
    if (!p || !ID_RE.test(String(to))) return;
    if (panes.has(to)) { closePane(from); return; }
    ids = replaceId(ids, from, to);
    panes.delete(from);
    p.id = to;
    p.node.dataset.id = to;
    p.open.href = `/s/${to}`;
    panes.set(to, p);
    syncUrl();
    render();
  });

  // A file dragged over the bar or a gap must never make the browser open it (and leave the split).
  const hasFiles = (dt) => !!dt && Array.prototype.includes.call(dt.types || [], 'Files');
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
  }

  // ---------- session list (titles, needs-input, the add picker) ----------
  function apply(msg) {
    running = Array.isArray(msg.running) ? msg.running : [];
    recent = Array.isArray(msg.recent) ? msg.recent : [];
    listed = true;
    status(renameErr);
    render();
  }
  async function refresh() {
    try {
      const r = await fetch('/api/sessions', { credentials: 'same-origin' });
      if (r.status === 401) { status('unauthorized: open the login URL from `cw url` once'); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      apply(await r.json());
    } catch {
      status('hub unreachable');
    }
  }
  let ws = null;
  let backoff = 500;
  let poll = null;
  function connectList() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/list`);
    ws = sock;
    sock.onopen = () => { backoff = 500; clearInterval(poll); poll = null; };
    sock.onmessage = (ev) => {
      if (ws !== sock || typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.t === 'sessions') apply(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (!poll) { refresh(); poll = setInterval(refresh, 5000); }
      setTimeout(connectList, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  }
  setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' })); }, 25000);

  // ---------- boot ----------
  syncUrl(); // drops junk, duplicates and extras from a hand-edited URL
  ids.forEach((id, i) => {
    const p = makePane(id);
    p.wantFocus = i === 0;
    panes.set(id, p);
    grid.insertBefore(p.node, addCell);
  });
  render();
  refresh();
  connectList();
  loadProjects();
  loadHarnesses();

  window.cwSplit.page = {
    get ids() { return ids.slice(); },
    get sizes() { return { ...sizes }; },
    add: (id) => addPane(id),
    close: closePane,
    focus: focusPane,
    rename: (id) => { const p = panes.get(id); if (p) openRename(p); },
    paneCw,
  };
})();
