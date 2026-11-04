// Shared by the hub (POST /api/sessions/<id>/upload, src/hub/uploads.js) and the session page
// (web/drop.js): the upload size cap, how a dropped file's name becomes a safe file name, and how
// the saved paths are typed into the terminal. A plain script like recent-filter.js, so it works as
// a classic browser script (/app/uploads.js) and as a Node ESM side-effect import; both read
// globalThis.cwUploads.
(function (root) {
  'use strict';

  /** Largest upload the hub accepts (413 above it); the page checks it before sending. */
  const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
  const NAME_MAX = 100; // characters of the sanitized name (the unique prefix comes on top)
  const EXT_MAX = 16;   // an "extension" longer than this is treated as part of the name

  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (also with an extension: "con.txt" is the console too).
  const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

  /**
   * A dropped file's name as a safe single path segment: the last segment only (no directories, so
   * no traversal), control/format characters dropped, characters Windows forbids (<>:"/\|?*) and
   * whitespace runs turned into `_`, no leading dots, no trailing dots or spaces (Windows strips
   * them), reserved device names prefixed with `_`, at most NAME_MAX characters with the extension
   * kept. Never empty: falls back to `upload` (plus the extension when there was one).
   * @param {unknown} raw
   * @returns {string}
   */
  function sanitizeUploadName(raw) {
    let s = typeof raw === 'string' ? raw : '';
    s = s.split(/[\\/]/).pop() || '';
    s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
    s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    s = s.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, '_');
    const dot = s.lastIndexOf('.');
    let base = dot > 0 ? s.slice(0, dot) : s;
    let ext = dot > 0 ? s.slice(dot) : '';
    if (ext.length > EXT_MAX + 1) { base = s; ext = ''; }
    // The device-name rule applies to the part before the first dot ("nul.tar.gz" too).
    if (RESERVED_RE.test(base.split('.')[0])) base = `_${base}`;
    if (!base) base = 'upload';
    if (base.length + ext.length > NAME_MAX) base = base.slice(0, NAME_MAX - ext.length).replace(/[.\s]+$/, '') || 'upload';
    return base + ext;
  }

  /**
   * A path as typed into a terminal: double-quoted when it holds whitespace or a character a shell
   * would act on, unchanged otherwise. Windows paths cannot contain `"`, so no escaping is needed.
   */
  function quotePath(p) {
    const s = String(p);
    return /[\s"'`$&|;<>()^,%!]/.test(s) ? `"${s}"` : s;
  }

  /** Several saved paths as one line (space-separated, each quoted as needed). */
  function joinPaths(paths) {
    return (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).map(quotePath).join(' ');
  }

  const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg' };

  /**
   * The name to send for a file: its own name, else (a clipboard image has none, or a generic
   * "image.png") `pasted-<time>` with an extension from its MIME type.
   * @param {{name?: string, type?: string}} file
   * @param {Date} [now]
   */
  function uploadName(file, now = new Date()) {
    const name = file && typeof file.name === 'string' ? file.name : '';
    if (name && name !== 'image.png') return name;
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `pasted-${stamp}${IMAGE_EXT[file && file.type] || (name ? '.png' : '')}`;
  }

  root.cwUploads = { UPLOAD_MAX_BYTES, NAME_MAX, sanitizeUploadName, quotePath, joinPaths, uploadName };
})(typeof window !== 'undefined' ? window : globalThis);
