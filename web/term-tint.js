// Per-session terminal tint, browser side (the design and the evidence: docs/terminal-tint.md).
//   1. Sets xterm's 16-color palette + foreground/cursor/selection from the session accent.
//   2. Colors whole text BLOCKS (your prompt, Claude's text, tool runs, file edits, turn status,
//      cross-session messages) with xterm decorations. The type of each row comes from its text and
//      structure (src/shared/terminal-tint.js classifyRows), not from palette slots, so it works on every
//      Claude Code theme, truecolor included. DISPLAY ONLY: the PTY byte stream is never rewritten (the
//      TUI redraws with cursor movement), the buffer is only read. Works on the normal buffer and on the
//      alternate screen Claude Code's fullscreen mode uses.
// Needs /app/session-color.js, /app/terminal-tint.js and /app/accent.js loaded first. Off when
// config.json has terminalTint:false (GET /api/session-colors), and nothing is changed then.
(function () {
  'use strict';
  const T = window.cwTerminalTint;
  const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const SCAN_MS = COARSE ? 300 : 150; // trailing throttle: at most one buffer scan per interval
  const LOOKBACK = 80; // rows above the viewport searched for the leader of a block that scrolled partly out

  /** Returns { set({cwd, harness}), dispose() } for `term`. */
  function attach(term) {
    let ctx = null; // { cwd, harness, accent } once the session is known
    let entries = []; // { marker, decos[], sig }: one marker per decorated row
    let timer = null;
    let off = false;
    let bufType = null;
    const subs = [];

    const accent = () => window.cwAccent.color(ctx.cwd);

    function drop(e) {
      for (const d of e.decos) { try { d.dispose(); } catch { /* already gone */ } }
      try { e.marker.dispose(); } catch { /* already gone */ }
    }
    function clearAll() {
      for (const e of entries) drop(e);
      entries = [];
    }

    /** Row `top` is the first visible row: where to start classifying so a block cut by the top edge keeps its type. */
    function windowStart(buf, cell, top) {
      if (top === 0) return 0;
      const first = buf.getLine(top);
      if (first && first.translateToString(true).trim() !== '' && T.isLeaderText(first.translateToString(true))) return top;
      const stop = Math.max(0, top - LOOKBACK);
      for (let y = top - 1; y >= stop; y--) {
        const line = buf.getLine(y);
        if (line && !line.isWrapped && T.isLeaderText(line.translateToString(true))) return y;
      }
      return top;
    }

    /** Paints one row: a decoration per run of recolorable text, a background fill and a gutter where the style has them. */
    function paint(buf, cell, y, hit, style, marker) {
      const decos = [];
      const add = (x, width, fg, bg) => {
        if (width < 1 || (!fg && !bg)) return;
        const o = { marker, x, width };
        if (fg) o.foregroundColor = fg;
        if (bg) o.backgroundColor = bg;
        const d = term.registerDecoration(o);
        if (d) decos.push(d);
      };
      let from = hit.x;
      if (style.gutter) {
        add(0, 1, style.gutter.fg, style.gutter.bg);
        from = Math.max(from, 1);
      }
      const segs = T.rowSegments(buf, y, cell, from, !!style.bg);
      for (const s of segs) {
        if (s.plain) add(s.x, s.w, style.fg, style.bg);
        else add(s.x, s.w, null, style.bg); // inline code, links, diff colors, errors keep their own color
      }
      return decos;
    }

    /** Reconciles the decorations on the visible rows with what the buffer shows now. */
    function scan() {
      timer = null;
      if (off || !ctx) return;
      const buf = term.buffer.active;
      if (buf.type !== bufType) { clearAll(); bufType = buf.type; } // markers belong to one buffer
      entries = entries.filter((e) => !e.marker.isDisposed);
      const byLine = new Map(entries.map((e) => [e.marker.line, e]));
      const acc = accent();
      const cell = buf.getNullCell();
      const top = buf.viewportY;
      const start = windowStart(buf, cell, top);
      const descs = [];
      for (let y = start; y < top + term.rows; y++) descs.push(T.describeRow(buf, y, cell));
      const res = T.classifyRows(descs, { harness: ctx.harness, guessTop: start === top && (top > 0 || buf.type === 'alternate') });
      const keep = new Set();
      for (let r = 0; r < term.rows; r++) {
        const y = top + r;
        const d = descs[y - start];
        const hit = res[y - start];
        if (!hit) continue;
        const sig = `${hit.type}:${hit.x}:${term.cols}:${acc}:${d.text}:${d.bg}`;
        const have = byLine.get(y);
        if (have && have.sig === sig) { keep.add(have); continue; }
        if (have) { drop(have); entries.splice(entries.indexOf(have), 1); }
        const style = T.lineStyle(hit.type, acc);
        const marker = style && term.registerMarker(y - (buf.baseY + buf.cursorY));
        if (!marker) continue;
        const decos = paint(buf, cell, y, hit, style, marker);
        if (!decos.length) { marker.dispose(); continue; }
        const e = { marker, decos, sig };
        entries.push(e);
        keep.add(e);
      }
      // Rows now on screen that no longer match (the TUI redrew them) lose their decoration;
      // rows in the scrollback keep theirs.
      entries = entries.filter((e) => {
        if (keep.has(e)) return true;
        const line = e.marker.line;
        if (line >= top && line < top + term.rows) { drop(e); return false; }
        return true;
      });
    }
    function schedule() {
      if (off || timer !== null || !ctx) return;
      timer = setTimeout(scan, SCAN_MS);
    }

    subs.push(term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule));

    async function set(next) {
      if (!next || !next.cwd) return;
      try { await window.cwAccent.ready; } catch { /* the hashed accent is used */ }
      if (off || !window.cwAccent.tintEnabled()) return;
      const harness = next.harness || 'claude';
      // renderMeta() calls this on every meta update (client counts, titles): only a real change repaints.
      if (ctx && ctx.cwd === next.cwd && ctx.harness === harness && ctx.accent === window.cwAccent.color(next.cwd)) return;
      ctx = { cwd: next.cwd, harness, accent: window.cwAccent.color(next.cwd) };
      term.options.theme = T.buildTheme(accent(), ctx.harness);
      clearAll(); // a new accent or harness: every decoration is rebuilt
      schedule();
    }
    function dispose() {
      off = true;
      if (timer !== null) clearTimeout(timer);
      for (const s of subs) s.dispose();
      clearAll();
    }
    return { set, dispose };
  }

  window.cwTermTint = Object.freeze({ attach });
})();
