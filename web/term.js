// cw terminal page: xterm.js attached to /ws/session/<id>. Handles init resync, input, the
// size-ownership policy (fit while owner, follow the owner's size otherwise), reconnect with
// backoff, heartbeat, exit overlay, and font size. Exposes window.cw for keybar.js/compose.js.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { displayTitle, normalizeTitle, isSameTitle, TITLE_MAX } = window.cwRecentFilter; // /app/recent-filter.js
  const { getHarness, inferHarness } = window.cwHarnesses; // /app/harnesses.js
  const harnessOf = (s) => getHarness(s && s.harness) || inferHarness(s && s.command);
  const MIN_COLS = 20;
  const MIN_ROWS = 5;
  const FONT_MIN = 10;
  const FONT_MAX = 24;
  const FONT_KEY = 'cw.fontSize';
  const PING_EVERY = 25000;
  const DEAD_AFTER = 60000;
  const RESIZE_DEBOUNCE = 100;
  const PAGE_SMOOTH_MS = 120; // PgUp/PgDn glide in the normal buffer (xterm smoothScrollDuration)

  // Terminal-generated reports (focus, DA, CPR, DSR, DECRQM, kitty, DCS/OSC replies). Mirrors the
  // hub's isPassiveInput: these never count as "the user typed here".
  const PASSIVE_RE = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*[cR]|\x1b\[\??[\d;]*n|\x1b\[\??[\d;]*\$y|\x1b\[\?[\d;]*u|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;
  const isPassive = (s) => s.length > 0 && PASSIVE_RE.test(s);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const basename = (p) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) || s : s;
  };

  const match = location.pathname.match(/^\/s\/([0-9a-f]{8})\/?$/);
  const sessionId = match ? match[1] : null;
  // Split view (web/split.js) frames this page as /s/<id>?embed=1: the pane header replaces the
  // title bar (CSS body.embedded), a narrow pane is not a phone (keybar-autohide.js), the page does
  // not grab focus on load, and the exit overlay's links act on the pane or the top window.
  const embedded = new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window;
  if (embedded) document.body.classList.add('embedded');

  // ---------- viewport (phones: keep bars above the on-screen keyboard) ----------
  const vv = window.visualViewport;
  function syncAppHeight() {
    const h = vv ? vv.height : window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    else document.documentElement.style.removeProperty('--app-h');
    if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
  }
  if (vv) {
    vv.addEventListener('resize', syncAppHeight);
    vv.addEventListener('scroll', syncAppHeight);
  }
  window.addEventListener('resize', syncAppHeight);
  syncAppHeight();

  // ---------- terminal ----------
  const stored = parseInt(store.get(FONT_KEY), 10);
  // The phone default goes by the window: in a split pane that is the split page, not the pane (all
  // panes then start at the same size, whatever width each had when it loaded).
  const viewWidth = (() => { try { return embedded ? window.parent.innerWidth : window.innerWidth; } catch { return window.innerWidth; } })();
  let fontSize = clamp(Number.isFinite(stored) ? stored : (viewWidth < 768 ? 12 : 14), FONT_MIN, FONT_MAX);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    allowProposedApi: true, // registerDecoration (term-tint.js)
    theme: {
      background: '#0b0e12',
      foreground: '#d8dee7',
      cursor: '#d8dee7',
      cursorAccent: '#0b0e12',
      selectionBackground: 'rgba(79, 209, 176, 0.30)',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  const wrap = $('term-wrap');
  term.open($('term'));
  // Per-session palette + text-type colors (term-tint.js); set from the session's meta in renderMeta.
  const tint = window.cwTermTint ? window.cwTermTint.attach(term) : null;
  // Phone keyboards: no autocorrect/capitalisation inside the terminal (use the compose bar for that).
  if (term.textarea) {
    for (const [k, v] of [['autocorrect', 'off'], ['autocapitalize', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false']]) {
      term.textarea.setAttribute(k, v);
    }
  }

  // ---------- size ownership ----------
  // True while this client should own the size (it typed last, or it is fitted and visible):
  // it fits to its container and reports its size, including after a reconnect. False while
  // following another owner: it renders at the owner's size and attaches without a size, so the
  // hub never makes it the owner until the user types here.
  let wantOwner = true;
  let lastSent = null; // size this client last reported to the hub on the current socket

  function laidOut() {
    return document.visibilityState === 'visible' && wrap.clientWidth > 0 && wrap.clientHeight > 0;
  }
  function proposed() {
    if (!laidOut()) return null;
    let d;
    try { d = fit.proposeDimensions(); } catch { return null; }
    if (!d || !(d.cols > 0) || !(d.rows > 0)) return null;
    return { cols: Math.max(MIN_COLS, d.cols), rows: Math.max(MIN_ROWS, d.rows) };
  }
  function fitLocal() {
    const d = proposed();
    if (d && (d.cols !== term.cols || d.rows !== term.rows)) term.resize(d.cols, d.rows);
    return d;
  }
  function sendResize(d) {
    if (!d || d.cols < MIN_COLS || d.rows < MIN_ROWS) return;
    if (lastSent && lastSent.cols === d.cols && lastSent.rows === d.rows) return;
    if (sendJson({ t: 'resize', cols: d.cols, rows: d.rows })) lastSent = { cols: d.cols, rows: d.rows };
  }
  function setFollow(on) {
    wantOwner = !on;
    wrap.classList.toggle('follow', on);
    updateFollowNote();
  }
  function updateFollowNote() {
    // .follow-y: the owner's terminal is taller than this window, so touch drags pan it natively.
    wrap.classList.toggle('follow-y', !wantOwner && wrap.scrollHeight > wrap.clientHeight + 1);
    let show = false;
    if (!wantOwner && !exited) {
      const d = proposed();
      show = !d || d.cols !== term.cols || d.rows !== term.rows;
    }
    $('follow-note').hidden = !show;
  }
  // Called for every piece of user input: typing here makes this client the owner again.
  function takeOwnership() {
    if (wantOwner) return;
    setFollow(false);
    const d = fitLocal();
    if (d) sendResize(d);
  }
  // Hub says another client owns the size.
  function followOwner(cols, rows) {
    setFollow(true);
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    updateFollowNote();
    requestAnimationFrame(updateFollowNote); // overflow (.follow-y) once the resize has rendered
  }

  let layoutTimer = null;
  let layoutHeld = false; // cw.holdLayout: a split-view divider is being dragged
  function scheduleLayout() {
    clearTimeout(layoutTimer);
    if (layoutHeld) return;
    layoutTimer = setTimeout(onLayout, RESIZE_DEBOUNCE);
  }
  function onLayout() {
    if (!laidOut()) return;
    if (wantOwner) sendResize(fitLocal());
    updateFollowNote();
  }
  // Window resize / orientation change, plus anything that changes the terminal area (bars
  // toggled, compose growing, font change).
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('orientationchange', scheduleLayout);
  if (vv) vv.addEventListener('resize', scheduleLayout);
  new ResizeObserver(scheduleLayout).observe(wrap);

  // ---------- socket ----------
  const enc = new TextEncoder();
  let ws = null;
  let exited = false;
  let backoff = 500;
  let reconnectTimer = null;
  let lastRx = 0;
  let lastPing = 0;
  let unansweredSince = 0;
  let meta = null; // this session's summary from /ws/list or /api/sessions
  let started = false; // first attach happened

  function sendJson(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }
  function sendBytes(u8) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(u8);
    return true;
  }

  const inputFilters = [];
  const controlListeners = [];
  function userInput(data, { filter = true } = {}) {
    if (!data) return;
    if (filter) for (const f of inputFilters) data = f(data);
    takeOwnership();
    sendBytes(enc.encode(data));
  }
  term.onData((data) => {
    if (isPassive(data)) { sendBytes(enc.encode(data)); return; }
    userInput(data);
  });
  term.onBinary((data) => {
    const u8 = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) u8[i] = data.charCodeAt(i) & 0xff;
    takeOwnership();
    sendBytes(u8);
  });

  function banner(text) {
    const b = $('banner');
    b.textContent = text || '';
    b.hidden = !text;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (exited || !sessionId) return;
    started = true;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const params = new URLSearchParams({ kind: 'web' });
    // Report a size only if we want the size and are visible and laid out. Without a size the hub
    // attaches us with none, so a follower (or a hidden tab) never becomes the owner by attaching.
    const d = wantOwner ? proposed() : null;
    if (d) {
      if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows);
      params.set('cols', d.cols);
      params.set('rows', d.rows);
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/session/${sessionId}?${params}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    lastSent = d ? { cols: d.cols, rows: d.rows } : null;
    let opened = false;

    sock.onopen = () => {
      opened = true;
      lastRx = Date.now();
      lastPing = Date.now();
      unansweredSince = 0;
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastRx = Date.now();
      unansweredSince = 0;
      if (typeof ev.data !== 'string') {
        term.write(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'init') onInit(msg);
      else if (msg.t === 'resize') { if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) followOwner(msg.cols, msg.rows); }
      else if (msg.t === 'exit') onExit(msg.code);
      // Everything else (the snippet tray's 'snippet'/'snippets') goes to cw.onControl listeners.
      else for (const fn of controlListeners) { try { fn(msg); } catch { /* a listener must not break the socket */ } }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (exited) return;
      if (ev.code === 4404) { onGone(); return; }
      setDot('warn');
      banner('reconnecting…');
      if (!opened) checkAuth();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (exited) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }

  // Heartbeat: ping every 25 s; if nothing arrived for 60 s since an unanswered ping, reconnect.
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (unansweredSince && now - lastRx >= DEAD_AFTER) {
      const dead = ws;
      ws = null;
      try { dead.close(); } catch { /* ignore */ }
      if (!exited) { banner('reconnecting…'); setDot('warn'); scheduleReconnect(); }
      return;
    }
    if (now - lastPing >= PING_EVERY) {
      lastPing = now;
      if (!unansweredSince) unansweredSince = now;
      sendJson({ t: 'ping' });
    }
  }, 5000);

  // A failed upgrade says nothing in the browser; ask the API whether it is auth or the hub.
  async function checkAuth() {
    try {
      const r = await fetch('/api/sessions', { credentials: 'same-origin' });
      if (r.status === 401) {
        exited = true;
        clearTimeout(reconnectTimer);
        finish();
        showOverlay('unauthorized', 'This browser has no valid cw token. Open the login URL printed by `cw url` once.', false);
        banner('');
      }
    } catch {
      banner('hub unreachable · reconnecting…');
    }
  }

  function onInit(msg) {
    backoff = 500;
    banner('');
    setDot('ok');
    const cols = Number.isInteger(msg.cols) ? msg.cols : term.cols;
    const rows = Number.isInteger(msg.rows) ? msg.rows : term.rows;
    term.reset();
    term.resize(cols, rows);
    if (typeof msg.data === 'string' && msg.data) term.write(msg.data);
    // Keep the role we had: a follower stays a follower until the user types here; an owner stays
    // an owner and refits after the init resize (which also undoes any refit made while connecting,
    // and sends our fitted size when we attached hidden or without one).
    const owner = wantOwner;
    setFollow(!owner);
    if (typeof msg.needsInput === 'boolean') setNeedsInput(msg.needsInput);
    if (owner) scheduleLayout();
  }

  /** The session is over (exit, gone, unauthorized): stop the list socket and drop an armed Ctrl. */
  function finish() {
    stopList();
    if (window.cw && window.cw.keybar && window.cw.keybar.disarm) window.cw.keybar.disarm();
  }

  function onExit(code) {
    exited = true;
    clearTimeout(reconnectTimer);
    finish();
    banner('');
    setDot('bad');
    setState('exited');
    setNeedsInput(false);
    const c = code === null || code === undefined ? '?' : code;
    showOverlay(`session exited (code ${c})`, '', true);
  }

  function onGone() {
    exited = true;
    clearTimeout(reconnectTimer);
    finish();
    banner('');
    setDot('bad');
    setState('ended');
    setNeedsInput(false);
    showOverlay('session not found', 'It ended, or it belonged to an earlier hub run.', true);
  }

  // ---------- overlay / resume ----------
  // Same rules as the list page's Resume/Continue button (web/list.js resumeAction).
  function resumeAction(s) {
    if (s.claudeSessionId) {
      // A recorded Claude session id wins whatever the harness (a shell that ran claude inside).
      return { label: 'Resume', body: { cwd: s.cwd, resume: s.claudeSessionId }, title: `claude --resume ${s.claudeSessionId}` };
    }
    const h = harnessOf(s);
    if (!h || h.id === 'claude') {
      return s.claudeSessionId
        ? { label: 'Resume', body: { cwd: s.cwd, resume: s.claudeSessionId }, title: `claude --resume ${s.claudeSessionId}` }
        : { label: 'Resume', none: 'No Claude session id was recorded for this session' };
    }
    if (s.harnessSessionId && h.resumeArgs) {
      return { label: 'Resume', body: { cwd: s.cwd, harness: h.id, resume: s.harnessSessionId }, title: `${h.command} ${h.resumeArgs(s.harnessSessionId).join(' ')}` };
    }
    if (h.continueArgs) {
      return { label: 'Continue', body: { cwd: s.cwd, harness: h.id, continue: true }, title: `${h.command} ${h.continueArgs.join(' ')} in ${s.cwd}` };
    }
    if (h.modelRequired && !s.model) return { label: 'Start again', none: 'No model was recorded for this session' };
    return {
      label: 'Start again',
      body: s.model ? { cwd: s.cwd, harness: h.id, model: s.model } : { cwd: s.cwd, harness: h.id },
      title: `start ${h.label} again in ${s.cwd}`,
    };
  }
  async function sessionsSnapshot() {
    const r = await fetch('/api/sessions', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function showOverlay(title, text, offerResume) {
    $('ov-title').textContent = title;
    $('ov-text').textContent = text;
    $('ov-error').textContent = '';
    const btn = $('ov-resume');
    btn.hidden = true;
    $('overlay').hidden = false;
    $('follow-note').hidden = true;
    if (!offerResume) return;
    try {
      const snap = await sessionsSnapshot();
      const s = [...(snap.recent || []), ...(snap.running || [])].find((x) => x.id === sessionId);
      if (s) { meta = s; renderMeta(); }
      btn.hidden = false;
      const act = s ? resumeAction(s) : null;
      btn.textContent = act ? act.label : 'Resume';
      if (act && !act.none) {
        btn.disabled = false;
        btn.title = act.title;
      } else {
        btn.disabled = true;
        btn.title = (act && act.none) || 'No Claude session id was recorded for this session';
        if (!text) $('ov-text').textContent = `${btn.title}, so it cannot be ${act && act.label === 'Start again' ? 'started again' : 'resumed'}.`;
      }
    } catch (e) {
      $('ov-error').textContent = `could not look up the session: ${e.message}`;
    }
  }
  $('ov-resume').addEventListener('click', async () => {
    const btn = $('ov-resume');
    const act = meta ? resumeAction(meta) : null;
    if (!act || act.none) return;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(act.body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (embedded) {
        // The split page swaps the id in its URL and header; this pane loads the new session itself.
        try { window.parent.postMessage({ cwSplit: 'replace', from: sessionId, to: j.id }, location.origin); } catch { /* no parent */ }
        location.href = `/s/${j.id}?embed=1`;
        return;
      }
      location.href = `/s/${j.id}`;
    } catch (e) {
      $('ov-error').textContent = `${act.label.toLowerCase()} failed: ${e.message}`;
      btn.disabled = false;
      btn.textContent = act.label;
    }
  });

  // ---------- top bar ----------
  let needsInput = false;
  function setDot(kind) { $('t-dot').className = 'dot ' + kind; }
  function setState(text) { $('t-state').textContent = text; }
  function setNeedsInput(v) {
    needsInput = !!v;
    $('t-badge').hidden = !needsInput;
    renderTitle();
  }
  /** displayTitle() (user's name, else Claude's title), else the folder name. */
  const displayName = () => (meta ? displayTitle(meta) || basename(meta.cwd) : 'session');
  function renderTitle() {
    const idx = meta ? ` #${meta.index}` : '';
    document.title = `${needsInput ? '! ' : ''}${displayName()}${idx} · cw`;
  }
  const metaListeners = [];
  function renderMeta() {
    if (!meta) return;
    for (const fn of metaListeners) { try { fn(meta); } catch { /* a listener must not break the page */ } }
    window.cwAccent.paint(document.body, meta.cwd); // --sc: title bar stripe, Focus view tints
    $('t-name').textContent = displayName();
    $('t-name').title = `${meta.cwd} · tap to rename`;
    $('t-idx').textContent = `#${meta.index}`;
    const h = harnessOf(meta);
    if (tint) tint.set({ cwd: meta.cwd, harness: h ? h.id : 'claude' });
    const hb = $('t-harness');
    hb.hidden = !h || h.id === 'claude';
    if (!hb.hidden) { hb.textContent = h.label; hb.title = meta.model ? `${h.command} · model ${meta.model}` : h.command; }
    if (!exited) {
      const n = meta.clients;
      setState(meta.state === 'running' ? `${n} client${n === 1 ? '' : 's'}` : meta.state);
    }
    renderTitle();
  }

  // ---------- rename (tap the title) ----------
  // The form (input + ✓) sits in the same .topbar .title box at a height inside the bar's
  // min-height, so opening it never changes the terminal's size. Submitting the form saves (Enter,
  // the keyboard's Done/Go, or ✓), so an IME-composed Enter is never lost; Esc or leaving the form
  // cancels.
  const nameEl = $('t-name');
  const renameForm = $('t-rename-form');
  const renameEl = $('t-rename');
  const renameOk = $('t-rename-ok');
  let renameSaving = false;
  renameEl.maxLength = TITLE_MAX;
  function openRename() {
    if (!meta || !sessionId || !renameForm.hidden) return;
    renameEl.value = displayTitle(meta) || '';
    renameEl.placeholder = meta.title || basename(meta.cwd);
    renameEl.classList.remove('bad');
    renameEl.title = '';
    nameEl.hidden = true;
    renameForm.hidden = false;
    renameEl.focus();
    renameEl.select();
  }
  function closeRename() {
    renameForm.hidden = true;
    nameEl.hidden = false;
  }
  async function saveRename() {
    if (renameSaving || !meta) return;
    // Unchanged (including Claude's title saved as is): nothing to store, so a transcript title is
    // never pinned as the user's name. Same check as the list page.
    if (isSameTitle(meta, normalizeTitle(renameEl.value))) {
      closeRename();
      term.focus();
      return;
    }
    renameSaving = true;
    renameEl.readOnly = true;
    renameOk.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: renameEl.value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // The /ws/list broadcast brings the same; apply it now too (the list socket is closed once
      // the session has exited).
      if (meta) meta = { ...meta, userTitle: j.userTitle || null };
      closeRename();
      renderMeta();
      term.focus();
    } catch (e) {
      renameEl.classList.add('bad');
      renameEl.title = `rename failed: ${e.message}`;
      renameEl.focus(); // keep the editor usable if focus moved to ✓ (disabled while saving)
      if (!exited) setState('rename failed');
    } finally {
      renameSaving = false;
      renameEl.readOnly = false;
      renameOk.disabled = false;
    }
  }
  nameEl.addEventListener('click', openRename);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openRename();
  });
  renameForm.addEventListener('submit', (e) => { e.preventDefault(); saveRename(); });
  renameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeRename(); term.focus(); }
  });
  // mousedown keeps focus in the input, so tapping ✓ never blurs it first (phones do not focus a
  // tapped button, which would leave focusout's relatedTarget null and cancel). Same as the list page.
  renameOk.addEventListener('mousedown', (e) => e.preventDefault());
  renameForm.addEventListener('focusout', (e) => {
    if (renameSaving || (e.relatedTarget && renameForm.contains(e.relatedTarget))) return;
    closeRename();
  });

  // Session metadata (cwd, index, needsInput, size) comes from /ws/list.
  let listWs = null;
  let listBackoff = 500;
  let listTimer = null;
  function stopList() {
    clearTimeout(listTimer);
    listTimer = null;
    const sock = listWs;
    listWs = null; // before close(), so its onclose does not reconnect
    if (sock) { try { sock.close(); } catch { /* already closed */ } }
  }
  function connectList() {
    listTimer = null;
    if (exited) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/list`);
    listWs = sock;
    sock.onopen = () => { listBackoff = 500; };
    sock.onmessage = (ev) => {
      if (listWs !== sock || typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || msg.t !== 'sessions') return;
      const s = (msg.running || []).find((x) => x.id === sessionId) || (msg.recent || []).find((x) => x.id === sessionId);
      if (!s) return;
      meta = s;
      renderMeta();
      if (!exited && s.state === 'running') {
        setNeedsInput(s.needsInput);
        reconcileSize(s.cols, s.rows);
      }
    };
    sock.onclose = () => {
      if (listWs !== sock) return;
      listWs = null;
      if (exited) return;
      listTimer = setTimeout(connectList, listBackoff);
      listBackoff = Math.min(listBackoff * 2, 8000);
    };
  }
  // While following, the list is the only signal that ownership came back to us (the hub sends
  // {t:'resize'} to non-owners only), e.g. after the owning device disconnects.
  function reconcileSize(cols, rows) {
    if (wantOwner || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (lastSent && lastSent.cols === cols && lastSent.rows === rows) {
      setFollow(false);
      sendResize(fitLocal());
      return;
    }
    if (cols !== term.cols || rows !== term.rows) followOwner(cols, rows);
  }
  setInterval(() => {
    if (listWs && listWs.readyState === WebSocket.OPEN) listWs.send(JSON.stringify({ t: 'ping' }));
  }, PING_EVERY);

  // ---------- font ----------
  function setFont(n) {
    n = clamp(n, FONT_MIN, FONT_MAX);
    if (n === fontSize) return;
    fontSize = n;
    term.options.fontSize = n;
    store.set(FONT_KEY, n);
    scheduleLayout();
  }
  if (embedded) {
    // "Back" from the exit overlay leaves the split for the list; there is no title bar to go back from.
    for (const a of document.querySelectorAll('#overlay a[href="/"]')) a.target = '_top';
  }
  $('font-dec').addEventListener('click', () => setFont(fontSize - 1));
  $('font-inc').addEventListener('click', () => setFont(fontSize + 1));

  // ---------- visibility ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (started && !exited && !ws) { backoff = 500; connect(); }
    scheduleLayout();
  });

  // ---------- public API for keybar.js / compose.js / touch-scroll.js / snippets.js ----------
  window.cw = {
    term,
    sessionId,
    /** True inside a split-view pane (/s/<id>?embed=1 in a frame). */
    embedded,
    inputFilters,
    /** Font size one step smaller (dir < 0) or larger; the split pane header's A-/A+ call it. */
    fontStep(dir) { setFont(fontSize + (dir < 0 ? -1 : 1)); },
    /** Sends user input (a string) as if typed here; key-bar input bypasses the Ctrl filter. */
    send(data, opts) { userInput(data, opts); },
    focus() { term.focus(); },
    relayout: scheduleLayout,
    /**
     * Split view, while a pane divider is dragged: no refit and no size report until released
     * (then one), so a drag is one PTY resize however slowly the pointer moves.
     */
    holdLayout(on) {
      layoutHeld = !!on;
      if (layoutHeld) clearTimeout(layoutTimer);
      else scheduleLayout();
    },
    /** Registers fn(msg) for session control messages term.js does not handle itself (snippets.js). */
    onControl(fn) { controlListeners.push(fn); },
    /** This session's summary (/ws/list or /api/sessions), or null until it arrives. */
    get meta() { return meta; },
    /** Registers fn(meta) for every summary update (focus.js shows its toggle for Codex sessions). */
    onMeta(fn) { metaListeners.push(fn); if (meta) { try { fn(meta); } catch { /* ignore */ } } },
    /** One page back (dir < 0) or forward: local scrollback in the normal buffer, PgUp/PgDn to the app in the alternate one. */
    scrollPage(dir) {
      if (term.buffer.active.type !== 'normal') { userInput(dir < 0 ? '\x1b[5~' : '\x1b[6~', { filter: false }); return; }
      // The page glides (xterm animates scrollLines while smoothScrollDuration > 0). The option is
      // back to 0 before touch-scroll.js's next step, so finger scrolling stays immediate.
      term.options.smoothScrollDuration = PAGE_SMOOTH_MS;
      try { term.scrollPages(dir < 0 ? -1 : 1); } finally { term.options.smoothScrollDuration = 0; }
    },
    /** Debug/inspection snapshot (used by manual verification). */
    get state() {
      return {
        connected: !!ws && ws.readyState === WebSocket.OPEN, exited, following: !wantOwner,
        cols: term.cols, rows: term.rows, lastSent, proposed: proposed(), backoff,
      };
    },
    /** Debug: drop the socket as if the network failed (reconnect logic takes over). */
    dropSocket() { if (ws) ws.close(4000, 'debug drop'); },
  };

  // ---------- boot ----------
  if (!sessionId) {
    exited = true;
    showOverlay('bad session link', 'Session ids are 8 hex characters.', false);
  } else {
    setDot('warn');
    setState('connecting');
    connectList();
    // First attach waits until the page is visible and laid out, so it can claim its fitted size
    // (a tab opened in the background attaches when first viewed). Reconnects claim the size only
    // if this client owned it before.
    const firstConnect = () => {
      if (document.visibilityState !== 'visible') {
        document.addEventListener('visibilitychange', firstConnect, { once: true });
        return;
      }
      // A split pane leaves focus to the split page (it focuses one pane, not whichever loads last).
      setTimeout(() => { connect(); if (!embedded) term.focus(); }, 0);
    };
    firstConnect();
  }
})();
