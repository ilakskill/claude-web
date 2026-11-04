// Per-session accent colors: one stable color per project folder, so sessions in the same cwd
// look alike on the list page, the session title bar, the split view and the Focus view.
// Written as a plain script (like recent-filter.js): a classic browser script at /app/session-color.js
// (the page CSP allows no modules or inline code) and a Node ESM side-effect import; both read
// globalThis.cwSessionColor.
(function (root) {
  'use strict';

  // Ten hues that keep >= 4.5:1 (WCAG AA) contrast against the dark surfaces (#0b0e12 / #12171e), so the
  // color is readable as text as well as a bar. None is close to the status colors: attention
  // amber (#f2b441) and danger red (#ff6b6b).
  const PALETTE = Object.freeze([
    '#a78bfa', // violet
    '#60a5fa', // blue
    '#22d3ee', // cyan
    '#4ade80', // green
    '#bef264', // lime
    '#fb923c', // orange
    '#f472b6', // pink
    '#e879f9', // fuchsia
    '#d6b88a', // sand
    '#818cf8', // indigo
  ]);

  /** A folder path as a comparison key: forward slashes, lower case, no trailing slash. */
  function pathKey(cwd) {
    if (typeof cwd !== 'string') return '';
    const s = cwd.trim().replace(/[\\/]+/g, '/').toLowerCase();
    return s.length > 1 ? s.replace(/\/$/, '') : s;
  }

  /** "#abc" / "#AABBCC" -> "#aabbcc"; anything else -> null. */
  function normalizeColor(v) {
    if (typeof v !== 'string') return null;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return null;
    const h = m[1].toLowerCase();
    return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
  }

  /** FNV-1a, 32 bit: tiny, stable across engines and releases. */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * The accent color (#rrggbb) for a working directory. `overrides` maps folder -> color; the
   * exact folder wins, else the nearest configured parent folder, else a palette color chosen by
   * a hash of the folder. Invalid override colors are ignored. Never throws.
   */
  function colorFor(cwd, overrides) {
    const key = pathKey(cwd);
    if (overrides && typeof overrides === 'object') {
      let best = null;
      let bestLen = -1;
      for (const [folder, color] of Object.entries(overrides)) {
        const fk = pathKey(folder);
        const c = normalizeColor(color);
        if (!fk || !c) continue;
        const hit = key === fk || key.startsWith(fk.endsWith('/') ? fk : fk + '/');
        if (hit && fk.length > bestLen) { best = c; bestLen = fk.length; }
      }
      if (best) return best;
    }
    return PALETTE[hash(key) % PALETTE.length];
  }

  root.cwSessionColor = Object.freeze({ PALETTE, pathKey, normalizeColor, colorFor });
})(globalThis);
