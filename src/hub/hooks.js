// Pure mapping of Claude Code hook payloads to hub events, and ntfy message formatting.
// Payload field names verified in the original hook-payload spike: hook_event_name, session_id, cwd,
// message, notification_type ('permission_prompt' | 'idle_prompt' | 'elicitation_dialog' |
// 'agent_needs_input' | ...), stop_hook_active. PreToolUse carries tool_name and tool_input
// (AskUserQuestion: {questions:[{question, header, options, multiSelect}]}).
// Stop also carries last_assistant_message (transcript text). It is read only when the caller
// passes { preview: true } (config notifyPreview, off by default): then a markdown-stripped,
// one-line copy becomes the "finished" message. Without the flag it is never touched.
import { cwdBasename } from './util.js';

const str = (v) => (typeof v === 'string' ? v : null);

/**
 * Claude's last message as one line of plain text for a lock-screen preview, or null when there
 * is nothing usable. Strips code-fence lines (the code stays), `[text](url)` to text, `#` heading
 * markers, list markers, `*` emphasis and backticks; then control characters and whitespace (clean).
 */
function previewText(v) {
  if (typeof v !== 'string') return null;
  const t = clean(v
    .replace(/^\s*`{3,}[^\n]*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*`]/g, ''));
  return t || null;
}

// Notification types that mean Claude is blocked on the user. A missing type counts too
// (older Claude Code versions sent permission prompts without one).
const NEEDS_INPUT_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

/** First question of an AskUserQuestion tool_input, or null. */
function firstQuestion(toolInput) {
  const q = toolInput && typeof toolInput === 'object' && Array.isArray(toolInput.questions) ? toolInput.questions[0] : null;
  return q && typeof q === 'object' ? str(q.question) : null;
}

/**
 * @param {object} payload Claude hook stdin JSON plus optional cwSessionId (from CW_SESSION_ID).
 * @param {{preview?: boolean}} [o] preview === true (config notifyPreview): a Stop event's
 *   last_assistant_message, cleaned by previewText, becomes the message. Any other value: never read.
 * @returns {{kind:'needs-input'|'finished'|'idle'|'ignore', claudeSessionId:string|null,
 *            cwd:string|null, cwSessionId:string|null, message:string|null}}
 */
export function mapHookEvent(payload, { preview = false, harness = 'claude' } = {}) {
  const p = payload !== null && typeof payload === 'object' ? payload : {};
  let kind = 'ignore';
  let message = null;
  if (harness === 'gemini') {
    // Gemini CLI hooks (Claude-compatible payload): Notification = it needs the user (tool
    // permission); AfterAgent = the agent finished its turn. Other events are never installed.
    if (p.hook_event_name === 'Notification') {
      kind = 'needs-input';
      message = str(p.message);
    } else if (p.hook_event_name === 'AfterAgent' && !p.stop_hook_active) {
      kind = 'finished';
    }
  } else if (harness === 'codex') {
    // Codex: the Stop hook fires when a turn ends.
    if (p.hook_event_name === 'Stop' && !p.stop_hook_active) kind = 'finished';
  } else if (p.hook_event_name === 'Notification') {
    const type = p.notification_type;
    if (type === undefined || type === null || NEEDS_INPUT_TYPES.has(type)) kind = 'needs-input';
    else if (type === 'idle_prompt') kind = 'idle';
    if (kind !== 'ignore') message = str(p.message);
  } else if (p.hook_event_name === 'Stop' && !p.stop_hook_active) {
    kind = 'finished';
    if (preview === true) message = previewText(p.last_assistant_message);
  } else if (p.hook_event_name === 'PreToolUse' && p.tool_name === 'AskUserQuestion') {
    // Claude is about to ask a clarifying question and wait for the answer. The hook is only
    // observed (cw hook prints nothing and exits 0), so the tool itself is never blocked.
    kind = 'needs-input';
    message = firstQuestion(p.tool_input);
  }
  return {
    kind,
    claudeSessionId: str(p.session_id),
    cwd: str(p.cwd),
    cwSessionId: str(p.cwSessionId),
    message,
  };
}

/**
 * The harness a hook payload came from when no cw session matched it: Gemini's own event names
 * give it away; everything else is Claude (a Codex Stop looks exactly like a Claude Stop).
 */
export function inferHookHarness(payload) {
  const ev = payload && typeof payload === 'object' ? payload.hook_event_name : null;
  return ev === 'AfterAgent' || ev === 'BeforeAgent' ? 'gemini' : 'claude';
}

const MAX_MESSAGE = 140;
const MAX_TITLE = 140;

// Lock-screen wording: the title says who and what, the body is Claude's own message or the kind.
// `channel` picks the ntfy topic (notify.js): 'input' -> ntfyTopic, 'done' -> ntfyTopicDone. The
// ntfy Android app gives each topic its own notification channel, hence its own sound. Idle goes
// to 'input': idle_prompt means Claude has stopped and is waiting for the user (typically after a
// plain-text question), so it must sound like "needs input", not like "finished".
const WORDING = {
  'needs-input': { text: 'needs input', priority: 'high', tags: ['warning'], channel: 'input' },
  finished: { text: 'finished', priority: 'default', tags: ['white_check_mark'], channel: 'done' },
  idle: { text: 'idle', priority: 'low', tags: ['hourglass'], channel: 'input' },
  // A terminal bell / OSC 9 notification from any harness (session.js onNotify).
  attention: { text: 'needs attention', priority: 'high', tags: ['bell'], channel: 'input' },
};
const UNMATCHED_NAME = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };

/** Removes control characters / escape sequences and collapses whitespace. */
function clean(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Titles: `cw #<index> needs input · <basename>` for a cw session; `Claude needs input · <basename>`
 * when no cw session matched (e.g. the Claude desktop app). Likewise `finished` (and `idle`).
 * @returns {{title:string, message:string, priority:string, tags:string[], channel:'input'|'done'}|null}
 *   null for 'ignore'/unknown kinds. Content is limited to: session index, cwd basename, the kind
 *   wording, and Claude's short message. Transcript text reaches `message` only as the preview
 *   that mapHookEvent produces with notifyPreview on; it is capped at MAX_MESSAGE with an ellipsis.
 */
export function formatNotification(kind, { index, cwd, message, harness } = {}) {
  const w = WORDING[kind];
  if (!w) return null;
  const base = clean(cwdBasename(cwd));
  let title = Number.isInteger(index) ? `cw #${index} ${w.text}` : `${UNMATCHED_NAME[harness] ?? 'Claude'} ${w.text}`;
  if (base) title += ` · ${base}`;
  const body = (typeof message === 'string' && clean(message)) || w.text;
  return { title: cap(title, MAX_TITLE), message: cap(body, MAX_MESSAGE), priority: w.priority, tags: [...w.tags], channel: w.channel };
}
