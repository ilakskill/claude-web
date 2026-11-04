// Talk mode: the final assistant message of the latest turn of a Claude Code transcript
// (<claudeHome>/projects/<encoded cwd>/<claude session id>.jsonl). Used when a Stop hook payload
// carries no last_assistant_message. Only the tail of the file is read (transcripts reach many MB).
//
// Claude Code writes one JSONL record per content block (thinking, text, tool_use), all sharing the
// message id. The answer is the last text of the turn that no tool call follows: text before a tool
// call is commentary ("Let me look at the test first."), and a turn that ends on a tool call
// (interrupted) has no answer.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { encodeProjectDir, promptText } from './transcripts.js';

export const TAIL_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * @param {string|null} jsonl transcript text (a torn first or last line is ignored)
 * @returns {string|null} the final answer of the latest turn, or null
 */
export function finalAssistantText(jsonl) {
  if (typeof jsonl !== 'string' || !jsonl) return null;
  let last = null; // {id, texts: string[]}
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    const o = parse(t);
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'user') {
      if (promptText(o) !== null) last = null; // a typed prompt: a new turn
      continue;
    }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    const id = typeof o.message.id === 'string' ? o.message.id : null;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' || b.type === 'server_tool_use') { last = null; continue; }
      if (b.type !== 'text' || typeof b.text !== 'string' || !b.text.trim()) continue;
      if (last && id !== null && last.id === id) last.texts.push(b.text.trim());
      else last = { id, texts: [b.text.trim()] };
    }
  }
  return last ? last.texts.join('\n\n') : null;
}

async function exists(f) {
  try { return (await fsp.stat(f)).isFile(); } catch { return false; }
}

/** The transcript file: the cwd's project dir first, else any project dir; null when not found. */
async function locate(claudeHome, cwd, id) {
  const projects = path.join(claudeHome, 'projects');
  const name = `${id}.jsonl`;
  if (typeof cwd === 'string' && cwd) {
    const f = path.join(projects, encodeProjectDir(cwd), name);
    if (await exists(f)) return f;
  }
  let dirs = [];
  try { dirs = (await fsp.readdir(projects, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projects, d, name);
    if (await exists(f)) return f;
  }
  return null;
}

/**
 * @param {{claudeHome: string, cwd?: string, claudeSessionId: string, tailBytes?: number}} o
 * @returns {Promise<string|null>} never rejects
 */
export async function readFinalAssistantText({ claudeHome, cwd, claudeSessionId, tailBytes = TAIL_BYTES } = {}) {
  try {
    if (!claudeHome || typeof claudeSessionId !== 'string' || !ID_RE.test(claudeSessionId)) return null;
    const file = await locate(claudeHome, cwd, claudeSessionId);
    if (!file) return null;
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      let text = buf.subarray(0, got).toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); } // the first line is cut
      return finalAssistantText(text);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
