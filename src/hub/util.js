// Small shared helpers for hub modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows a rename onto a file briefly held open (antivirus, indexer) fails with EPERM/EBUSY.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(20 * (attempt + 1));
    }
  }
}

/** Writes data to a sibling temp file, then renames it over `file`. Leaves no temp file behind. */
export function writeFileAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function writeJsonAtomic(file, obj, opts) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', opts);
}

/** Basename of a Windows or POSIX path; ignores trailing separators. '' for non-strings. */
export function cwdBasename(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  return path.win32.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
}
