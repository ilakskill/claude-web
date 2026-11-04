// ntfy push notifications. send() never throws; it resolves true on a 2xx, false otherwise.
// The topics act as shared secrets, so they are never written to the log.
// Two topics: `topic` for "needs input" (and everything else), `topicDone` for "finished". The
// ntfy Android app creates one notification channel per topic, each with its own sound.

const noopLog = { info() {}, warn() {}, error() {} };

/** Header values must be single-line; non-ASCII is RFC 2047 encoded (ntfy decodes it). */
function headerValue(v) {
  const s = String(v).replace(/[\r\n]+/g, ' ');
  return /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s;
}

/**
 * @param {object} o
 * @param {string} o.server ntfy base URL
 * @param {string|null} o.topic topic for channel 'input' (and the default for any other channel)
 * @param {string|null} [o.topicDone] topic for channel 'done'; falls back to `topic` when unset
 */
export function createNotifier({ server, topic, topicDone, fetchImpl = globalThis.fetch, log, timeoutMs = 3000 } = {}) {
  const lg = log || noopLog;
  let warnedNoTopic = false;

  async function attempt(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    try { await res?.body?.cancel?.(); } catch { /* body not needed */ }
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
  }

  return {
    /**
     * @param {object} n
     * @param {'input'|'done'} [n.channel] which topic to post to (default 'input')
     * @returns {Promise<boolean>}
     */
    async send({ title, message, click, priority = 'default', tags, channel } = {}) {
      try {
        if (!topic) {
          if (!warnedNoTopic) {
            warnedNoTopic = true;
            lg.warn('ntfy topic is not configured; notifications are disabled');
          }
          return false;
        }
        const target = channel === 'done' && topicDone ? topicDone : topic;
        const url = `${String(server).replace(/\/+$/, '')}/${encodeURIComponent(target)}`;
        const headers = {};
        if (title != null) headers.Title = headerValue(title);
        if (click) headers.Click = headerValue(click);
        headers.Priority = headerValue(priority);
        if (tags != null && (!Array.isArray(tags) || tags.length > 0)) {
          headers.Tags = headerValue(Array.isArray(tags) ? tags.join(',') : tags);
        }
        const init = { method: 'POST', headers, body: message == null ? '' : String(message) };
        for (let i = 1; i <= 2; i++) {
          try {
            await attempt(url, init);
            return true;
          } catch (e) {
            lg.warn(`ntfy send failed (attempt ${i}/2): ${e?.message ?? e}`);
          }
        }
        return false;
      } catch (e) {
        try { lg.warn(`ntfy send error: ${e?.message ?? e}`); } catch { /* never throw */ }
        return false;
      }
    },
  };
}
