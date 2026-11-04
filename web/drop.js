// cw file drop and image paste: a file dragged onto the session page, or an image pasted into the
// terminal with Ctrl+V, is uploaded to the hub (POST /api/sessions/<id>/upload), which saves it
// outside any repo and answers with the absolute path. The path (quoted when needed, several
// space-separated, no Enter) is then pasted into the terminal through xterm's own paste, so it is
// wrapped in bracketed paste when the app asked for it, exactly like the key bar's Paste. Like
// dragging a file into a native terminal, Claude Code / Codex can then read the file.
// Text paste is untouched: only a paste that carries files and no text/plain is taken over, and
// only when it targets the terminal (the compose bar and the paste box keep their own paste).
// Needs /app/uploads.js (src/shared) and term.js (window.cw) loaded first.
(() => {
  'use strict';
  const cw = window.cw;
  const U = window.cwUploads;
  if (!cw || !cw.sessionId || !cw.term || !U) return;
  const $ = (id) => document.getElementById(id);
  const zone = $('drop-zone');
  const toast = $('drop-toast');
  const ZONE_LINGER_MS = 250; // dragover fires every ~50 ms while over the page; hide once it stops
  const maxText = `${Math.round(U.UPLOAD_MAX_BYTES / (1024 * 1024))} MB`;

  // ---------- toast ----------
  let toastTimer = null;
  function say(text, { error = false, ms = error ? 5000 : 2500, sticky = false } = {}) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.classList.toggle('error', error);
    toast.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => { toast.hidden = true; toast.textContent = ''; }, ms);
  }

  // ---------- upload ----------
  /** One file to the hub; resolves the hub's {path, name, bytes}. XHR for the upload progress. */
  function send(file, name, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/sessions/${cw.sessionId}/upload?name=${encodeURIComponent(name)}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => {
        let j = null;
        try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status === 201 && j && typeof j.path === 'string') { resolve(j); return; }
        const msg = x.status === 401 ? 'unauthorized' : (j && j.error) || `HTTP ${x.status}`;
        reject(new Error(msg));
      };
      x.onerror = () => reject(new Error('network error (a folder, or the hub is unreachable)'));
      x.send(file);
    });
  }

  let busy = false;
  /** Uploads the files one after another, then pastes the saved paths into the terminal. */
  async function upload(files) {
    files = files.filter(Boolean);
    if (!files.length) return;
    if (busy) { say('an upload is still running', { error: true }); return; }
    const big = files.find((f) => f.size > U.UPLOAD_MAX_BYTES);
    if (big) { say(`${big.name || 'file'} is too large (${maxText} max)`, { error: true }); return; }
    busy = true;
    const paths = [];
    const total = files.reduce((n, f) => n + f.size, 0) || 1;
    let done = 0;
    let failure = null;
    try {
      for (const f of files) {
        const label = files.length > 1 ? `${paths.length + 1}/${files.length}` : (f.name || 'image');
        say(`uploading ${label}…`, { sticky: true });
        const r = await send(f, U.uploadName(f), (loaded) => {
          say(`uploading ${label} · ${Math.min(100, Math.round(((done + loaded) / total) * 100))}%`, { sticky: true });
        });
        paths.push(r.path);
        done += f.size;
      }
    } catch (e) {
      failure = e;
    } finally {
      busy = false;
    }
    // Whatever was saved is inserted, even when a later file failed.
    if (paths.length) {
      cw.term.paste(U.joinPaths(paths));
      cw.focus();
    }
    if (failure) say(`upload failed: ${failure.message}${paths.length ? ` (${paths.length} inserted)` : ''}`, { error: true });
    else say(paths.length === 1 ? 'path inserted' : `${paths.length} paths inserted`);
  }

  // ---------- drag and drop (anywhere on the page) ----------
  const hasFiles = (dt) => !!dt && Array.prototype.includes.call(dt.types || [], 'Files');
  let zoneTimer = null;
  function showZone() {
    if (zone) zone.hidden = false;
    clearTimeout(zoneTimer);
    zoneTimer = setTimeout(hideZone, ZONE_LINGER_MS);
  }
  function hideZone() {
    clearTimeout(zoneTimer);
    if (zone) zone.hidden = true;
  }
  // Every file drag is cancelled here, so a drop that misses never makes the browser open the file
  // (which would navigate away from the session).
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      showZone();
    });
  }
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    hideZone();
    upload([...e.dataTransfer.files]);
  });

  // ---------- Ctrl+V of an image (or a copied file) into the terminal ----------
  // Capture on window runs before xterm's own paste listener on its textarea.
  window.addEventListener('paste', (e) => {
    if (!cw.term.textarea || e.target !== cw.term.textarea) return;
    const cd = e.clipboardData;
    const files = cd && cd.files ? [...cd.files] : [];
    if (!files.length) return;
    if ((cd.getData('text/plain') || '').trim()) return; // text wins: xterm pastes it as usual
    e.preventDefault();
    e.stopImmediatePropagation();
    upload(files);
  }, true);

  cw.drop = { upload, get busy() { return busy; } };
})();
