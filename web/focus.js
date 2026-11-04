// cw Focus view for Codex sessions: the conversation instead of the TUI. Codex's terminal fills with
// "Ran <command>" cells and output previews; Focus shows the user's prompts and Codex's answers, and
// collapses each run of tool calls and progress notes into one line ("Ran 3 commands, edited 1 file
// · 1 failed") that opens on tap. The feed comes from GET /api/sessions/<id>/focus (the hub reads
// Codex's rollout file, src/hub/codex-focus.js), polled while the view is open and the page visible.
//
// The panel floats over the terminal (the terminal keeps its size and keeps running underneath), so
// the compose bar, key bar, file drop and dictation work as before; the compose bar opens with
// Focus (without changing its remembered setting). When Codex waits for an approval the bar at the
// bottom says so, with one tap back to the terminal. The choice is kept per session
// (localStorage cw.focus.<id>). Only Codex sessions get the toggle.
//
// window.cwFocus holds the pure logic (grouping, summary, markdown subset), unit-tested from Node.
(function (root) {
  'use strict';

  // ---------- pure helpers ----------

  const storageKey = (id) => `cw.focus.${id}`;
  const isNote = (e) => e.kind === 'agent' && e.phase === 'commentary';

  /**
   * Blocks to render, in order: {type:'user'|'agent', key, text, phase?}, {type:'note'|'error', key,
   * text}, and {type:'activity', key, items} for each run of tool calls and progress notes. Keys
   * come from the first event, so a growing activity keeps its key.
   */
  function groupEvents(events) {
    const out = [];
    let act = null;
    for (const e of events || []) {
      if (!e || typeof e !== 'object') continue;
      if (e.kind === 'tool' || isNote(e)) {
        if (!act) { act = { type: 'activity', key: `a${e.seq}`, items: [] }; out.push(act); }
        act.items.push(e);
        continue;
      }
      if (e.kind === 'turn') {
        if (e.state !== 'aborted') continue; // turn starts and ends do not split an activity
        act = null;
        out.push({ type: 'note', key: `n${e.seq}`, text: e.reason === 'interrupted' || !e.reason ? 'Turn interrupted' : `Turn ended (${e.reason})` });
        continue;
      }
      act = null;
      if (e.kind === 'user') out.push({ type: 'user', key: `u${e.seq}`, text: e.text });
      else if (e.kind === 'agent') out.push({ type: 'agent', key: `m${e.seq}`, text: e.text, phase: e.phase ?? null });
      else if (e.kind === 'note') out.push({ type: 'note', key: `n${e.seq}`, text: e.text });
      else if (e.kind === 'error') out.push({ type: 'error', key: `e${e.seq}`, text: e.text });
    }
    return out;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const PHRASES = {
    command: (n) => `ran ${plural(n, 'command', 'commands')}`,
    edit: (n) => `edited ${plural(n, 'file', 'files')}`,
    mcp: (n) => `called ${plural(n, 'tool', 'tools')}`,
    web: (n) => `searched the web ${n === 1 ? 'once' : `${n} times`}`,
    agent: (n) => `ran ${plural(n, 'subagent', 'subagents')}`,
    other: (n) => `used ${plural(n, 'extension', 'extensions')}`,
  };

  /** The one-line summary of an activity: {text, failed, last} (last: the newest progress note). */
  function summarize(items) {
    const order = [];
    const count = new Map();
    const files = new Set();
    const agents = new Set();
    let failed = 0;
    let notes = 0;
    let last = null;
    for (const e of items || []) {
      if (isNote(e)) { notes++; last = e.text; continue; }
      if (e.kind !== 'tool') continue;
      const k = Object.hasOwn(PHRASES, e.tool) ? e.tool : 'other';
      if (!count.has(k)) { order.push(k); count.set(k, 0); }
      if (k === 'edit' && Array.isArray(e.files) && e.files.length) for (const f of e.files) files.add(f);
      else if (k === 'agent' && e.agent) agents.add(e.agent);
      else count.set(k, count.get(k) + 1);
      if (e.ok === false) failed++;
    }
    if (files.size) count.set('edit', count.get('edit') + files.size);
    if (agents.size) count.set('agent', count.get('agent') + agents.size);
    let text = order.map((k) => PHRASES[k](count.get(k))).join(', ');
    if (!text) text = plural(notes, 'progress note', 'progress notes');
    return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, last };
  }

  const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  function parseInline(s) {
    const out = [];
    const text = (v) => {
      if (!v) return;
      const prev = out[out.length - 1];
      if (prev && prev.t === 'text') prev.v += v; else out.push({ t: 'text', v });
    };
    let at = 0;
    for (const m of s.matchAll(INLINE_RE)) {
      text(s.slice(at, m.index));
      at = m.index + m[0].length;
      if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
      else if (m[2] !== undefined) out.push({ t: 'b', v: m[2] });
      else if (/^https?:\/\//i.test(m[4])) out.push({ t: 'a', v: m[3], href: m[4] });
      else text(m[0]); // never a javascript:, data: or relative link
    }
    text(s.slice(at));
    return out;
  }

  /**
   * The markdown subset agent answers are shown with, as data (rendered with textContent only, so
   * nothing in a message can become HTML): {type:'p'|'h', inline}, {type:'list', ordered, items},
   * {type:'code'|'pre', text} (pre: a table, kept monospace).
   */
  function parseMarkdown(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) out.push({ type: 'p', inline: parseInline(para.join('\n')) }); para = []; };
    const flushList = () => { if (list) out.push(list); list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara(); flushList();
        const body = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
        out.push({ type: 'code', text: body.join('\n') });
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); out.push({ type: 'h', inline: parseInline(h[2]) }); continue; }
      if (/^\s*\|/.test(line)) {
        flushPara(); flushList();
        const rows = [line];
        while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
        out.push({ type: 'pre', text: rows.join('\n') });
        continue;
      }
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[1]);
        if (list && list.ordered !== ordered) flushList();
        if (!list) list = { type: 'list', ordered, items: [] };
        list.items.push(parseInline(li[2]));
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out;
  }

  /** The bottom bar for a hub `waiting` value: {tone:'attn'|'calm', text, terminal} or null. */
  function waitingView(w) {
    if (!w || typeof w !== 'object') return null;
    if (w.kind === 'approval') return { tone: 'attn', text: `Codex needs your approval: ${w.text || 'see the terminal'}`, terminal: true };
    if (w.kind === 'needs-input') return { tone: 'attn', text: 'Codex is waiting for your input', terminal: true };
    if (w.kind === 'your-turn') return { tone: 'calm', text: w.question ? 'Codex asked you something · reply below' : 'Codex finished · reply below', terminal: false };
    return null;
  }

  root.cwFocus = { storageKey, groupEvents, summarize, parseMarkdown, parseInline, waitingView };

  // ---------- the view (session page only) ----------

  const cw = root.cw;
  if (!cw || typeof document === 'undefined' || !cw.sessionId) return;
  const $ = (id) => document.getElementById(id);
  const panel = $('focus');
  const feedEl = $('focus-feed');
  const waitEl = $('focus-wait');
  const waitText = $('focus-wait-text');
  const toggleBtn = $('focus-toggle');
  if (!panel || !feedEl) return;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };
  const H = root.cwHarnesses;
  const KEY = storageKey(cw.sessionId);
  const POLL_RUNNING_MS = 1500;
  const POLL_IDLE_MS = 3000;
  const POLL_MAX_MS = 15000;
  const coarse = () => { try { return root.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

  let isCodex = false;
  let on = store.get(KEY) === '1';
  let thread = null;
  let seq = 0;
  let events = [];
  let truncated = false;
  let turn = null;
  let available = null; // null: not asked yet
  let timer = null;
  let inflight = false;
  let failures = 0;
  let openedCompose = false;
  const rendered = []; // [{key, size, node}]
  const openActs = new Set();
  const openTools = new Set();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function inlineNodes(parent, inline) {
    for (const t of inline) {
      if (t.t === 'code') parent.append(el('code', null, t.v));
      else if (t.t === 'b') parent.append(el('strong', null, t.v));
      else if (t.t === 'a') {
        const a = el('a', null, t.v);
        a.href = t.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.append(a);
      } else parent.append(document.createTextNode(t.v));
    }
  }
  function markdownNode(text, cls) {
    const box = el('div', cls);
    for (const b of parseMarkdown(text)) {
      if (b.type === 'p' || b.type === 'h') {
        const n = el('p', b.type === 'h' ? 'f-h' : null);
        inlineNodes(n, b.inline);
        box.append(n);
      } else if (b.type === 'list') {
        const n = el(b.ordered ? 'ol' : 'ul');
        for (const it of b.items) { const li = el('li'); inlineNodes(li, it); n.append(li); }
        box.append(n);
      } else box.append(el('pre', b.type === 'code' ? 'f-code' : 'f-table', b.text));
    }
    return box;
  }

  function toolNode(e) {
    const li = el('li', `f-tool ${e.ok === false ? 'bad' : 'ok'}`);
    const head = el('button', 'f-tool-head');
    head.type = 'button';
    head.append(el('span', 'f-mark', e.ok === false ? '✗' : '✓'), el('span', 'f-tool-title', e.title || e.tool));
    if (Number.isInteger(e.exitCode) && e.exitCode !== 0) head.append(el('span', 'f-exit', `exit ${e.exitCode}`));
    li.append(head);
    if (e.detail) {
      const pre = el('pre', 'f-detail', e.detail);
      pre.hidden = !openTools.has(e.seq);
      head.setAttribute('aria-expanded', String(!pre.hidden));
      head.addEventListener('click', () => {
        pre.hidden = !pre.hidden;
        if (pre.hidden) openTools.delete(e.seq); else openTools.add(e.seq);
        head.setAttribute('aria-expanded', String(!pre.hidden));
      });
      li.append(pre);
    } else head.disabled = true;
    return li;
  }

  function activityNode(b) {
    const s = summarize(b.items);
    const open = openActs.has(b.key);
    const box = el('div', `f-act${s.failed ? ' failed' : ''}${open ? ' open' : ''}`);
    const head = el('button', 'f-act-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'f-chev'), el('span', 'f-act-sum', s.text));
    if (s.failed) head.append(el('span', 'f-act-fail', `${s.failed} failed`));
    box.append(head);
    const last = s.last ? el('div', 'f-act-last', s.last.replace(/\s+/g, ' ')) : null;
    if (last) { last.hidden = open; box.append(last); }
    const list = el('ol', 'f-act-items');
    list.hidden = !open;
    for (const e of b.items) list.append(e.kind === 'tool' ? toolNode(e) : markdownNode(e.text, 'f-note-msg'));
    box.append(list);
    head.addEventListener('click', () => {
      const now = list.hidden;
      list.hidden = !now;
      if (last) last.hidden = now;
      box.classList.toggle('open', now);
      head.setAttribute('aria-expanded', String(now));
      if (now) openActs.add(b.key); else openActs.delete(b.key);
    });
    return box;
  }

  function blockNode(b) {
    if (b.type === 'user') return el('div', 'f-msg f-user', b.text);
    if (b.type === 'agent') {
      const n = markdownNode(b.text, `f-msg f-agent${b.phase === 'plan' ? ' f-plan' : ''}`);
      if (b.phase === 'plan') n.prepend(el('div', 'f-label', 'Plan'));
      return n;
    }
    if (b.type === 'activity') return activityNode(b);
    return el('div', b.type === 'error' ? 'f-line f-error' : 'f-line', b.text);
  }

  const atBottom = () => feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;

  function render() {
    const stick = atBottom();
    const head = $('focus-head-note');
    head.hidden = !truncated;
    const blocks = groupEvents(events);
    let i = 0;
    while (i < rendered.length && i < blocks.length && rendered[i].key === blocks[i].key && rendered[i].size === (blocks[i].items ? blocks[i].items.length : 0)) i++;
    for (const r of rendered.splice(i)) r.node.remove();
    const tail = $('focus-tail');
    for (const b of blocks.slice(i)) {
      const node = blockNode(b);
      feedEl.insertBefore(node, tail);
      rendered.push({ key: b.key, size: b.items ? b.items.length : 0, node });
    }
    const empty = $('focus-empty');
    empty.hidden = blocks.length > 0 || available === null;
    empty.textContent = available === false ? 'No Codex conversation yet. It appears here after your first prompt.' : 'Nothing to show yet.';
    $('focus-working').hidden = turn !== 'running';
    if (stick) feedEl.scrollTop = feedEl.scrollHeight;
  }

  function showWaiting(w) {
    const v = waitingView(w);
    waitEl.hidden = !v;
    if (!v) return;
    waitEl.className = `focus-wait ${v.tone}`;
    waitText.textContent = v.text;
    $('focus-term').textContent = v.terminal ? 'Open terminal' : 'Terminal';
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = null;
    if (!on || !isCodex) return;
    timer = setTimeout(poll, ms);
  }

  async function poll() {
    timer = null;
    if (!on || !isCodex || inflight) return;
    if (document.visibilityState !== 'visible') return; // visibilitychange polls again
    inflight = true;
    let next = POLL_IDLE_MS;
    try {
      const q = new URLSearchParams({ since: String(seq) });
      if (thread) q.set('thread', thread);
      const r = await fetch(`/api/sessions/${cw.sessionId}/focus?${q}`, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 400 || r.status === 404) { setStatus(r.status === 404 ? 'session not found' : 'not a Codex session'); next = POLL_MAX_MS; return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      failures = 0;
      setStatus('');
      available = !!j.available;
      if (j.reset) { events = []; for (const x of rendered.splice(0)) x.node.remove(); }
      if (Array.isArray(j.events) && j.events.length) events = events.concat(j.events);
      if (events.length > 3000) events = events.slice(-3000);
      truncated = !!j.truncated || (truncated && !j.reset);
      thread = j.thread ? j.thread.id : null;
      seq = Number.isInteger(j.seq) ? j.seq : seq;
      turn = j.turn || null;
      render();
      showWaiting(j.waiting);
      next = turn === 'running' ? POLL_RUNNING_MS : POLL_IDLE_MS;
    } catch (e) {
      failures++;
      setStatus(`feed unavailable (${e.message}); retrying`);
      next = Math.min(POLL_MAX_MS, POLL_IDLE_MS * 2 ** Math.min(failures, 3));
    } finally {
      inflight = false;
      schedule(next);
    }
  }

  function setStatus(text) {
    const s = $('focus-status');
    s.textContent = text;
    s.hidden = !text;
  }

  /** Tells the split view (pane header button) about the state. */
  function announce() {
    if (!cw.embedded) return;
    try { root.parent.postMessage({ cwSplit: 'focus', id: cw.sessionId, on: on && isCodex, available: isCodex }, root.location.origin); } catch { /* no parent */ }
  }

  function apply({ initial = false } = {}) {
    const visible = on && isCodex;
    if (toggleBtn) {
      toggleBtn.hidden = !isCodex;
      toggleBtn.classList.toggle('on', visible);
      toggleBtn.setAttribute('aria-pressed', String(visible));
    }
    panel.hidden = !visible;
    document.body.classList.toggle('focus-on', visible);
    if (visible) {
      if (cw.setCompose && cw.composeShown && !cw.composeShown()) { cw.setCompose(true, { save: false }); openedCompose = true; }
      if (!initial && !coarse() && cw.focusCompose) cw.focusCompose();
      schedule(0);
    } else {
      clearTimeout(timer);
      timer = null;
      if (openedCompose && cw.setCompose) { cw.setCompose(false, { save: false }); openedCompose = false; }
    }
    announce();
  }

  function setOn(v, { focusTerm = false } = {}) {
    on = !!v;
    store.set(KEY, on ? '1' : '0');
    apply();
    if (!on && focusTerm && !coarse()) cw.focus();
  }

  if (toggleBtn) toggleBtn.addEventListener('click', () => setOn(!on, { focusTerm: true }));
  $('focus-term').addEventListener('click', () => setOn(false, { focusTerm: true }));
  // The buttons must not take focus away from the compose box (phone keyboards stay up).
  for (const b of [toggleBtn, $('focus-term')]) if (b) b.addEventListener('mousedown', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && on && isCodex && !timer && !inflight) poll(); });

  cw.onMeta((m) => {
    const h = H ? (H.getHarness(m.harness) || H.inferHarness(m.command)) : null;
    const was = isCodex;
    isCodex = !!h && h.id === 'codex';
    if (isCodex !== was) apply({ initial: !was });
  });

  cw.focusMode = {
    get on() { return on && isCodex; },
    get available() { return isCodex; },
    toggle() { setOn(!on, { focusTerm: true }); },
    set(v) { setOn(v, { focusTerm: !v }); },
  };
  apply({ initial: true });
})(typeof window !== 'undefined' ? window : globalThis);
