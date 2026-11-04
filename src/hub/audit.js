// Audit trail: one tab-separated line per action:
//   <ISO time> \t <token name> \t <tailscale user|-> \t <action> \t <session id|-> \t <cwd basename|->
import fs from 'node:fs';
import path from 'node:path';
import { cwdBasename } from './util.js';

const field = (v) => {
  const s = v === undefined || v === null || v === '' ? '-' : String(v).replace(/[\t\r\n]+/g, ' ');
  return s === '' ? '-' : s;
};

/** @param {string} filePath @param {{log?:{warn:Function}}} [opts] */
export function createAudit(filePath, { log } = {}) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* reported on write */ }
  return {
    record({ name, tsUser, action, sessionId, cwd } = {}) {
      const line = [
        new Date().toISOString(),
        field(name),
        field(tsUser),
        field(action),
        field(sessionId),
        field(cwdBasename(cwd)),
      ].join('\t') + '\n';
      try {
        fs.appendFileSync(filePath, line);
      } catch (e) {
        log?.warn?.(`audit write failed: ${e.message}`);
      }
    },
  };
}
