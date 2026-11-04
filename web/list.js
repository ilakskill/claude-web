// cw session list page: health, running/recent sessions (live via /ws/list, polling fallback),
// titles from Claude transcripts (or the user's own, set with the inline Rename editor), kill /
// delete / clear with in-page confirm, resume, a "show all" toggle for recent sessions without a
// transcript, the new-session form with project picker, and (desk only) a select mode that opens
// up to four running sessions in the split view (/split, web/split.js).
// Needs /app/recent-filter.js (src/shared, also used by `cw ls`) loaded first.
(() => {
  'use strict';

  const {
    partitionRecent, formatDuration, endText, commandName, isClaude, displayTitle, isHidden, normalizeTitle, isSameTitle, TITLE_MAX,
  } = window.cwRecentFilter;
  const { getHarness, inferHarness, displayLabel } = window.cwHarnesses; // /app/harnesses.js
  const cwAccent = window.cwAccent; // /app/accent.js: per-folder accent color (--sc)
  const SHOW_ALL_KEY = 'cw.recent.showAll';
  const HARNESS_KEY = 'cw.harness';
  const modelKey = (id) => `cw.model.${id}`;
  const CUSTOM_HARNESS = '__custom__';
  const CUSTOM_MODEL = '__custom__';

  /** The preset a session/recent entry belongs to (recorded harness, else inferred from its command), or null. */
  const harnessOf = (s) => getHarness(s && s.harness) || inferHarness(s && s.command);

  /**
   * What the Resume/Continue button of a recent entry does: Claude (or an entry from before
   * harnesses) resumes by Claude session id, and so does any entry that recorded one (a shell that ran claude); another harness resumes by its own id when it records
   * one and can, else continues its latest session in the folder; shells and ollama do neither.
   * @returns {{label:string, body:object, title:string}|{label:string, none:string}}
   */
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
      return {
        label: 'Resume',
        body: { cwd: s.cwd, harness: h.id, resume: s.harnessSessionId },
        title: `${h.command} ${h.resumeArgs(s.harnessSessionId).join(' ')}`,
      };
    }
    if (h.continueArgs) {
      return {
        label: 'Continue',
        body: { cwd: s.cwd, harness: h.id, continue: true },
        title: `${h.command} ${h.continueArgs.join(' ')} in ${s.cwd}`,
      };
    }
    // Cannot continue or resume (ollama, shell): offer a fresh session in the same folder instead.
    if (h.modelRequired && !s.model) return { label: 'Start again', none: 'No model was recorded for this session' };
    return {
      label: 'Start again',
      body: s.model ? { cwd: s.cwd, harness: h.id, model: s.model } : { cwd: s.cwd, harness: h.id },
      title: `start ${h.label} again in ${s.cwd}`,
    };
  }

  const $ = (id) => document.getElementById(id);
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
  const joinPath = (root, name) => {
    const sep = root.includes('\\') || !root.includes('/') ? '\\' : '/';
    return root.replace(/[\\/]+$/, '') + sep + name;
  };
  function relTime(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 0) return 'just now';
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 14) return `${d} d ago`;
    return new Date(t).toLocaleDateString();
  }
  const absTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

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
      const msg = res.status === 401
        ? 'unauthorized: log in once with the URL printed by `cw url`'
        : (data && data.error) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- state ----------
  let running = [];
  let recent = [];
  let version = '';
  let hubUp = null;
  let signedInAs = ''; // the Tailscale login when the hub signed us in by identity (no token)
  let linkState = 'connecting'; // 'live' | 'polling' | 'connecting'
  const killArm = new Map(); // id -> timeout handle while "Confirm kill?" is shown
  const killing = new Set();
  const delArm = new Map(); // recent id -> timeout handle while "Delete?" is shown
  const deleting = new Set();
  let clearArm = null; // timeout handle while "Confirm clear?" is shown
  let clearing = false;
  const rowErrors = new Map(); // id -> message
  // Open rename editors, kept here so the re-render on every /ws/list broadcast and the 30 s timer
  // rebuild them with the typed text (keepFocus() puts the caret back).
  const renaming = new Map(); // session id -> { value, saving }
  let rendering = false; // rows are being rebuilt: ignore the focusout this causes
  let showAll = false;
  try { showAll = localStorage.getItem(SHOW_ALL_KEY) === '1'; } catch { /* storage unavailable */ }

  function notice(msg) {
    const n = $('notice');
    n.textContent = msg || '';
    n.hidden = !msg;
  }

  // ---------- rendering ----------
  function renderHealth() {
    const dot = $('health-dot');
    const txt = $('health-text');
    if (hubUp === false) {
      dot.className = 'dot bad';
      txt.textContent = 'hub unreachable';
      return;
    }
    dot.className = 'dot ' + (linkState === 'live' ? 'ok' : 'warn');
    const parts = [];
    if (version) parts.push('v' + version);
    parts.push(`${running.length} running`);
    parts.push(linkState === 'live' ? 'live' : linkState === 'polling' ? 'polling' : 'connecting…');
    if (signedInAs) parts.push(`signed in as ${signedInAs}`);
    txt.textContent = parts.join(' · ');
  }

  function renderChips() {
    const box = $('chips');
    box.replaceChildren(...running.map((s) => cwAccent.paint(el('a', {
      class: 'chip' + (s.needsInput ? ' attn' : ''),
      href: `/s/${s.id}`,
      title: s.cwd,
      text: `${s.needsInput ? '! ' : ''}#${s.index} ${basename(s.cwd)}`,
    }), s.cwd)));
  }

  function killButton(s) {
    const armed = killArm.has(s.id);
    const busy = killing.has(s.id);
    return el('button', {
      class: 'btn danger' + (armed ? ' confirm' : ''),
      type: 'button',
      disabled: busy,
      text: busy ? 'Killing…' : armed ? 'Confirm kill?' : 'Kill',
      on: { click: () => onKill(s) },
    });
  }

  /**
   * Title line: the user's name (accent colour) or the transcript title, bold; else the folder name
   * with a muted "no title yet". While a rename editor is open for the row, the editor instead.
   */
  function nameLine(s, { live }) {
    if (renaming.has(s.id)) return renameForm(s, { live });
    const h = harnessOf(s);
    const badge = h && h.id !== 'claude' ? displayLabel({ harness: h.id }) : null;
    const cmd = !badge && s.command && !isClaude(s.command) ? commandName(s.command) : null;
    const name = displayTitle(s);
    const own = !!s.userTitle;
    return el('div', { class: 'name' },
      name
        ? el('span', {
          class: 'title' + (own ? ' custom' : ''),
          title: own ? (s.title ? `Claude's title: ${s.title}` : 'Your name for this session') : s.firstPrompt || s.title,
          text: name,
        })
        : el('span', { class: 'untitled' },
          el('span', { text: basename(s.cwd) }),
          el('span', { class: 'muted', text: live ? ' · no title yet' : ' · no title' })),
      badge ? el('span', {
        class: 'badge harness',
        title: [commandName(s.command), ...(s.args || [])].join(' ') + (s.model ? ` (model ${s.model})` : ''),
        text: badge,
      }) : null,
      cmd ? el('span', { class: 'cmd mono', title: [cmd, ...(s.args || [])].join(' '), text: cmd }) : null,
      live && s.needsInput ? el('span', { class: 'badge', text: 'needs input' }) : null);
  }

  /** Inline rename editor: Enter/Save saves, Esc/Cancel cancels, so does focus leaving the form. */
  function renameForm(s, { live }) {
    const st = renaming.get(s.id);
    const input = el('input', {
      class: 'rename-input',
      type: 'text',
      name: 'title',
      value: st.value,
      maxlength: TITLE_MAX,
      placeholder: s.title || basename(s.cwd),
      'data-rename-id': s.id,
      'aria-label': 'Session name (empty clears it)',
      enterkeyhint: 'done',
      autocomplete: 'off',
      spellcheck: 'false',
      readonly: st.saving,
      on: {
        input: (e) => { st.value = e.currentTarget.value; },
        keydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); cancelRename(s.id, e.currentTarget.form); } },
      },
    });
    // mousedown keeps focus in the input, so tapping Save or Cancel never blurs it first (phones do
    // not focus a tapped button, which would leave focusout's relatedTarget null and cancel).
    const keep = { mousedown: (e) => e.preventDefault() };
    return el('form', {
      class: 'rename',
      'data-live': live ? '1' : '0',
      on: {
        submit: (e) => { e.preventDefault(); onRenameSave(s.id, live); },
        focusout: (e) => {
          if (rendering || renaming.get(s.id) !== st || st.saving) return;
          if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
          cancelRename(s.id, e.currentTarget);
        },
      },
    },
    input,
    el('button', { class: 'btn primary', type: 'submit', disabled: st.saving, text: st.saving ? 'Saving…' : 'Save', on: keep }),
    el('button', {
      class: 'btn', type: 'button', disabled: st.saving, text: 'Cancel',
      on: { ...keep, click: (e) => cancelRename(s.id, e.currentTarget.form) },
    }));
  }

  function renameButton(s) {
    return el('button', {
      class: 'btn',
      type: 'button',
      title: 'Name this session',
      text: 'Rename',
      on: { click: () => startRename(s.id) },
    });
  }

  const renameInput = (id) => [...document.querySelectorAll('input[data-rename-id]')].find((n) => n.dataset.renameId === id) || null;

  /**
   * Runs a render that replaces rows. If a rename input had focus, focuses its rebuilt twin and
   * restores the selection afterwards. Nested calls just run (the outermost one restores).
   */
  function keepFocus(fn) {
    if (rendering) { fn(); return; }
    const a = document.activeElement;
    const id = a && a.dataset ? a.dataset.renameId : undefined;
    let sel = null;
    if (id) { try { sel = [a.selectionStart, a.selectionEnd, a.selectionDirection]; } catch { /* no selection API */ } }
    rendering = true;
    try { fn(); } finally { rendering = false; }
    if (!id) return;
    const n = renameInput(id);
    if (!n || n === document.activeElement) return;
    n.focus({ preventScroll: true });
    if (sel && sel[0] !== null) { try { n.setSelectionRange(sel[0], sel[1], sel[2] || 'none'); } catch { /* ignore */ } }
  }

  const dot = () => el('span', { class: 'sep', 'aria-hidden': 'true', text: '·' });
  const metaSpan = (text, title) => el('span', { title, text });
  /** Joins non-empty meta items with dots. */
  const metaLine = (...items) => {
    const kept = items.filter(Boolean);
    return el('div', { class: 'meta' }, ...kept.flatMap((x, i) => (i ? [dot(), x] : [x])));
  };

  function renderRunning() {
    const box = $('running');
    $('running-count').textContent = running.length ? `(${running.length})` : '';
    if (!running.length) {
      keepFocus(() => box.replaceChildren(el('div', { class: 'empty', text: 'No running sessions.' })));
      return;
    }
    keepFocus(() => box.replaceChildren(...running.map((s) => {
      const err = rowErrors.get(s.id);
      const dur = formatDuration(s.durationMs);
      return cwAccent.paint(el('div', { class: 'row' + (s.needsInput ? ' attn' : ''), 'data-id': s.id },
        selecting ? pickBox(s) : el('div', { class: 'idx', text: `#${s.index}` }),
        el('div', { class: 'main' },
          nameLine(s, { live: true }),
          el('div', { class: 'path', title: s.cwd, text: s.cwd }),
          metaLine(
            metaSpan(`started ${relTime(s.startedAt)}`, absTime(s.startedAt)),
            dur ? metaSpan(`running ${dur}`) : null,
            s.lastActivity ? metaSpan(`active ${relTime(s.lastActivity)}`, absTime(s.lastActivity)) : null,
            metaSpan(`${s.clients} client${s.clients === 1 ? '' : 's'}`))),
        el('div', { class: 'actions' },
          el('a', { class: 'btn primary', href: `/s/${s.id}`, text: 'Open' }),
          renameButton(s),
          killButton(s)),
        err ? el('div', { class: 'row-error error', text: err }) : null), s.cwd);
    })));
  }

  // ---------- split view: select mode ----------
  // "Split view" turns the running rows' index into checkboxes; "Open split (n)" goes to
  // /split?s=<ids in pick order>. Up to SPLIT_MAX; more can be added from the split page itself.
  const SPLIT_MAX = 4;
  let selecting = false;
  let picked = []; // session ids, in pick order

  function pickBox(s) {
    const on = picked.includes(s.id);
    return el('label', { class: 'idx pick', title: on ? 'In the split' : 'Add to the split' },
      el('input', {
        type: 'checkbox', checked: on, disabled: !on && picked.length >= SPLIT_MAX,
        'data-pick-id': s.id, 'aria-label': `Add #${s.index} to the split`,
        on: { change: (e) => onPick(s.id, e.currentTarget.checked) },
      }),
      el('span', { text: `#${s.index}` }));
  }
  /** Updates the boxes in place (no re-render, so keyboard focus stays on the box). */
  function onPick(id, on) {
    picked = on ? [...picked.filter((x) => x !== id), id].slice(0, SPLIT_MAX) : picked.filter((x) => x !== id);
    for (const box of document.querySelectorAll('input[data-pick-id]')) {
      box.checked = picked.includes(box.dataset.pickId);
      box.disabled = !box.checked && picked.length >= SPLIT_MAX;
    }
    renderSplitTools();
  }
  function renderSplitTools() {
    const btn = $('split-btn');
    $('split-cancel').hidden = !selecting;
    const hint = $('split-hint');
    hint.hidden = !selecting;
    hint.textContent = picked.length >= SPLIT_MAX ? `${SPLIT_MAX} max` : `pick up to ${SPLIT_MAX}`;
    if (!selecting) {
      btn.textContent = 'Split view';
      btn.disabled = running.length === 0;
      btn.classList.remove('primary');
      return;
    }
    btn.textContent = picked.length ? `Open split (${picked.length})` : 'Open split';
    btn.disabled = picked.length === 0;
    btn.classList.add('primary');
  }
  function setSelecting(on) {
    selecting = on;
    if (!on) picked = [];
    renderSplitTools();
    renderRunning();
  }
  $('split-btn').addEventListener('click', () => {
    if (!selecting) { setSelecting(true); return; }
    if (picked.length) location.href = `/split?s=${picked.join(',')}`;
  });
  $('split-cancel').addEventListener('click', () => setSelecting(false));

  function deleteButton(s) {
    const armed = delArm.has(s.id);
    const busy = deleting.has(s.id);
    return el('button', {
      class: 'btn danger del' + (armed ? ' confirm' : ''),
      type: 'button',
      disabled: busy,
      title: armed ? 'Click again to remove this entry' : 'Remove from recent',
      'aria-label': armed ? 'Confirm remove from recent' : 'Remove from recent',
      text: busy ? '…' : armed ? 'Delete?' : '×',
      on: { click: () => onDelete(s) },
    });
  }

  function renderRecentTools(hidden) {
    const hiddenEl = $('recent-hidden');
    hiddenEl.textContent = hidden ? (showAll ? `incl. ${hidden} without transcript` : `${hidden} hidden`) : '';
    const toggle = $('show-all-btn');
    toggle.hidden = hidden === 0 && !showAll;
    toggle.textContent = showAll ? 'Hide no-transcript' : 'Show all';
    toggle.setAttribute('aria-pressed', showAll ? 'true' : 'false');
    toggle.classList.toggle('on', showAll);
    const clear = $('clear-recent-btn');
    clear.hidden = recent.length === 0;
    clear.disabled = clearing;
    clear.classList.toggle('confirm', !!clearArm);
    clear.textContent = clearing ? 'Clearing…' : clearArm ? `Confirm clear ${recent.length}?` : 'Clear recent';
  }

  function renderRecent() {
    const box = $('recent');
    const { shown, hidden } = partitionRecent(recent, showAll);
    $('recent-count').textContent = recent.length ? `(${shown.length})` : '';
    renderRecentTools(hidden);
    if (!shown.length) {
      keepFocus(() => box.replaceChildren(el('div', {
        class: 'empty',
        text: hidden ? `No recent sessions with a transcript (${hidden} hidden).` : 'Nothing here yet.',
      })));
      return;
    }
    keepFocus(() => box.replaceChildren(...shown.map((s) => {
      const act = resumeAction(s);
      const err = rowErrors.get('r:' + s.id);
      const dur = formatDuration(s.durationMs);
      return cwAccent.paint(el('div', { class: 'row' + (isHidden(s) ? ' dim' : ''), 'data-id': s.id },
        el('div', { class: 'idx', text: `#${s.index}` }),
        el('div', { class: 'main' },
          nameLine(s, { live: false }),
          el('div', { class: 'path', title: s.cwd, text: s.cwd }),
          metaLine(
            metaSpan(`${endText(s)} ${relTime(s.endedAt)}`, s.error ? `${absTime(s.endedAt)}: ${s.error}` : absTime(s.endedAt)),
            dur ? metaSpan(`ran ${dur}`) : null,
            s.lastActivity ? metaSpan(`last active ${relTime(s.lastActivity)}`, absTime(s.lastActivity)) : null)),
        el('div', { class: 'actions' },
          el('button', {
            class: 'btn',
            type: 'button',
            disabled: !!act.none,
            title: act.none || act.title,
            text: act.label,
            on: { click: (e) => onResume(s, e.currentTarget) },
          }),
          renameButton(s),
          deleteButton(s)),
        err ? el('div', { class: 'row-error error', text: err }) : null), s.cwd);
    })));
  }

  function render() {
    renderHealth();
    renderChips();
    renderRows();
    const attn = running.some((s) => s.needsInput);
    document.title = (attn ? '! ' : '') + 'cw' + (running.length ? ` (${running.length})` : '');
  }

  /** Both lists in one keepFocus(), so an editor whose session just ended keeps focus in its new row. */
  function renderRows() { keepFocus(() => { renderRunning(); renderRecent(); }); }

  function applySessions(msg) {
    running = Array.isArray(msg.running) ? msg.running : [];
    recent = Array.isArray(msg.recent) ? msg.recent : [];
    hubUp = true;
    // Forget kill state for sessions that are gone.
    for (const id of [...killArm.keys()]) if (!running.some((s) => s.id === id)) { clearTimeout(killArm.get(id)); killArm.delete(id); }
    for (const id of [...killing]) if (!running.some((s) => s.id === id)) killing.delete(id);
    for (const id of [...delArm.keys()]) if (!recent.some((s) => s.id === id)) { clearTimeout(delArm.get(id)); delArm.delete(id); }
    for (const id of [...deleting]) if (!recent.some((s) => s.id === id)) deleting.delete(id);
    for (const id of [...renaming.keys()]) if (!findEntry(id)) renaming.delete(id);
    picked = picked.filter((id) => running.some((s) => s.id === id));
    render();
    renderSplitTools();
  }

  // ---------- actions ----------
  /** The running session with this id, else the recent entry. */
  const findEntry = (id) => running.find((x) => x.id === id) || recent.find((x) => x.id === id) || null;
  const errKey = (id, live) => (live ? id : 'r:' + id);

  function startRename(id) {
    const s = findEntry(id);
    if (!s) return;
    if (!renaming.has(id)) {
      renaming.set(id, { value: displayTitle(s) || '', saving: false });
      rowErrors.delete(id);
      rowErrors.delete('r:' + id);
      renderRows();
    }
    const n = renameInput(id);
    if (n) { n.focus(); n.select(); }
  }

  /**
   * Closes the editor by swapping just its form back to the title line: no full re-render, so a
   * button tapped elsewhere (which caused the focusout) is not replaced before its click lands.
   */
  function cancelRename(id, formEl) {
    if (!renaming.delete(id)) return;
    const s = findEntry(id);
    if (!s || !formEl || !formEl.isConnected) { renderRows(); return; }
    rendering = true;
    try { formEl.replaceWith(nameLine(s, { live: formEl.dataset.live === '1' })); } finally { rendering = false; }
  }

  async function onRenameSave(id, live) {
    const st = renaming.get(id);
    const s = findEntry(id);
    if (!st || st.saving || !s) return;
    // Unchanged (including Claude's title saved as is): nothing to store.
    if (isSameTitle(s, normalizeTitle(st.value))) {
      renaming.delete(id);
      renderRows();
      return;
    }
    st.saving = true;
    rowErrors.delete(errKey(id, live));
    renderRows();
    try {
      const j = await api('PATCH', `/api/sessions/${id}`, { title: st.value });
      // Apply the new name now so the old one does not flash until the /ws/list broadcast lands.
      const userTitle = (j && j.userTitle) || null;
      running = running.map((x) => (x.id === id ? { ...x, userTitle } : x));
      recent = recent.map((x) => (x.id === id ? { ...x, userTitle } : x));
      renaming.delete(id);
    } catch (e) {
      st.saving = false;
      rowErrors.set(errKey(id, live), `rename failed: ${e.message}`);
    }
    renderRows();
    refresh();
  }

  async function onKill(s) {
    if (killing.has(s.id)) return;
    if (!killArm.has(s.id)) {
      killArm.set(s.id, setTimeout(() => { killArm.delete(s.id); renderRunning(); }, 4000));
      rowErrors.delete(s.id);
      renderRunning();
      return;
    }
    clearTimeout(killArm.get(s.id));
    killArm.delete(s.id);
    killing.add(s.id);
    renderRunning();
    try {
      await api('DELETE', `/api/sessions/${s.id}`);
    } catch (e) {
      rowErrors.set(s.id, `kill failed: ${e.message}`);
    }
    killing.delete(s.id);
    refresh();
  }

  async function onDelete(s) {
    if (deleting.has(s.id)) return;
    if (!delArm.has(s.id)) {
      delArm.set(s.id, setTimeout(() => { delArm.delete(s.id); renderRecent(); }, 4000));
      rowErrors.delete('r:' + s.id);
      renderRecent();
      return;
    }
    clearTimeout(delArm.get(s.id));
    delArm.delete(s.id);
    deleting.add(s.id);
    renderRecent();
    try {
      await api('DELETE', `/api/recent/${s.id}`);
    } catch (e) {
      rowErrors.set('r:' + s.id, `delete failed: ${e.message}`);
    }
    deleting.delete(s.id);
    refresh();
  }

  $('clear-recent-btn').addEventListener('click', async () => {
    if (clearing) return;
    if (!clearArm) {
      clearArm = setTimeout(() => { clearArm = null; renderRecent(); }, 4000);
      renderRecent();
      return;
    }
    clearTimeout(clearArm);
    clearArm = null;
    clearing = true;
    renderRecent();
    try {
      await api('DELETE', '/api/recent');
      notice('');
    } catch (e) {
      notice(`clear failed: ${e.message}`);
    }
    clearing = false;
    refresh();
  });

  $('show-all-btn').addEventListener('click', () => {
    showAll = !showAll;
    try { localStorage.setItem(SHOW_ALL_KEY, showAll ? '1' : '0'); } catch { /* storage unavailable */ }
    renderRecent();
  });

  async function onResume(s, btn) {
    const act = resumeAction(s);
    if (act.none) return;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const r = await api('POST', '/api/sessions', act.body);
      location.href = `/s/${r.id}`;
    } catch (e) {
      rowErrors.set('r:' + s.id, `${act.label.toLowerCase()} failed: ${e.message}`);
      renderRecent();
    }
  }

  // ---------- live updates ----------
  let ws = null;
  let backoff = 500;
  let reconnectTimer = null;
  let pollTimer = null;

  async function refresh() {
    try {
      applySessions(await api('GET', '/api/sessions'));
      notice('');
    } catch (e) {
      if (e.status === 401) notice(e.message);
      else { hubUp = false; renderHealth(); }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    linkState = 'polling';
    renderHealth();
    refresh();
    pollTimer = setInterval(refresh, 5000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function connectList() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let sock;
    try {
      sock = new WebSocket(`${proto}//${location.host}/ws/list`);
    } catch {
      startPolling();
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      linkState = 'live';
      stopPolling();
      loadHealth();
      renderHealth();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock || typeof ev.data !== 'string') return; // a replaced socket's late message
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.t === 'sessions') { applySessions(msg); notice(''); }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      startPolling();
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectList, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }

  // Keep the socket alive through proxies; the hub answers {t:'ping'} with {t:'pong'}.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
  }, 25000);
  // Relative times drift; re-render them.
  setInterval(renderRows, 30000);

  async function loadHealth() {
    try {
      const h = await api('GET', '/api/health');
      version = h.version || '';
      hubUp = true;
    } catch {
      hubUp = false;
    }
    renderHealth();
    if (!hubUp) return;
    // Only shown for a Tailscale identity login; a token login shows nothing extra.
    try {
      const me = await api('GET', '/api/me');
      signedInAs = me && me.via === 'tailscale' && me.login ? me.login : '';
    } catch {
      signedInAs = '';
    }
    renderHealth();
  }

  // ---------- new session form ----------
  const form = {
    recent: $('recent-select'),
    root: $('root-select'),
    path: $('path-input'),
    harness: $('harness-select'),
    modelField: $('f-model'),
    model: $('model-select'),
    modelCustom: $('model-custom'),
    command: $('command-input'),
    args: $('args-input'),
    resolved: $('resolved'),
    error: $('form-error'),
    submit: $('start-btn'),
  };
  let lastSource = null; // 'recent' | 'root' | 'path'

  function sourceValue(src) {
    if (src === 'recent') return form.recent.value;
    if (src === 'root') return form.root.value;
    if (src === 'path') return form.path.value.trim();
    return '';
  }
  function resolvedCwd() {
    return lastSource ? sourceValue(lastSource) : '';
  }
  function renderResolved() {
    const cwd = resolvedCwd();
    form.resolved.textContent = cwd || 'pick a project, a folder, or type a path';
    form.resolved.classList.toggle('none', !cwd);
    for (const [src, id] of [['recent', 'f-recent'], ['root', 'f-root'], ['path', 'f-path']]) {
      $(id).classList.toggle('active', lastSource === src && !!cwd);
    }
  }
  form.recent.addEventListener('change', () => { lastSource = 'recent'; renderResolved(); });
  form.root.addEventListener('change', () => { lastSource = 'root'; renderResolved(); });
  form.path.addEventListener('input', () => { lastSource = 'path'; renderResolved(); });

  async function loadProjects() {
    try {
      const p = await api('GET', '/api/projects');
      const rec = Array.isArray(p.recent) ? p.recent : [];
      form.recent.replaceChildren(
        el('option', { value: '', text: rec.length ? `— ${rec.length} recent project${rec.length === 1 ? '' : 's'} —` : '— none —' }),
        ...rec.map((r) => el('option', { value: r.cwd, title: r.cwd, text: basename(r.cwd) })));
      const roots = Array.isArray(p.roots) ? p.roots : [];
      const groups = roots.map((r) => el('optgroup', { label: r.root },
        el('option', { value: r.root, title: r.root, text: `${basename(r.root)} (root)` }),
        ...(r.dirs || []).map((d) => {
          const full = joinPath(r.root, d);
          return el('option', { value: full, title: full, text: d });
        })));
      form.root.replaceChildren(el('option', { value: '', text: roots.length ? '— folder —' : '— no roots —' }), ...groups);
    } catch (e) {
      form.recent.replaceChildren(el('option', { value: '', text: 'unavailable' }));
      form.root.replaceChildren(el('option', { value: '', text: 'unavailable' }));
      form.error.textContent = `could not load projects: ${e.message}`;
    }
    renderResolved();
  }

  // ---------- harness and model pickers ----------
  let harnessInfo = new Map(); // id -> /api/harnesses entry
  let modelSeq = 0; // guards against a slow model list answering after the harness changed
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  /** The chosen preset (cwHarnesses entry), or null for "Custom command" / before the list loads. */
  function presetHarness() {
    const id = form.harness.value;
    return id && id !== CUSTOM_HARNESS ? getHarness(id) : null;
  }
  /** The model to send: '' for the harness default. */
  function selectedModel() {
    if (form.model.value === CUSTOM_MODEL) return form.modelCustom.value.trim();
    return form.model.value;
  }
  /** False while the chosen harness requires a model and none is picked. */
  function modelOk() {
    const h = presetHarness();
    return !h || !h.modelRequired || !!selectedModel();
  }
  function syncSubmit() {
    const busy = form.submit.textContent === 'Starting…';
    form.submit.disabled = busy || !modelOk();
    form.submit.title = modelOk() ? '' : 'Pick a model first';
  }

  function renderModels(h, list, saved) {
    const opts = [];
    if (!h.modelRequired) opts.push(el('option', { value: '', text: 'harness default' }));
    else opts.push(el('option', { value: '', text: '— pick a model —' }));
    for (const m of list) opts.push(el('option', { value: m.id, text: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id }));
    opts.push(el('option', { value: CUSTOM_MODEL, text: 'custom…' }));
    form.model.replaceChildren(...opts);
    if (saved && list.some((m) => m.id === saved)) {
      form.model.value = saved;
    } else if (saved) {
      form.model.value = CUSTOM_MODEL;
      form.modelCustom.value = saved;
    } else {
      form.model.value = '';
    }
    form.modelCustom.hidden = form.model.value !== CUSTOM_MODEL;
    syncSubmit();
  }

  async function loadModels(h, refresh) {
    const seq = ++modelSeq;
    const saved = store.get(modelKey(h.id));
    renderModels(h, [], saved);
    form.model.title = 'loading models…';
    try {
      const j = await api('GET', `/api/harnesses/${encodeURIComponent(h.id)}/models${refresh ? '?refresh=1' : ''}`);
      if (seq !== modelSeq) return;
      renderModels(h, Array.isArray(j.models) ? j.models : [], saved);
      form.model.title = j.error ? `model list: ${j.error}` : (j.source ? `from ${j.source}` : '');
    } catch (e) {
      if (seq !== modelSeq) return;
      form.model.title = `could not load models: ${e.message}`;
    }
  }

  /** Harness changed: fill Command/Arguments from the preset and load its models. */
  function onHarnessChange() {
    const h = presetHarness();
    form.modelField.hidden = !h || !h.modelFlag;
    if (!h) {
      // Custom command: keep whatever is typed, editable as before.
      modelSeq++;
      form.model.replaceChildren(el('option', { value: '', text: 'harness default' }));
      form.modelCustom.hidden = true;
      syncSubmit();
      return;
    }
    store.set(HARNESS_KEY, h.id);
    form.command.value = h.command;
    form.args.value = h.args.join(' ');
    if (h.modelFlag) loadModels(h, false);
    else { modelSeq++; form.model.replaceChildren(el('option', { value: '', text: 'harness default' })); syncSubmit(); }
  }
  form.harness.addEventListener('change', onHarnessChange);
  form.model.addEventListener('change', () => {
    form.modelCustom.hidden = form.model.value !== CUSTOM_MODEL;
    if (!form.modelCustom.hidden) form.modelCustom.focus();
    const h = presetHarness();
    if (h) store.set(modelKey(h.id), selectedModel());
    syncSubmit();
  });
  form.modelCustom.addEventListener('input', () => {
    const h = presetHarness();
    if (h) store.set(modelKey(h.id), selectedModel());
    syncSubmit();
  });

  async function loadHarnesses() {
    try {
      const j = await api('GET', '/api/harnesses');
      const list = Array.isArray(j.harnesses) ? j.harnesses : [];
      harnessInfo = new Map(list.map((x) => [x.id, x]));
      form.harness.replaceChildren(
        ...list.map((x) => el('option', {
          value: x.id,
          disabled: x.available === false,
          text: x.available === false ? `${x.label} (${x.unavailableReason ? x.unavailableReason.split(' ')[0] + ' not set' : 'not installed'})` : x.label,
          title: x.unavailableReason || '',
        })),
        el('option', { value: CUSTOM_HARNESS, text: 'Custom command' }));
      const usable = (id) => id === CUSTOM_HARNESS || (harnessInfo.has(id) && harnessInfo.get(id).available !== false);
      const saved = store.get(HARNESS_KEY);
      form.harness.value = [saved, j.default, 'claude'].find((id) => id && usable(id)) || CUSTOM_HARNESS;
    } catch (e) {
      // Older hub or unreachable: fall back to the plain command form.
      form.harness.replaceChildren(el('option', { value: CUSTOM_HARNESS, text: 'Custom command' }));
      form.harness.value = CUSTOM_HARNESS;
    }
    onHarnessChange();
  }

  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    form.error.textContent = '';
    const cwd = resolvedCwd();
    if (!cwd) { form.error.textContent = 'choose a working directory first'; return; }
    const body = { cwd };
    const command = form.command.value.trim();
    let args = form.args.value.trim().split(/\s+/).filter(Boolean);
    const h = presetHarness();
    if (h) {
      body.harness = h.id;
      const model = selectedModel();
      if (model) body.model = model;
      // The hub puts the preset's own arguments first: send only what follows them, and the
      // command only when it was edited away from the preset (the hub resolves the preset itself).
      if (command && command !== h.command) body.command = command;
      if (h.args.length && h.args.every((a, i) => args[i] === a)) args = args.slice(h.args.length);
    } else if (command && command !== 'claude') {
      // "claude" (the default) is left to the hub so it resolves claude.exe the same way `cw` does.
      body.command = command;
    }
    if (args.length) body.args = args;
    if (h && !modelOk()) { form.error.textContent = `${h.label} needs a model`; return; }
    form.submit.disabled = true;
    form.submit.textContent = 'Starting…';
    try {
      const r = await api('POST', '/api/sessions', body);
      location.href = `/s/${r.id}`;
    } catch (err) {
      form.error.textContent = err.message;
      form.submit.textContent = 'Start session';
      syncSubmit();
    }
  });

  // ---------- boot ----------
  loadHealth();
  loadProjects();
  loadHarnesses();
  refresh();
  if ('WebSocket' in window) connectList(); else startPolling();
})();
