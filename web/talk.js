// cw Talk mode: hold a button to talk to the session, hear its replies spoken back. Push-to-talk,
// not hands-free: nothing listens until the button is held.
//
// Speaking: with Talk on, the page polls GET /api/sessions/<id>/speech (every POLL_MS while the
// page is visible; every POLL_FAST_MS for a few minutes after something was sent, while a reply is
// expected). A turn newer than what the page has is played part by part: each part is a
// short WAV that the hub synthesizes with Kokoro (Piper as fallback; both on the PC, nothing leaves
// it), fetched with fetch() and played through one AudioContext. That context is created and resumed
// inside the tap on the Talk button, which is what unlocks audio on phones. The next part is fetched
// while the current one plays. With voice.ttsEngine "browser" the poll carries the text and the page
// says it with speechSynthesis instead.
//
// Talking: the hold-to-talk button drives the dictation engine (voice.js): the browser's own
// SpeechRecognition when the page can use it (live words, no model to wait for), else the hub's
// whisper. When the utterance has been transcribed it is typed into the session and Enter is
// pressed (compose.js submitText). The text box under the bar does the same for typed text, so a
// phone keyboard's dictation key (or Win+H) works where the microphone cannot. Pressing the
// button stops playback first. The choice (on/off) is kept per session in localStorage
// (cw.talk.<id>); "Listen" (browser or hub) and "Voice" (hub or browser) are kept for all
// sessions (cw.talk.listen, cw.talk.speak). Only Claude and Codex sessions get the toggle.
//
// window.cwTalk holds the pure logic (urls, what a poll answer means), unit-tested from Node.
(function (root) {
  'use strict';

  // ---------- pure helpers ----------

  const storageKey = (id) => `cw.talk.${id}`;
  /** browserVoice: this page speaks with the browser's own voice, so the hub sends the text and makes no audio. */
  const pollUrl = (id, since, { browserVoice = false } = {}) => {
    const q = [];
    if (since) q.push(`since=${since}`);
    if (browserVoice) q.push('voice=browser');
    return `/api/sessions/${id}/speech${q.length ? `?${q.join('&')}` : ''}`;
  };
  const partUrl = (id, seq, part) => `/api/sessions/${id}/speech/${seq}/${part}.wav`;

  /**
   * What a poll answer means for a page that has seen turns up to state.seq.
   * state.seq === null: the first answer after Talk was turned on is only a baseline, so a reply
   * that was already there is not read out. @returns {{seq: number|null, play: object|null}}
   */
  function nextAction(state, resp) {
    if (!resp || typeof resp.seq !== 'number') return { seq: state.seq, play: null };
    if (state.seq === null) return { seq: resp.seq, play: null };
    if (resp.turn && typeof resp.turn.seq === 'number' && resp.turn.seq > state.seq) return { seq: resp.turn.seq, play: resp.turn };
    return { seq: state.seq, play: null };
  }

  /** The utterance as shown in the status line: one line, at most `max` characters. */
  function clip(text, max = 60) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
  }

  root.cwTalk = { storageKey, pollUrl, partUrl, nextAction, clip };

  // ---------- page ----------
  const doc = root.document;
  const cw = root.cw;
  if (!doc || !cw || !cw.sessionId) return;
  const $ = (id) => doc.getElementById(id);
  const toggleBtn = $('talk-toggle');
  const bar = $('talk');
  const stateEl = $('talk-state');
  const stopBtn = $('talk-stop');
  const micBtn = $('talk-mic');
  if (!toggleBtn || !bar || !stateEl || !stopBtn || !micBtn) return;
  const textEl = $('talk-text');
  const sendBtn = $('talk-send');
  const listenBtn = $('talk-listen');
  const speakBtn = $('talk-speak');

  const POLL_MS = 1500;
  const POLL_FAST_MS = 700;
  const FAST_FOR_MS = 5 * 60_000; // after a send, a reply is expected: poll faster for this long
  const POLL_ERROR_MS = 5000;
  const SENT_SHOW_MS = 5000;
  const PENDING_MAX_MS = 200000; // a release whose transcript never came back stops counting after this (the first utterance can wait for the model to load, up to 180 s)
  const H = root.cwHarnesses;
  const store = {
    get(k) { try { return root.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };

  let info = null; // GET /api/voice -> talk block (null until known)
  let supported = false; // a Claude or Codex session
  let on = false;
  let baseline = null; // newest turn seq seen (null: next answer is a baseline)
  let timer = null;
  let inflight = false;
  let gen = 0; // bumped to abandon the reply being played
  let ctx = null;
  let sources = [];
  let preparing = false;
  let speaking = false;
  let held = false; // the hold button is down
  let recording = false;
  let voiceStatus = '';
  let interimText = ''; // words the browser recognizer has heard so far in the utterance being held
  let fastUntil = 0;
  let listenPref = store.get('cw.talk.listen') === 'hub' ? 'hub' : 'auto'; // 'auto': the browser listens when it can
  let speakPref = store.get('cw.talk.speak') === 'browser' ? 'browser' : 'hub'; // who makes the voice
  let errorText = '';
  let errorUntil = 0;
  let sentText = '';
  let sentUntil = 0;
  let renderTimer = null;
  const pending = []; // release times of utterances that will come back as a final text
  let wake = null;

  // ---------- status line ----------
  function render() {
    clearTimeout(renderTimer);
    const now = Date.now();
    let text;
    let isError = false;
    if (errorText && now < errorUntil) { text = errorText; isError = true; }
    else if (recording) text = interimText ? `Listening… “${clip(interimText, 80)}”` : 'Listening… release to send';
    else if (voiceStatus) text = voiceStatus;
    else if (sentText && now < sentUntil) text = `Sent: “${sentText}”`;
    else if (preparing) text = 'Preparing speech…';
    else if (speaking) text = 'Speaking…';
    else text = 'Talk on. Replies are read aloud.';
    stateEl.textContent = text;
    stateEl.classList.toggle('error', isError);
    stopBtn.hidden = !(preparing || speaking);
    micBtn.classList.toggle('rec', recording);
    micBtn.setAttribute('aria-pressed', String(recording));
    toggleBtn.classList.toggle('speaking', speaking || preparing);
    renderOptions();
    const wait = Math.min(errorText && now < errorUntil ? errorUntil - now : Infinity, sentText && now < sentUntil ? sentUntil - now : Infinity);
    if (wait !== Infinity) renderTimer = setTimeout(render, wait + 20);
  }
  function flashError(text) {
    errorText = text;
    errorUntil = Date.now() + 6000;
    render();
  }

  // ---------- the two switches under the bar ----------
  const hasSpeechApi = () => !!(root.SpeechRecognition || root.webkitSpeechRecognition) && !!root.isSecureContext;
  const hubVoiceOnly = () => !!info && info.engine === 'browser'; // the hub is configured so that the page always speaks
  const browserVoice = () => hubVoiceOnly() || (speakPref === 'browser' && !!root.speechSynthesis && !!root.SpeechSynthesisUtterance);
  function renderOptions() {
    // Listen: only when there is a choice (the hub allows the browser to listen, and this browser can).
    const canChoose = !!(info && info.browserStt) && hasSpeechApi() && !!cw.voice && !(cw.voice.state.engine === 'browser');
    const failed = !!cw.voice && cw.voice.browserFailed;
    let shown = false;
    if (listenBtn) {
      listenBtn.hidden = !canChoose;
      if (canChoose) {
        const useBrowser = !failed && listenPref === 'auto';
        listenBtn.textContent = `Listen: ${useBrowser ? 'browser' : 'hub'}`;
        listenBtn.setAttribute('aria-pressed', String(useBrowser));
        listenBtn.disabled = failed;
        listenBtn.title = failed
          ? "The browser's speech service failed; the hub's whisper listens until the page is reloaded"
          : useBrowser
            ? "Listening with the browser's speech recognition: live words, but Chrome sends the audio to Google and Edge to Microsoft. Tap to use the hub's whisper (audio stays on your PC)."
            : "Listening with the hub's whisper (audio stays on your PC; the first words take a moment). Tap to use the browser's speech recognition.";
        shown = true;
      }
    }
    if (speakBtn) {
      const can = !!root.speechSynthesis && !!root.SpeechSynthesisUtterance && !hubVoiceOnly();
      speakBtn.hidden = !can;
      if (can) {
        const b = speakPref === 'browser';
        speakBtn.textContent = `Voice: ${b ? 'browser' : 'hub'}`;
        speakBtn.setAttribute('aria-pressed', String(b));
        speakBtn.title = b ? "The browser's own voice speaks replies at once. Tap for the hub's Kokoro voice." : "The hub's Kokoro voice speaks replies. Tap for the browser's own voice (instant, plainer).";
        shown = true;
      }
    }
    const opts = $('talk-opts');
    if (opts && opts.hidden === shown) { opts.hidden = !shown; cw.relayout(); }
  }

  // ---------- audio ----------
  function unlockAudio() {
    try {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (AC) {
        if (!ctx) ctx = new AC();
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        // A silent one-sample buffer played inside the tap: what iOS needs to allow later playback.
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
      }
      if (browserVoice() && root.speechSynthesis && root.SpeechSynthesisUtterance) {
        root.speechSynthesis.speak(new root.SpeechSynthesisUtterance(''));
      }
    } catch { /* no audio: the first reply reports it */ }
  }
  let unlockArmed = false;
  /** After a reload with Talk remembered as on there was no tap yet: the first touch anywhere unlocks audio. */
  function armUnlock() {
    if (unlockArmed || (ctx && ctx.state === 'running')) return;
    unlockArmed = true;
    const once = () => {
      unlockArmed = false;
      doc.removeEventListener('pointerdown', once, true);
      doc.removeEventListener('keydown', once, true);
      if (on) unlockAudio();
    };
    doc.addEventListener('pointerdown', once, true);
    doc.addEventListener('keydown', once, true);
  }

  function stopPlayback() {
    gen++;
    for (const s of sources.splice(0)) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch { /* none */ }
    preparing = false;
    speaking = false;
    render();
  }

  async function fetchBuffer(seq, part, my) {
    const r = await root.fetch(partUrl(cw.sessionId, seq, part), { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error || ''; } catch { /* not JSON */ }
      throw new Error(msg || `speech failed (${r.status})`);
    }
    const data = await r.arrayBuffer();
    if (my !== gen) return null;
    return new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)); // callback form: older Safari has no promise form
  }

  function playBuffer(buf, my) {
    return new Promise((resolve) => {
      if (my !== gen) { resolve(); return; }
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      sources.push(s);
      s.onended = () => { const i = sources.indexOf(s); if (i >= 0) sources.splice(i, 1); resolve(); };
      s.start(0);
    });
  }

  async function playTurn(turn) {
    stopPlayback();
    const my = gen;
    if (browserVoice()) { speakBrowser(turn, my); return; }
    if (!ctx) unlockAudio();
    if (!ctx) { flashError('this browser cannot play audio'); return; }
    preparing = true;
    render();
    try {
      if (ctx.state !== 'running') {
        await ctx.resume().catch(() => {});
        if (ctx.state !== 'running') { armUnlock(); throw new Error('tap the page once to allow sound'); }
      }
      let next = fetchBuffer(turn.seq, 0, my);
      for (let i = 0; i < turn.parts; i++) {
        const buf = await next;
        if (my !== gen || !buf) return;
        if (i + 1 < turn.parts) { next = fetchBuffer(turn.seq, i + 1, my); next.catch(() => {}); } // synthesized while this part plays
        preparing = false;
        speaking = true;
        render();
        await playBuffer(buf, my);
      }
    } catch (e) {
      if (my === gen) flashError(String((e && e.message) || e).slice(0, 120));
    } finally {
      if (my === gen) { preparing = false; speaking = false; render(); }
    }
  }

  function speakBrowser(turn, my) {
    const synth = root.speechSynthesis;
    if (!synth || !root.SpeechSynthesisUtterance || !Array.isArray(turn.texts)) { flashError('this browser cannot speak'); return; }
    // One utterance per part: a long single utterance is cut off after about 15 s by some desktop voices.
    let left = turn.texts.length;
    if (!left) return;
    speaking = true;
    for (const text of turn.texts) {
      const u = new root.SpeechSynthesisUtterance(text);
      if (info && typeof info.speed === 'number') u.rate = info.speed;
      u.onend = u.onerror = () => { left--; if (my === gen && left <= 0) { speaking = false; render(); } };
      synth.speak(u);
    }
    render();
  }

  // ---------- polling ----------
  async function poll() {
    if (!on || inflight || doc.hidden) return;
    inflight = true;
    let delay = Date.now() < fastUntil ? POLL_FAST_MS : POLL_MS;
    try {
      const r = await root.fetch(pollUrl(cw.sessionId, baseline, { browserVoice: browserVoice() }), { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 404 || r.status === 400) { setOn(false); hideToggle(); return; } // Talk disabled on the hub, or not a Claude/Codex session
      if (!r.ok) throw new Error(String(r.status));
      const a = nextAction({ seq: baseline }, await r.json());
      baseline = a.seq;
      if (a.play && on) playTurn(a.play);
    } catch {
      delay = POLL_ERROR_MS;
    } finally {
      inflight = false;
      if (on) { clearTimeout(timer); timer = setTimeout(poll, delay); }
    }
  }

  // ---------- keeping the screen on while Talk is on ----------
  async function holdWake() {
    try { if (root.navigator.wakeLock && !wake && on && !doc.hidden) wake = await root.navigator.wakeLock.request('screen'); } catch { wake = null; }
  }
  function releaseWake() {
    const w = wake;
    wake = null;
    if (w) w.release().catch(() => {});
  }

  // ---------- on / off ----------
  function setOn(v, { save = true, gesture = false } = {}) {
    v = !!v && supported;
    if (v === on) return;
    on = v;
    if (save) store.set(storageKey(cw.sessionId), on ? '1' : '0');
    toggleBtn.classList.toggle('on', on);
    toggleBtn.setAttribute('aria-pressed', String(on));
    bar.hidden = !on;
    if (on) {
      baseline = null;
      if (gesture) unlockAudio(); else armUnlock();
      holdWake();
      clearTimeout(timer);
      poll();
    } else {
      clearTimeout(timer);
      stopPlayback();
      if (recording || held) { held = false; if (cw.voice) cw.voice.stop(true); }
      pending.length = 0;
      releaseWake();
    }
    render();
    cw.relayout();
  }
  function hideToggle() {
    supported = false;
    toggleBtn.hidden = true;
    bar.hidden = true;
  }
  function updateToggle() {
    const h = H && cw.meta ? (H.getHarness(cw.meta.harness) || H.inferHarness(cw.meta.command)) : null;
    const ok = !!h && (h.id === 'claude' || h.id === 'codex');
    const wasSupported = supported;
    supported = ok && !!(info && info.enabled && info.available);
    toggleBtn.hidden = !supported;
    // A split-view pane has no title bar to turn it off again, so it never starts Talk by itself.
    if (supported && !wasSupported && !cw.embedded && store.get(storageKey(cw.sessionId)) === '1') setOn(true, { save: false });
    if (!supported && on) setOn(false, { save: false });
  }

  toggleBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the compose box focused
  toggleBtn.addEventListener('click', () => setOn(!on, { gesture: true }));
  stopBtn.addEventListener('click', stopPlayback);
  doc.addEventListener('visibilitychange', () => {
    if (!on) return;
    if (doc.hidden) { releaseWake(); return; }
    holdWake();
    poll();
  });

  // ---------- hold to talk ----------
  function press() {
    if (!on || held || !cw.voice) return;
    held = true;
    stopPlayback(); // the user talks over the reply
    cw.voice.start();
  }
  function release(cancel) {
    if (!held) return;
    held = false;
    if (cw.voice && cw.voice.state.recording) {
      if (!cancel) pending.push(Date.now());
      cw.voice.stop(!!cancel);
    }
  }
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  micBtn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    try { micBtn.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    press();
  });
  micBtn.addEventListener('pointerup', () => release(false));
  micBtn.addEventListener('pointercancel', () => release(true));
  micBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); }
  });
  micBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(false); }
  });
  micBtn.addEventListener('blur', () => release(true));
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) release(true); });

  /** Hooks into voice.js: our own status line, and the transcript goes to the session instead of the compose box. */
  function wireVoice() {
    if (!cw.voice || !cw.voice.hooks) return false;
    const hk = cw.voice.hooks;
    hk.status = (text, isError) => {
      if (!on) return;
      if (isError) { flashError(text); voiceStatus = ''; return; }
      voiceStatus = text && !/^listening/i.test(text) ? text : '';
      render();
    };
    hk.recording = (isOn) => {
      recording = isOn;
      interimText = '';
      if (isOn && !held) { cw.voice.stop(true); return; } // released before the microphone was ready
      if (isOn && !on) { return; }
      render();
    };
    hk.interim = (text) => { interimText = text || ''; if (on) render(); };
    hk.autoEnd = () => {
      // The browser's recognizer ended by itself (a pause) while the button was still down: that is
      // the end of the utterance, so what it heard is sent as if the button had been released.
      if (!on || !held) return;
      held = false;
      pending.push(Date.now());
    };
    hk.listenFailed = () => render();
    hk.listenMode = () => (on ? listenPref : null);
    hk.final = (text) => {
      while (pending.length && Date.now() - pending[0] > PENDING_MAX_MS) pending.shift();
      if (!on || !pending.length) return false;
      pending.shift();
      if (!text) { flashError('nothing heard'); return true; }
      sendText(text);
      return true;
    };
    hk.error = () => { pending.shift(); };
    return true;
  }

  /** Types `text` into the session and presses Enter; shows it in the status line; replies are polled for faster for a while. */
  function sendText(text) {
    cw.submitText(text);
    sentText = clip(text);
    sentUntil = Date.now() + SENT_SHOW_MS;
    fastUntil = Date.now() + FAST_FOR_MS;
    if (on) { clearTimeout(timer); if (!inflight) timer = setTimeout(poll, POLL_FAST_MS); }
    render();
  }

  // ---------- the text box (a phone keyboard's dictation key, Win+H, or just typing) ----------
  function sendTyped() {
    if (!textEl) return;
    const t = textEl.value.trim();
    if (!t || !on) return;
    stopPlayback(); // typing over a reply, like talking over it
    sendText(t);
    textEl.value = '';
  }
  if (textEl && sendBtn) {
    sendBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
    sendBtn.addEventListener('click', sendTyped);
    textEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      sendTyped();
    });
  }
  if (listenBtn) {
    listenBtn.addEventListener('mousedown', (e) => e.preventDefault());
    listenBtn.addEventListener('click', () => {
      listenPref = listenPref === 'hub' ? 'auto' : 'hub';
      store.set('cw.talk.listen', listenPref);
      render();
    });
  }
  if (speakBtn) {
    speakBtn.addEventListener('mousedown', (e) => e.preventDefault());
    speakBtn.addEventListener('click', () => {
      speakPref = speakPref === 'browser' ? 'hub' : 'browser';
      store.set('cw.talk.speak', speakPref);
      stopPlayback();
      if (speakPref === 'browser') unlockAudio(); // inside the tap, which is what lets the voice speak later
      render();
    });
  }

  // ---------- boot ----------
  root.fetch('/api/voice', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      info = v && v.talk ? v.talk : null;
      micBtn.hidden = !(v && v.enabled); // dictation off on the hub: Talk still reads replies, nothing to hold
      updateToggle();
      render();
    })
    .catch(() => {});
  cw.onMeta(() => updateToggle());
  wireVoice();

  cw.talk = {
    get on() { return on; },
    get available() { return supported; },
    get state() {
      return {
        on, baseline, preparing, speaking, recording, status: stateEl.textContent, audio: ctx ? ctx.state : 'none',
        listen: cw.voice ? cw.voice.choice : null, // 'browser' | 'whisper': what the next utterance would use
        speak: browserVoice() ? 'browser' : 'hub',
      };
    },
    set(v) { setOn(v, { gesture: true }); },
    stop: stopPlayback,
  };
  render();
})(typeof window !== 'undefined' ? window : globalThis);
