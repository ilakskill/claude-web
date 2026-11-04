// Shared by the list page and the CLI (`cw ls`, `cw clear`): which recent entries are hidden by
// default, and how session metadata is worded. Written as a plain script so the same file works
// as a classic browser script (the hub serves it as /app/recent-filter.js; the page CSP allows no
// modules or inline code) and as a Node ESM side-effect import. Both read globalThis.cwRecentFilter.
(function (root) {
  'use strict';

  /**
   * Hidden by default: recent entries known to have no Claude transcript (shells, test sessions,
   * sessions that failed to start, Claude sessions that never got a session id), unless the user
   * renamed them. Entries without the field (written by an older hub) are shown.
   */
  function isHidden(entry) {
    if (!entry || entry.hasTranscript !== false) return false;
    // Agents other than Claude (copilot, codex, ...) never have a Claude transcript: always shown.
    if (typeof entry.harness === 'string' && entry.harness !== '' && entry.harness !== 'claude' && entry.harness !== 'shell') return false;
    return !(typeof entry.userTitle === 'string' && entry.userTitle);
  }

  /** Longest session title, in UTF-16 units (the user's own and the transcript-derived one). */
  const TITLE_MAX = 80;

  /** Control characters out, whitespace collapsed. */
  function cleanText(s) {
    return String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** A user-supplied title ready to store: cleaned and cut to TITLE_MAX; '' (clears) for non-strings and blanks. */
  function normalizeTitle(value) {
    if (typeof value !== 'string') return '';
    return truncate(cleanText(value), TITLE_MAX);
  }

  /** The name to show for a session or recent entry: the user's own, else the transcript's, else null. */
  function displayTitle(entry) {
    return (entry && (entry.userTitle || entry.title || entry.termTitle)) || null;
  }

  /**
   * True when saving `value` (already normalizeTitle()d) would change nothing: it equals the user's
   * own title, or, with none set, Claude's title (so a transcript title is never pinned as the
   * user's name). Both web pages skip the PATCH then.
   */
  function isSameTitle(entry, value) {
    const own = (entry && entry.userTitle) || '';
    return value === own || (!own && value === ((entry && entry.title) || ''));
  }

  /**
   * @param {object[]} recent
   * @param {boolean} showAll
   * @returns {{shown: object[], hidden: number}} `hidden` counts the hideable entries (also when showAll)
   */
  function partitionRecent(recent, showAll) {
    const list = Array.isArray(recent) ? recent : [];
    const hidden = list.filter(isHidden).length;
    return { shown: showAll ? list.slice() : list.filter((e) => !isHidden(e)), hidden };
  }

  /** Cuts text to at most `max` characters, ending in an ellipsis when cut. */
  function truncate(text, max) {
    const s = text === null || text === undefined ? '' : String(text);
    if (!(max > 0)) return '';
    if (s.length <= max) return s;
    return max === 1 ? '…' : `${s.slice(0, max - 1).trimEnd()}…`;
  }

  /** 42s, 12m, 1h 05m, 3d 4h; '' for a missing or negative duration. */
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  /** How a recent session ended: 'exit 0', 'killed', 'hub restarted', 'failed to start'. */
  function endText(entry) {
    const r = entry && entry.endReason;
    if (r === 'killed') return 'killed';
    if (r === 'hub-restart') return 'hub restarted';
    if (r === 'spawn-failed') return 'failed to start';
    const code = entry ? entry.exitCode : null;
    return `exit ${code === null || code === undefined ? '?' : code}`;
  }

  /** The command's short name (`pwsh`, `claude`), without directory or .exe/.cmd/.bat. */
  function commandName(command) {
    const s = String(command || '').replace(/[\\/]+$/, '');
    const base = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
    return base.replace(/\.(exe|cmd|bat|com)$/i, '');
  }

  /** True when the command is Claude Code itself (so the list does not repeat it). */
  function isClaude(command) {
    return /^claude$/i.test(commandName(command));
  }

  root.cwRecentFilter = Object.freeze({ TITLE_MAX, cleanText, normalizeTitle, displayTitle, isSameTitle, isHidden, partitionRecent, truncate, formatDuration, endText, commandName, isClaude });
})(globalThis);
