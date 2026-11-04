// cw voice dictation: a push-to-talk button in the compose bar. Hold to record on a touch screen
// (release to transcribe), click to start and click again to stop with a mouse. The text lands
// in the compose textarea for review; Send is unchanged.
//
// Engine 'whisper' (default): microphone -> AudioWorklet (/app/voice-worklet.js; ScriptProcessor
// fallback) -> PCM16 mono 16 kHz binary frames on /ws/voice/<session id> -> the hub's
// faster-whisper sidecar -> {t:'final', text}. Audio never leaves the tailnet.
// Engine 'browser': the Web Speech API (on Android the audio goes to Google's servers).
//
// Talk mode (talk.js) adds a third rule: while Talk is on, the page listens with the browser's
// SpeechRecognition when it can (live text, no model to wait for), and falls back to the hub's
// whisper when it cannot (no API, plain-HTTP page, hub says no, or the browser's service failed).
// window.cwVoicePick holds that rule, unit-tested from Node.
(() => {
  'use strict';

  /**
   * Which engine hears the next utterance.
   * @param {{hubEngine?: string, talkOn?: boolean, browserStt?: boolean, pref?: string, hasSR?: boolean, secure?: boolean, failed?: boolean}} s
   *   hubEngine: voice.engine from the hub; talkOn: Talk mode is on; browserStt: the hub allows the
   *   browser to listen in Talk mode (voice.talkBrowserStt); pref: 'hub' when the user chose the
   *   hub's whisper; hasSR: SpeechRecognition exists; secure: https or localhost; failed: the
   *   browser's recognizer already failed on this page.
   * @returns {'browser'|'whisper'}
   */
  function pickEngine(s) {
    if (s.hubEngine === 'browser') return 'browser';
    if (s.talkOn && s.browserStt && s.pref !== 'hub' && s.hasSR && s.secure && !s.failed) return 'browser';
    return 'whisper';
  }
  window.cwVoicePick = pickEngine;

  const cw = window.cw;
  if (!cw || !cw.sessionId) return;
  const $ = (id) => document.getElementById(id);
  const btn = $('voice-btn');
  const statusEl = $('voice-status');
  const ta = $('compose-text');
  if (!btn || !statusEl || !ta) return;

  const CHUNK = 2048; // samples per frame (128 ms at 16 kHz)
  let cfg = null;
  let engine = null; // {start(), stop(cancel)} once the config is known
  // Talk mode (talk.js) listens through these: status(text, isError), recording(on), final(text) -> true
  // when it took the utterance (also an empty one) so the compose box does not get it, error(),
  // interim(text) (live words while the browser recognizer listens), engine(name) (which engine is
  // hearing this utterance), autoEnd() (the recognizer stopped by itself while the button was held),
  // listenFailed(reason) (the browser's recognizer broke: whisper takes over), and listenMode() ->
  // 'auto' | 'hub' while Talk is on, anything else when it is not.
  const hooks = { status: null, recording: null, final: null, error: null, interim: null, engine: null, autoEnd: null, listenFailed: null, listenMode: null };
  const call = (name, ...args) => { try { return hooks[name] ? hooks[name](...args) : undefined; } catch { return undefined; } };

  // ---------- status line and text insertion ----------
  function setStatus(text, isError = false) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
    statusEl.classList.toggle('error', !!isError && !!text);
    call('status', text || '', !!isError && !!text);
  }
  let statusTimer = null;
  function flashError(text) {
    setStatus(text, true);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (statusEl.classList.contains('error')) setStatus(''); }, 6000);
  }
  function setRecording(on) {
    btn.classList.toggle('rec', on);
    btn.setAttribute('aria-pressed', String(on));
    call('recording', !!on);
  }
  function setBusy(on) { btn.classList.toggle('busy', on); }

  /** Appends dictated text to the compose box (one space between pieces) and focuses it. */
  function append(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const cur = ta.value;
    ta.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + t;
    ta.dispatchEvent(new Event('input', { bubbles: true })); // compose.js autosizes on input
    ta.focus();
    try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch { /* unsupported */ }
  }

  // ---------- wake lock (keep the screen on while recording) ----------
  let lock = null;
  async function holdWakeLock() {
    try { if (navigator.wakeLock && !lock) lock = await navigator.wakeLock.request('screen'); } catch { lock = null; }
  }
  function releaseWakeLock() {
    const l = lock;
    lock = null;
    if (l) l.release().catch(() => {});
  }

  // ---------- engine: whisper on the hub ----------
  function whisperEngine() {
    let sock = null;
    let stream = null;
    let ctx = null;
    let source = null;
    let node = null;
    let sink = null;
    let workletLoaded = false;
    let recording = false;
    let awaiting = 0; // utterances sent, no final/error yet

    function socketUrl() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws/voice/${cw.sessionId}`;
    }
    function openSocket() {
      if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(sock);
      if (sock && sock.readyState === WebSocket.CONNECTING) {
        return new Promise((res, rej) => { sock.addEventListener('open', () => res(sock), { once: true }); sock.addEventListener('close', rej, { once: true }); });
      }
      return new Promise((resolve, reject) => {
        const s = new WebSocket(socketUrl());
        s.binaryType = 'arraybuffer';
        sock = s;
        s.onopen = () => resolve(s);
        s.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (!msg || typeof msg.t !== 'string') return;
          if (msg.t === 'final') {
            awaiting = Math.max(0, awaiting - 1);
            if (!awaiting) { setBusy(false); setStatus(''); }
            if (call('final', String(msg.text || '').trim()) === true) return; // Talk mode sends it
            if (msg.text) append(msg.text);
            else if (!awaiting && !recording) flashError('nothing heard');
          } else if (msg.t === 'error') {
            awaiting = Math.max(0, awaiting - 1);
            if (!awaiting) setBusy(false);
            call('error');
            flashError(String(msg.message || 'transcription failed'));
          }
        };
        s.onclose = (ev) => {
          if (sock !== s) return;
          sock = null;
          if (ev.code === 4503) flashError('voice is disabled on the hub');
          else if (ev.code === 4404) flashError('session not found');
          else if (recording) flashError('voice connection lost');
          if (recording) stop(true);
          if (awaiting) { awaiting = 0; setBusy(false); if (ev.code !== 4503 && ev.code !== 4404) flashError('voice connection lost'); }
          reject(new Error('closed'));
        };
      });
    }

    function sendChunk(buf) {
      if (recording && sock && sock.readyState === WebSocket.OPEN) sock.send(buf);
    }

    // ScriptProcessor fallback: the same resampler as the worklet, on the main thread.
    function scriptNode() {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / 16000;
      let pending = new Float32Array(0);
      let pos = 0;
      let out = new Int16Array(CHUNK);
      let n = 0;
      const flush = () => { if (n) { sendChunk(out.slice(0, n).buffer); out = new Int16Array(CHUNK); n = 0; } };
      sp.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const src = new Float32Array(pending.length + input.length);
        src.set(pending);
        src.set(input, pending.length);
        while (pos + 1 < src.length) {
          const i = pos | 0;
          const f = pos - i;
          const s = src[i] + (src[i + 1] - src[i]) * f;
          out[n++] = s <= -1 ? -32768 : s >= 1 ? 32767 : (s * 32767) | 0;
          if (n === CHUNK) { sendChunk(out.buffer); out = new Int16Array(CHUNK); n = 0; }
          pos += ratio;
        }
        const keep = Math.min(pos | 0, src.length); // overshoot carries into the next quantum
        pending = src.slice(keep);
        pos -= keep;
      };
      return { node: sp, flush: () => Promise.resolve(flush()) };
    }

    async function workletNode() {
      if (!workletLoaded) { await ctx.audioWorklet.addModule('/app/voice-worklet.js'); workletLoaded = true; }
      const w = new AudioWorkletNode(ctx, 'cw-pcm16', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      let onFlushed = null;
      w.port.onmessage = (e) => {
        if (e.data === 'flushed') { if (onFlushed) onFlushed(); onFlushed = null; return; }
        sendChunk(e.data);
      };
      return {
        node: w,
        flush: () => new Promise((resolve) => {
          onFlushed = resolve;
          w.port.postMessage('flush');
          setTimeout(resolve, 500); // never hang on a dead worklet
        }),
      };
    }

    async function start() {
      if (recording) return;
      if (!window.isSecureContext) { flashError('the microphone needs https: open the tailnet URL'); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { flashError('this browser has no microphone API'); return; }
      setBusy(true);
      setStatus('connecting…');
      try { await openSocket(); } catch { setBusy(false); if (!statusEl.classList.contains('error')) flashError('voice connection failed'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        setBusy(false);
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') flashError('microphone blocked: allow it for this site in the browser settings');
        else if (name === 'NotFoundError') flashError('no microphone found');
        else flashError(`microphone error: ${name || e}`);
        return;
      }
      try {
        if (!ctx) {
          try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
        }
        if (ctx.state !== 'running') await ctx.resume();
        source = ctx.createMediaStreamSource(stream);
        node = ctx.audioWorklet ? await workletNode() : scriptNode();
        sink = ctx.createGain();
        sink.gain.value = 0; // the graph must reach the destination to run; nothing is played
        source.connect(node.node);
        node.node.connect(sink);
        sink.connect(ctx.destination);
      } catch (e) {
        teardownAudio();
        setBusy(false);
        flashError(`audio setup failed: ${(e && e.message) || e}`);
        return;
      }
      if (!sock || sock.readyState !== WebSocket.OPEN) { teardownAudio(); setBusy(false); flashError('voice connection lost'); return; }
      sock.send(JSON.stringify({ t: 'start' }));
      recording = true;
      setRecording(true);
      setBusy(false);
      setStatus('listening… release to transcribe');
      holdWakeLock();
    }

    function teardownAudio() {
      try { if (source) source.disconnect(); } catch { /* gone */ }
      try { if (node) node.node.disconnect(); } catch { /* gone */ }
      try { if (sink) sink.disconnect(); } catch { /* gone */ }
      if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
      source = null; node = null; sink = null; stream = null;
    }

    async function stop(cancel = false) {
      if (!recording) return;
      const n = node;
      // Flush first (the last partial chunk), then end: the hub transcribes what it has.
      if (!cancel && n) { try { await n.flush(); } catch { /* best effort */ } }
      recording = false;
      setRecording(false);
      releaseWakeLock();
      teardownAudio();
      if (sock && sock.readyState === WebSocket.OPEN) {
        if (cancel) { sock.send(JSON.stringify({ t: 'cancel' })); setStatus(''); return; }
        sock.send(JSON.stringify({ t: 'end' }));
        awaiting++;
        setBusy(true);
        setStatus('transcribing…');
      } else {
        setStatus('');
      }
    }

    return { start, stop, isRecording: () => recording };
  }

  // ---------- engine: Web Speech API in the browser ----------
  const speechRecognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  // The browser's recognizer broke (its service is unreachable, or refuses this page): for the rest
  // of this page's life Talk mode listens with the hub's whisper instead.
  let browserFailed = false;
  const FALLBACK_ERRORS = ['network', 'service-not-allowed', 'language-not-supported'];

  function browserEngine() {
    const SR = speechRecognition();
    let rec = null;
    let recording = false;
    let text = ''; // everything heard so far in this utterance: final results and the interim tail, in order
    let stopAsked = false;
    let failedWith = null;
    function start() {
      if (recording) return;
      if (!SR) { flashError('this browser has no speech recognition; set voice.engine to "whisper" on the hub'); return; }
      rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = cfg && cfg.language && cfg.language !== 'auto' ? cfg.language : (navigator.language || 'en-US');
      text = '';
      stopAsked = false;
      failedWith = null;
      rec.onresult = (e) => {
        // Continuous results accumulate in e.results (resultIndex is only where this event starts),
        // so the whole utterance is the concatenation of all of them. Taking the interim tail too
        // means a quick release never loses the last words to a result that has not turned final.
        let all = '';
        for (let i = 0; i < e.results.length; i++) all += (all ? ' ' : '') + e.results[i][0].transcript.trim();
        text = all;
        call('interim', all);
        setStatus(all ? `listening… ${all}` : 'listening… release to finish');
      };
      rec.onerror = (e) => {
        if (FALLBACK_ERRORS.includes(e.error)) {
          failedWith = e.error;
          browserFailed = true;
          call('listenFailed', e.error);
          flashError(e.error === 'network'
            ? "the browser's speech service is unreachable; using the hub's whisper from now on"
            : `the browser's speech recognition refused (${e.error}); using the hub's whisper from now on`);
        } else if (e.error === 'not-allowed') flashError('microphone blocked: allow it for this site in the browser settings');
        else if (e.error !== 'aborted' && e.error !== 'no-speech') flashError(`speech recognition error: ${e.error}`);
      };
      rec.onend = () => {
        const by = stopAsked;
        recording = false;
        setRecording(false);
        releaseWakeLock();
        const heard = text.trim();
        text = '';
        if (failedWith) { call('error'); return; } // nothing usable; the error line stays, the next utterance goes to whisper
        if (!by) call('autoEnd'); // the recognizer ended on its own (silence): Talk treats it as a release
        if (call('final', heard) === true) { setStatus(''); return; } // Talk mode sends it
        if (heard) { append(heard); setStatus(''); } else if (!statusEl.classList.contains('error')) setStatus('');
      };
      try { rec.start(); } catch (e) { flashError(`speech recognition failed: ${(e && e.message) || e}`); return; }
      recording = true;
      setRecording(true);
      setStatus('listening… release to finish');
      holdWakeLock();
    }
    function stop(cancel = false) {
      if (!recording || !rec) return;
      stopAsked = true;
      if (cancel) { text = ''; try { rec.abort(); } catch { /* gone */ } } else { try { rec.stop(); } catch { /* gone */ } }
    }
    return { start, stop, isRecording: () => recording };
  }

  // ---------- button: hold on touch, toggle with a mouse or keyboard ----------
  let holdPointer = null;
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the textarea focused, like Send
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press must not open a menu
  btn.addEventListener('pointerdown', (e) => {
    if (!engine || e.pointerType === 'mouse') return;
    e.preventDefault();
    holdPointer = e.pointerId;
    try { btn.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    engine.start();
  });
  const release = (e) => {
    if (!engine || holdPointer === null || e.pointerId !== holdPointer) return;
    holdPointer = null;
    engine.stop(e.type === 'pointercancel');
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('click', (e) => {
    if (!engine) return;
    // Touch presses are handled by pointerdown/up; a mouse click (or Enter/Space) toggles.
    if (e.pointerType === 'touch' || e.pointerType === 'pen' || (e.detail > 0 && holdPointer !== null)) return;
    if (engine.isRecording()) engine.stop(); else engine.start();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && engine && engine.isRecording()) { holdPointer = null; engine.stop(true); }
  });
  window.addEventListener('pagehide', () => { if (engine && engine.isRecording()) engine.stop(true); });

  // ---------- boot: the hub says which engine (if any) ----------
  fetch('/api/voice', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      cfg = c;
      if (!c || !c.enabled) return;
      engine = c.engine === 'browser' ? browserEngine() : switchingEngine(c);
      btn.title = c.engine === 'browser'
        ? 'Dictate (browser speech recognition): hold on a phone, click to toggle at a desk'
        : `Dictate (whisper ${c.model || ''} on the hub): hold on a phone, click to toggle at a desk`;
      btn.hidden = false;
    })
    .catch(() => {});

  /** The engine the next utterance would use, as pickEngine decides (also what Talk shows). */
  function currentChoice() {
    const mode = call('listenMode');
    return pickEngine({
      hubEngine: cfg && cfg.engine,
      talkOn: mode === 'auto' || mode === 'hub',
      browserStt: !!(cfg && cfg.talk && cfg.talk.browserStt),
      pref: mode === 'hub' ? 'hub' : 'auto',
      hasSR: !!speechRecognition(),
      secure: !!window.isSecureContext,
      failed: browserFailed,
    });
  }

  /** Whisper for dictation; in Talk mode the browser recognizer when pickEngine says so. Chosen per utterance. */
  function switchingEngine() {
    const engines = {};
    const get = (name) => engines[name] || (engines[name] = name === 'browser' ? browserEngine() : whisperEngine());
    let active = null;
    return {
      start() {
        if (active && active.isRecording()) return;
        const name = currentChoice();
        active = get(name);
        call('engine', name);
        active.start();
      },
      stop(cancel) { if (active) active.stop(cancel); },
      isRecording: () => !!(active && active.isRecording()),
    };
  }

  cw.voice = {
    hooks,
    append,
    start: () => engine && engine.start(),
    stop: (cancel) => engine && engine.stop(cancel),
    /** 'browser' | 'whisper': what Talk mode would listen with right now. */
    get choice() { return cfg ? currentChoice() : null; },
    get browserFailed() { return browserFailed; },
    get state() { return { engine: cfg && cfg.engine, enabled: !!(cfg && cfg.enabled), recording: !!(engine && engine.isRecording()), status: statusEl.textContent }; },
  };
})();
