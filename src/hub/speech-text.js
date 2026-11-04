// Talk mode: Claude's markdown reply -> plain text for a speech synthesizer.
//   speechText(markdown, {maxChars})  strips markdown, replaces code blocks and tables with a short
//                                     spoken notice, caps the length at a sentence end
//   splitSpeech(text, {firstChars, maxChars})  short parts, so the first sound starts after one
//                                     short synthesis and the rest is made while it plays
// Pure functions; nothing here is logged or stored.

export const CODE_OMITTED = 'Code block omitted.';
export const TABLE_OMITTED = 'Table omitted.';
export const REST_ON_SCREEN = 'The rest is on screen.';
export const DEFAULT_MAX_CHARS = 600;
export const INLINE_CODE_MAX = 40; // longer inline code is not read out

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const LIST_RE = /^\s*(?:[-+*]|\d+[.)])\s+/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const END_PUNCT_RE = /[.!?:;…]["')\]]?$/;
const PICTO_RE = /[\p{Extended_Pictographic}‍️⃣]/gu;
const DECOR_RE = /[←-⇿─-╿▀-▟■-◿☀-➿]/gu; // arrows left over, box drawing, shapes, dingbats

/** Markdown lines -> speakable paragraph lines, with code blocks and tables replaced by notices. */
function lines(md) {
  const out = [];
  let fence = null; // closing fence prefix while inside a code block
  let inTable = false;
  let codeBlocks = 0;
  for (const raw of md.split(/\r\n|\r|\n/)) {
    if (fence) {
      const m = FENCE_RE.exec(raw);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && raw.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    const open = FENCE_RE.exec(raw);
    if (open) {
      fence = open[1];
      codeBlocks++;
      inTable = false;
      out.push(CODE_OMITTED);
      continue;
    }
    if (TABLE_ROW_RE.test(raw)) {
      if (!inTable) { inTable = true; out.push(TABLE_OMITTED); }
      continue;
    }
    inTable = false;
    out.push(raw);
  }
  return { lines: out, codeBlocks };
}

function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt.trim() ? `${alt.trim()}. ` : ''))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]{1,200}>/g, '') // html tags and autolinks
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, (_, c) => (c.length > INLINE_CODE_MAX ? 'code' : c))
    .replace(/`/g, '')
    .replace(/\bhttps?:\/\/[^\s)>\]]+/gi, 'link')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s*→\s*/g, ' to ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(PICTO_RE, '')
    .replace(DECOR_RE, '');
}

/** One markdown line -> its spoken text (empty when nothing is left). */
function line(raw) {
  if (RULE_RE.test(raw)) return '';
  let s = raw;
  let pause = false;
  if (HEADING_RE.test(s)) { s = s.replace(HEADING_RE, ''); pause = true; }
  else if (LIST_RE.test(s)) { s = s.replace(LIST_RE, ''); pause = true; }
  s = s.replace(/^\s{0,3}>+\s?/, '');
  s = inline(s).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (pause && !END_PUNCT_RE.test(s)) s += '.';
  return s;
}

/** Cuts `s` to at most `max` chars: at the last sentence end inside the cap, else the last space. */
function cut(s, max) {
  const head = s.slice(0, max + 1); // one extra char: a boundary exactly at max counts
  let at = -1;
  const re = /[.!?…]["')\]]?(?=\s|$)/g;
  let m;
  while ((m = re.exec(head)) !== null) {
    const end = m.index + m[0].length;
    if (end <= max) at = end;
  }
  if (at > 0) return s.slice(0, at).trim();
  const sp = head.lastIndexOf(' ', max);
  return (sp > 0 ? s.slice(0, sp) : s.slice(0, max)).replace(/[,;:\s]+$/, '').trim();
}

/**
 * @param {unknown} markdown Claude's reply
 * @param {{maxChars?: number}} [o] maxChars <= 0 or invalid: DEFAULT_MAX_CHARS
 * @returns {{text: string, truncated: boolean, codeBlocks: number}}
 */
export function speechText(markdown, { maxChars } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { text: '', truncated: false, codeBlocks: 0 };
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const { lines: ls, codeBlocks } = lines(markdown);
  const text = ls.map(line).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= cap) return { text, truncated: false, codeBlocks };
  const head = cut(text, cap);
  return { text: head ? `${head} ${REST_ON_SCREEN}` : REST_ON_SCREEN, truncated: true, codeBlocks };
}

/** Splits at commas, then spaces, into pieces of at most `max` chars. */
function breakLong(sentence, max) {
  const pieces = [];
  let cur = '';
  const push = (w) => {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ` ${w}`;
    else { pieces.push(cur); cur = w; }
  };
  for (const clause of sentence.split(/(?<=,)\s+/)) {
    if (clause.length <= max) { push(clause); continue; }
    for (const word of clause.split(/\s+/)) {
      if (word.length <= max) push(word);
      else for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max)); // one huge token
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * @param {string} text from speechText
 * @param {{firstChars?: number, maxChars?: number}} [o] size of the first part (default 120) and of
 *   the others (default 220)
 * @returns {string[]}
 */
export function splitSpeech(text, { firstChars = 120, maxChars = 220 } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const sentences = text.trim().split(/(?<=[.!?…]["')\]]?)\s+/).flatMap((s) => {
    const limit = Math.min(firstChars, maxChars);
    return s.length > limit ? breakLong(s, limit) : [s];
  });
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    const limit = parts.length === 0 ? firstChars : maxChars;
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= limit) cur += ` ${s}`;
    else { parts.push(cur); cur = s; }
  }
  if (cur) parts.push(cur);
  return parts;
}
