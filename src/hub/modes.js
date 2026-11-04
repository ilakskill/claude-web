// Tracks DEC private modes (CSI ? Pn ; ... h|l) seen in PTY output so a late-attaching client
// can be given the modes that @xterm/addon-serialize omits (spike B: ?1006h and ?25l).
// A byte-level state machine carries partial sequences across chunks without buffering text.

const ESC = 0x1b;
const LBRACKET = 0x5b; // [
const QMARK = 0x3f; // ?
const SEMI = 0x3b; // ;
const H = 0x68; // h
const L = 0x6c; // l
const LOWER_C = 0x63; // c (RIS when directly after ESC)

// Alternate-screen modes are handled by serialize() itself; 1048 is save/restore cursor.
const IGNORED = new Set([47, 1047, 1048, 1049]);
const MAX_PARAM_LEN = 64;

const GROUND = 0;
const AFTER_ESC = 1;
const AFTER_CSI = 2;
const PRIVATE = 3;

export function createModeTracker() {
  // Map insertion order == order of last change; a re-set mode moves to the end. Replaying in
  // this order reproduces the final state even for mutually exclusive modes (1000/1002/1003).
  const modes = new Map();
  let state = GROUND;
  let params = '';

  function apply(set) {
    for (const part of params.split(';')) {
      if (part === '') continue;
      const n = Number(part);
      if (!Number.isInteger(n) || IGNORED.has(n)) continue;
      modes.delete(n);
      modes.set(n, set);
    }
  }

  function step(c) {
    switch (state) {
      case GROUND:
        if (c === ESC) state = AFTER_ESC;
        return;
      case AFTER_ESC:
        if (c === LBRACKET) state = AFTER_CSI;
        else if (c === LOWER_C) { modes.clear(); state = GROUND; }
        else if (c !== ESC) state = GROUND;
        return;
      case AFTER_CSI:
        if (c === QMARK) { state = PRIVATE; params = ''; }
        else state = c === ESC ? AFTER_ESC : GROUND;
        return;
      case PRIVATE:
        if ((c >= 0x30 && c <= 0x39) || c === SEMI) {
          params += String.fromCharCode(c);
          if (params.length > MAX_PARAM_LEN) { state = GROUND; params = ''; }
        } else if (c === H || c === L) {
          apply(c === H);
          state = GROUND;
          params = '';
        } else {
          state = c === ESC ? AFTER_ESC : GROUND;
          params = '';
        }
        return;
    }
  }

  return {
    /** @param {Buffer|Uint8Array|string} bytes */
    feed(bytes) {
      if (bytes == null) return;
      if (typeof bytes === 'string') {
        for (let i = 0; i < bytes.length; i++) step(bytes.charCodeAt(i));
      } else {
        for (let i = 0; i < bytes.length; i++) step(bytes[i]);
      }
    },
    /** @returns {string} ESC[?Nh / ESC[?Nl for every mode seen, in order of last change. */
    snapshot() {
      let out = '';
      for (const [n, set] of modes) out += `\x1b[?${n}${set ? 'h' : 'l'}`;
      return out;
    },
  };
}
