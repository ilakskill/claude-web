// Per-session accent color for cw's own chrome (the terminal's text is the agent's, not ours).
// Sets the CSS variable --sc on an element from the session's cwd; style.css reads it.
// Needs /app/session-color.js loaded first. Config overrides (config.json sessionColors) arrive
// from GET /api/session-colors; until then, and if that fails, the hashed color is used. When the
// overrides arrive, every painted element is repainted.
(function () {
  'use strict';
  const { colorFor } = window.cwSessionColor;
  let overrides = {};

  /** The accent color for a cwd. */
  const color = (cwd) => colorFor(cwd, overrides);

  /** Sets --sc on `node` for `cwd` (kept in data-sc-cwd so the overrides can repaint it later). */
  function paint(node, cwd) {
    if (!node || !cwd) return node;
    node.dataset.scCwd = cwd;
    node.style.setProperty('--sc', color(cwd));
    return node;
  }

  function repaintAll() {
    for (const n of document.querySelectorAll('[data-sc-cwd]')) n.style.setProperty('--sc', color(n.dataset.scCwd));
  }

  async function load() {
    try {
      const r = await fetch('/api/session-colors', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.colors && typeof j.colors === 'object') { overrides = j.colors; repaintAll(); }
      if (j && j.terminalTint === false) tint = false; // config.json terminalTint (term-tint.js)
    } catch { /* the hashed colors stay */ }
  }

  let tint = true;
  // ready: settles once the overrides and the terminalTint flag are known (or the request failed),
  // so term-tint.js can apply the final accent once instead of flashing the hashed one first.
  const ready = load();
  window.cwAccent = Object.freeze({ color, paint, ready, tintEnabled: () => tint });
})();
