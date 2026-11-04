// Per-session terminal tint: which color each TEXT TYPE gets inside a session's terminal.
// Two layers (see docs/terminal-tint.md for the evidence behind every slot):
//   1. buildTheme(): xterm's 16-color palette. Claude Code's built-in theme "dark-ansi" (and most of
//      Codex) only use the 16 ANSI slots, so remapping them recolors errors, warnings, permission
//      prompts, assistant text and the user-prompt row without touching the byte stream.
//   2. classifyRows() + LINE_STYLES: display-only BLOCK classes read from the rendered text and
//      structure, not from palette slots, so they work on every Claude Code theme (truecolor included,
//      where the palette layer does nothing): your prompt, Claude's text, tool runs, file edits, turn
//      status, cross-session messages. A type colors its whole block; web/term-tint.js paints it with
//      xterm decorations after reading the rendered buffer. The PTY stream is never rewritten.
// Written as a plain script (like session-color.js): a classic browser script at /app/terminal-tint.js
// (the page CSP allows no modules or inline code) and a Node ESM side-effect import; both read
// globalThis.cwTerminalTint.
(function (root) {
  'use strict';

  const BG = '#0b0e12'; // the terminal background (the same as before this feature)
  const FG = '#dfe5ec'; // default foreground = assistant text
  const FALLBACK_ACCENT = '#a78bfa';
  const MIN_CONTRAST = 4.5; // WCAG AA for normal text

  // ---------- color math ----------
  const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  function luminance(hex) {
    const [r, g, b] = toRgb(hex);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  /** WCAG contrast ratio of two #rrggbb colors (1..21). */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** `a` moved `t` (0..1) of the way toward `b`. */
  function mix(a, b, t) {
    const x = toRgb(a);
    const y = toRgb(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  /** `fg` lightened (toward white) just until it has `min` contrast on `bg`; unchanged when it already does. */
  function ensureContrast(fg, bg, min = MIN_CONTRAST) {
    let c = fg;
    for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = mix(c, '#ffffff', 0.08);
    return c;
  }

  const accentOf = (accent) => {
    const n = root.cwSessionColor?.normalizeColor?.(accent);
    return n || FALLBACK_ACCENT;
  };

  // ---------- layer 1: the 16-color palette ----------
  // Slot meanings in Claude Code "dark-ansi" (from its bundled theme tables, claude.exe 2.1.x):
  //   7 white         inactive / subtle / promptBorder        -> muted, never the assistant color
  //   8 brightBlack   userMessageBackground (the prompt row's BACKGROUND) -> tinted by the accent
  //   9 brightRed     error, "claude" brand/spinner           -> red
  //  10 brightGreen   success (tool bullet "ok"), diffAddedWord
  //  11 brightYellow  warning
  //  12 brightBlue    permission (dialog border), suggestion  -> amber: "needs you" must stand out
  //  15 brightWhite   text (assistant bullet)                 -> same as the foreground
  // 1/2 (red/green) double as the diff colors and as Codex's error/ok text, so they stay readable text colors.
  const MUTED = '#9aa6b5';

  /** The prompt row's background: the accent mixed into BG as strongly as keeps the muted pointer (and all light text) AA on it. */
  function userRowBg(a) {
    for (let t = 0.24; t > 0.02; t -= 0.02) {
      const c = mix(BG, a, t);
      if (contrast(MUTED, c) >= MIN_CONTRAST) return c;
    }
    return BG;
  }

  /**
   * An xterm.js ITheme for one session. `accent` is the session color (#rrggbb); `harness` is the
   * session's harness id: Claude's slot 8 is a prompt-row background, for other TUIs (Codex's
   * "DarkGray") it is text, so it stays a readable gray there.
   */
  function buildTheme(accent, harness) {
    const a = accentOf(accent);
    const claude = harness === undefined || harness === null || harness === 'claude';
    const userBg = userRowBg(a);
    return {
      background: BG,
      foreground: FG,
      cursor: ensureContrast(a, BG),
      cursorAccent: BG,
      selectionBackground: mix(BG, a, 0.45),
      selectionInactiveBackground: mix(BG, a, 0.3),
      black: '#1c232c',
      red: '#f0716d',
      green: '#5fd08a',
      yellow: '#e0b44a',
      blue: '#6aa3ff',
      magenta: '#c58af9',
      cyan: '#4fd1c5',
      white: MUTED,
      brightBlack: claude ? userBg : ensureContrast(mix('#6b7686', a, 0.2), BG),
      brightRed: '#ff7b7b',
      brightGreen: '#6ee7a0',
      brightYellow: '#ffcb5c',
      brightBlue: '#ffb454',
      brightMagenta: '#e0a3ff',
      brightCyan: '#67e8f9',
      brightWhite: FG,
    };
  }

  // ---------- layer 2: text blocks, classified from the rendered rows ----------
  // Claude Code's themes differ (16-color "dark-ansi" vs truecolor "dark"), so nothing here depends on
  // a palette index: a row's type comes from its TEXT and structure (leader glyph, indentation, rules),
  // and a type then colors the WHOLE block (the leader row plus every continuation row below it).
  //   prompt     your text to Claude: a row starting ">" or "❯" at column 0 (+ wrapped / same-background rows)
  //   assistant  Claude's text to you: "● "/"⏺ " followed by prose (+ every row until the next boundary)
  //   tool       "● Bash(...)", "● Read 3 files", the "Ran 3 shell commands" summaries (+ their "⎿" output)
  //   edit       "● Update(...)", "● Write(...)", "Edited 2 files" (+ their "⎿" output and diff)
  // plus the one-liners: cross-session "› Message from", turn status "✻ Brewed for 5s", and diff +/-
  // rows that carry no color of their own. Everything else (the input box, footer, dialogs, errors) is
  // left to the terminal's own colors.
  // The one place that says which block type gets which color. `accent` = the session accent.
  const dimmer = (hex, t) => ensureContrast(mix(hex, BG, t), BG);
  const TOOL = '#7db7ff';
  const EDIT = '#ffa95e';
  const LINE_STYLES = Object.freeze({
    prompt: { label: 'your prompt (accent text, tinted row, accent bar)', fg: 'accent', bg: 'accentRow', gutter: true },
    assistant: { label: 'Claude text', fg: '#9ae9bd' },
    tool: { label: 'tool call / tool summary', fg: TOOL },
    toolOut: { label: 'tool output', fg: dimmer(TOOL, 0.3) },
    edit: { label: 'file edit', fg: EDIT },
    editOut: { label: 'file edit output', fg: dimmer(EDIT, 0.3) },
    diffAdd: { label: 'diff added row (only when the TUI left it uncolored)', fg: '#6ee7a0' },
    diffDel: { label: 'diff removed row (only when the TUI left it uncolored)', fg: '#ff8a8a' },
    crossSession: { label: 'cross-session message', fg: '#f0a0d8' },
    status: { label: 'turn status', fg: '#a99f8f' },
  });

  /** The decoration foreground (#rrggbb) for a line type, or null. The prompt color is the accent lifted to AA on the tinted row. */
  function lineColor(type, accent) {
    const s = LINE_STYLES[type];
    if (!s) return null;
    if (s.fg !== 'accent') return s.fg;
    const a = accentOf(accent);
    return ensureContrast(a, userRowBg(a));
  }

  /**
   * Everything the browser paints for a line type: { fg, bg (row background or null), gutter ({bg, fg} for
   * the first cell or null) }, or null for an unknown type.
   */
  function lineStyle(type, accent) {
    const s = LINE_STYLES[type];
    if (!s) return null;
    const a = accentOf(accent);
    return {
      fg: lineColor(type, accent),
      bg: s.bg === 'accentRow' ? userRowBg(a) : null,
      gutter: s.gutter ? { bg: a, fg: contrast(BG, a) >= contrast('#ffffff', a) ? BG : '#ffffff' } : null,
    };
  }

  const BULLETS = '●⏺';
  const SPINNERS = '✻✶✳✢✽';
  const RULE_RE = /^[─━═╌┄┈]{6,}$/;
  const PROMPT_RE = /^[>❯](\s|$)/;
  const MENU_RE = /^[>❯]\s*\d+[.)]\s/; // a dialog's selection pointer ("❯ 1. Yes"), not a prompt
  const DIALOG_RE = /^(Do you want to|Would you like to|Allow )/;
  const MESSAGE_RE = /^[›»]\s+Message from\s/;
  const STATUS_RE = /^[✻✶✳✢✽]\s+\S+\s+for\s+\d/;
  const TOOL_SHAPE_RE = /^([A-Z][A-Za-z0-9_]*)\(/; // "Bash(git status)"
  const MCP_RE = /^(mcp__|[\w.-]+ - [\w.-]+ \(MCP\))/;
  const SUMMARY_RE = /^(Ran|Read|Called|Edited|Wrote|Searched|Listed|Fetched|Updated|Created|Explored|Used|Reading|Searching|Listing|Fetching|Running|Editing|Writing|Updating|Creating)\s+(?:for\s+)?\d+\s+\S/;
  const EDIT_NAME_RE = /^(Update|Write|Edit|MultiEdit|NotebookEdit|Create)$/;
  const EDIT_SUMMARY_RE = /^(Edited|Wrote|Updated|Created|Editing|Writing|Updating|Creating)\b/;
  const DIFF_ADD_RE = /^\s*(\d+\s*)?\+(\s|$)/;
  const DIFF_DEL_RE = /^\s*(\d+\s*)?-(\s|$)/;

  /** True when `text` (a trimmed-right row) begins a block or a boundary: used to find where a block starts above the viewport. */
  function isLeaderText(text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    const body = text.trimStart();
    const lead = text.length - body.length;
    if (body.startsWith('⎿')) return true;
    if (RULE_RE.test(body.trim())) return true;
    if (lead !== 0) return false;
    if (PROMPT_RE.test(body) && !MENU_RE.test(body)) return true;
    if (BULLETS.includes(body[0]) && body[1] === ' ') return true;
    return SPINNERS.includes(body[0]) || MESSAGE_RE.test(body);
  }

  /** A color class for a descriptor: only default / white / gray text is recolored; real colors (code, links, diffs, errors) stay. */
  const isPlainClass = (c) => c === undefined || c === null || c === 'default' || c === 'white' || c === 'gray';

  /**
   * Classifies a run of rendered terminal rows, top to bottom, as blocks. `rows[i]` is a describeRow()
   * result or null for an empty row; `opts` = { harness, state } (state: carry-over from a previous call).
   * A row = { text, bg0|bg, fg, dim, wrapped, fgc, bodyc, hasBg } (fields beyond text are optional). Returns an
   * array parallel to `rows` of { type, x } (x = first cell to color) or null (leave the row to the palette).
   * Pure.
   */
  function classifyRows(rows, opts) {
    const o = opts || {};
    const claude = o.harness === undefined || o.harness === null || o.harness === 'claude';
    const out = new Array(rows.length).fill(null);
    let st = o.state ? { kind: o.state.kind || null, bg: o.state.bg || null } : { kind: null, bg: null };
    let prevRule = false;
    let prev = null;
    let seen = !o.guessTop; // a leader or boundary has been seen in this window
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const text = r && typeof r.text === 'string' ? r.text : '';
      if (text.trim() === '') { prev = null; continue; } // a blank row never ends a block
      const lead = text.length - text.trimStart().length;
      const body = text.slice(lead);
      const bgKey = r.bg !== undefined ? r.bg : (r.bg0 !== undefined && r.bg0 !== null ? 'p' + r.bg0 : null);
      const first = body[0];
      const wasRule = prevRule;
      const wasSeen = seen;
      seen = true;
      prevRule = false;
      let hit = null;

      // ---- one-liners and boundaries (every harness) ----
      if (!r.wrapped && lead === 0 && MESSAGE_RE.test(body)) { st = { kind: null, bg: null }; hit = { type: 'crossSession', x: 0 }; }
      else if (!r.wrapped && lead === 0 && SPINNERS.includes(first) && /^\S\s/.test(body)) {
        st = { kind: null, bg: null };
        if (STATUS_RE.test(body)) hit = { type: 'status', x: 0 };
      } else if (!claude) {
        if (body.startsWith('⎿')) hit = { type: 'toolOut', x: lead };
      } else if (RULE_RE.test(body.trim())) { // also a rule row that wrapped at a narrow width
        st = { kind: null, bg: null };
        prevRule = true;
      } else if (!r.wrapped && lead === 0 && PROMPT_RE.test(body) && !MENU_RE.test(body)) {
        if (!bgKey && wasRule) st = { kind: 'input', bg: null }; // the live input box: left alone
        else { st = { kind: 'prompt', bg: bgKey }; hit = { type: 'prompt', x: 0 }; }
      } else if (!r.wrapped && lead <= 2 && (DIALOG_RE.test(body) || MENU_RE.test(body))) {
        st = { kind: null, bg: null };
      } else if (!r.wrapped && lead === 0 && BULLETS.includes(first) && body[1] === ' ') {
        const rest = body.slice(2).trimStart();
        const shape = TOOL_SHAPE_RE.exec(rest);
        let kind;
        if (shape) kind = EDIT_NAME_RE.test(shape[1]) ? 'edit' : 'tool';
        else if (MCP_RE.test(rest)) kind = 'tool';
        else if (SUMMARY_RE.test(rest)) kind = EDIT_SUMMARY_RE.test(rest) ? 'edit' : 'tool';
        else if (r.bodyc === 'gray') kind = 'notice'; // a system notice ("● A process claiming ..."): not Claude's prose
        else if (r.fgc === 'color') kind = 'tool'; // a green/red bullet is a tool status dot
        else kind = 'assistant';
        st = { kind, bg: null };
        if (kind === 'assistant') hit = { type: 'assistant', x: 0 };
        else if (kind === 'tool' || kind === 'edit') hit = { type: kind, x: lead + 2 };
      } else if (!r.wrapped && body.startsWith('⎿')) {
        const kind = st.kind === 'edit' ? 'edit' : 'tool';
        st = { kind, bg: null };
        hit = { type: kind + 'Out', x: lead };
      } else if (!r.wrapped && lead <= 2 && r.fgc === 'gray' && SUMMARY_RE.test(body)) {
        const kind = EDIT_SUMMARY_RE.test(body) ? 'edit' : 'tool'; // "Ran 3 shell commands" with no bullet
        st = { kind, bg: null };
        hit = { type: kind, x: lead };
      } else {
        // ---- a continuation row: it takes the block above ----
        switch (st.kind) {
          case 'prompt':
            if (r.wrapped || (st.bg && bgKey === st.bg)) hit = { type: 'prompt', x: 0 };
            else st = { kind: null, bg: null };
            break;
          case 'assistant': hit = { type: 'assistant', x: 0 }; break;
          case 'tool': hit = { type: 'toolOut', x: 0 }; break;
          case 'edit':
            if (!r.hasBg && DIFF_ADD_RE.test(text)) hit = { type: 'diffAdd', x: 0 };
            else if (!r.hasBg && DIFF_DEL_RE.test(text)) hit = { type: 'diffDel', x: 0 };
            else if (r.hasBg && (DIFF_ADD_RE.test(text) || DIFF_DEL_RE.test(text))) hit = null; // the TUI colored it: keep its +/- colors
            else hit = { type: 'editOut', x: 0 };
            break;
          default:
            // the window starts mid-block (its leader scrolled out): indented prose is Claude's text
            if (!wasSeen && lead >= 1 && lead <= 2 && !r.wrapped && r.fgc !== 'color') {
              st = { kind: 'assistant', bg: null };
              hit = { type: 'assistant', x: 0 };
              break;
            }
            // a wrapped one-liner (a long cross-session / status line) keeps its color
            if (r.wrapped && prev && (prev.type === 'crossSession' || prev.type === 'status')) hit = { type: prev.type, x: 0 };
        }
      }
      out[i] = hit;
      prev = hit;
    }
    return out;
  }

  /** Classifies one row on its own (no block context: continuation rows come back null). */
  function classifyLine(line, opts) {
    return classifyRows([line], opts)[0];
  }

  const rgbOf = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  /** 'default' | 'white' | 'gray' | 'color' for a cell's foreground. */
  function fgClass(cell) {
    if (cell.isFgDefault()) return 'default';
    const v = cell.getFgColor();
    if (cell.isFgPalette()) {
      if (v === 15) return 'white';
      return v === 7 || v === 8 || v === 0 ? 'gray' : 'color';
    }
    const [r, g, b] = rgbOf(v);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) return 'color';
    return r >= 215 ? 'white' : 'gray';
  }
  const bgKeyOf = (cell) => (cell.isBgDefault() ? null : cell.isBgPalette() ? 'p' + cell.getBgColor() : 'r' + cell.getBgColor().toString(16));

  /**
   * Describes buffer row `y` of an xterm buffer for classifyRows, or null when the row is empty.
   * `cell` is a reusable IBufferCell (buffer.getNullCell()).
   */
  function describeRow(buffer, y, cell) {
    const row = buffer.getLine(y);
    if (!row) return null;
    const text = row.translateToString(true);
    if (text.trim() === '') return null;
    const lead = text.length - text.trimStart().length;
    // IBufferCell is one reusable object: every getCell() call overwrites the previous one, so read each cell fully first.
    const d = { text, bg0: null, bg: null, fg: null, fgc: 'default', bodyc: 'default', hasBg: false, dim: false, wrapped: !!row.isWrapped };
    const c0 = row.getCell(0, cell);
    if (c0) {
      d.bg0 = c0.isBgPalette() ? c0.getBgColor() : null;
      d.bg = bgKeyOf(c0);
    }
    const cl = row.getCell(lead, cell);
    if (cl) {
      d.fg = cl.isFgPalette() ? cl.getFgColor() : null;
      d.fgc = fgClass(cl);
      d.hasBg = !cl.isBgDefault();
      d.dim = !!cl.isDim();
    }
    // a colored row (a diff line) may start its background after the line number: look at the far end too
    const ce = row.getCell(Math.min(text.length, row.length) - 1, cell);
    if (ce && !ce.isBgDefault()) d.hasBg = true;
    // the first text cell after a 2-column leader ("● ", "✻ ", "> "): where the body color shows
    const cb = row.getCell(lead + 2, cell);
    if (cb) d.bodyc = fgClass(cb);
    return d;
  }

  const MAX_SEGMENTS = 10;
  /**
   * Splits columns [from, end) of buffer row `y` into runs: { x, w, plain }. `plain` runs have default,
   * white or gray text (safe to recolor); other runs (inline code, links, diff colors, errors) must keep
   * their own color. With `fill` the last run extends to the right edge (for a row background). Spaces
   * join the run they sit in. More than MAX_SEGMENTS runs collapse to one plain run.
   */
  function rowSegments(buffer, y, cell, from, fill) {
    const row = buffer.getLine(y);
    if (!row) return [];
    const cols = row.length;
    let last = -1;
    const flags = new Array(cols).fill(null); // null = space/blank, true = plain text, false = colored text
    for (let x = from; x < cols; x++) {
      const c = row.getCell(x, cell);
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars();
      if (ch === '' || ch === ' ') continue;
      flags[x] = isPlainClass(fgClass(c));
      last = x;
    }
    const end = fill ? cols : last + 1;
    if (end <= from) return [];
    const segs = [];
    let cur = null;
    for (let x = from; x < end; x++) {
      const f = flags[x] === null ? (cur ? cur.plain : true) : flags[x];
      if (cur && cur.plain === f) cur.w++;
      else { cur = { x, w: 1, plain: f }; segs.push(cur); }
    }
    if (segs.length > MAX_SEGMENTS) return [{ x: from, w: end - from, plain: true }];
    return segs;
  }

  root.cwTerminalTint = Object.freeze({
    BG, FG, MUTED, LINE_STYLES, MIN_CONTRAST,
    contrast, mix, ensureContrast, buildTheme, lineColor, lineStyle,
    classifyRows, classifyLine, describeRow, rowSegments, isLeaderText,
  });
})(globalThis);
