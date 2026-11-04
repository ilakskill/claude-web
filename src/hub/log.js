// Append-only line logger with single-file rotation (<file> -> <file>.1, overwritten).
// Line format: `<ISO time> <LEVEL> <message>`. Logging never throws.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

export function createLogger(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* reported on write */ }

  function rotateIfNeeded(incoming) {
    let size;
    try { size = fs.statSync(filePath).size; } catch { return; }
    if (size === 0 || size + incoming <= maxBytes) return;
    try {
      fs.renameSync(filePath, filePath + '.1');
    } catch {
      try { fs.rmSync(filePath + '.1', { force: true }); fs.renameSync(filePath, filePath + '.1'); } catch {
        try { fs.truncateSync(filePath, 0); } catch { /* give up on rotation */ }
      }
    }
  }

  function write(level, args) {
    try {
      const msg = util.format(...args).replace(/\r?\n/g, ' | ');
      const line = `${new Date().toISOString()} ${level} ${msg}\n`;
      rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(filePath, line);
    } catch { /* logging must never crash the hub */ }
  }

  return {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };
}
