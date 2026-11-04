// Files dropped or pasted onto a session page (POST /api/sessions/<id>/upload, web/drop.js). The
// raw request body is streamed to <dir>/<sessionId>/<unique>-<sanitized name>, outside any repo
// (dir defaults to os.tmpdir()/cw-uploads), so Claude Code / Codex can read the file by path. The
// cap is checked against Content-Length up front and against the bytes actually received while
// streaming; a partial file is always removed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import '../shared/uploads.js';

const { UPLOAD_MAX_BYTES, sanitizeUploadName } = globalThis.cwUploads;
export { UPLOAD_MAX_BYTES, sanitizeUploadName };

export const defaultUploadDir = () => path.join(os.tmpdir(), 'cw-uploads');

export class UploadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const mb = (n) => `${Math.round(n / (1024 * 1024))} MB`;

/**
 * Streams `req` into a new file. Resolves {path, name, bytes}; rejects with an UploadError (413 too
 * large, 400 empty body) or the stream's own error. On a 413 the caller should answer with
 * `Connection: close`: the rest of the body is drained, not read into memory.
 * @param {import('node:http').IncomingMessage} req
 * @param {{dir?: string, sessionId: string, name: unknown, maxBytes?: number}} o
 */
export async function saveUpload(req, { dir = defaultUploadDir(), sessionId, name, maxBytes = UPLOAD_MAX_BYTES }) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume(); // discard, so the 413 reaches the client instead of a reset
    throw new UploadError(413, `file too large (${mb(maxBytes)} max)`);
  }
  const safe = sanitizeUploadName(name);
  const root = path.resolve(dir);
  const sessionDir = path.join(root, sessionId);
  const file = path.join(sessionDir, `${crypto.randomBytes(4).toString('hex')}-${safe}`);
  // Belt and braces: the sanitized name has no separators, so this can only fail on a bad sessionId.
  if (path.dirname(file) !== sessionDir || !sessionDir.startsWith(root + path.sep)) throw new UploadError(400, 'bad file name');
  await fsp.mkdir(sessionDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx' });
    let bytes = 0;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      req.unpipe(out);
      req.resume(); // drain the rest so the error response can be read
      out.destroy();
      fsp.rm(file, { force: true }).catch(() => {}).finally(() => reject(err));
    };
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) fail(new UploadError(413, `file too large (${mb(maxBytes)} max)`));
    });
    req.on('aborted', () => fail(new UploadError(400, 'upload aborted')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (bytes === 0) { fail(new UploadError(400, 'empty file')); return; }
      resolve({ path: file, name: safe, bytes });
    });
    req.pipe(out);
  });
}
