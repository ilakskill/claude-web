"""cw speech-to-text sidecar: a long-lived faster-whisper process driven by src/hub/stt.js.

    python stt-sidecar.py --model small --device auto --language auto

Protocol (one JSON object per line, UTF-8):
  stdout, once, after the model is loaded:
    {"t": "ready", "model": "small", "device": "cuda", "compute": "float16", "loadMs": 1300}
    or {"t": "fatal", "error": "..."} followed by exit code 1.
  stdin requests, answered in order on stdout:
    {"id": 1, "op": "transcribe", "pcm": "<base64 PCM16 LE mono 16 kHz>", "language": "auto"|"en"}
      -> {"id": 1, "ok": true, "text": "...", "language": "en", "ms": 412}
      -> {"id": 1, "ok": false, "error": "..."}
    {"op": "ping"} -> {"t": "pong"}
    {"op": "stop"} -> exit 0 (EOF on stdin also exits 0).
  stderr: diagnostics only (the hub logs each line as WARN). Audio is never written to disk.

Run it with the interpreter that has faster-whisper installed. stt.js passes `-P` (the script's
own directory, src/hub/, is kept off sys.path) but not -I or -s: on this PC the package lives in
the user site-packages, which those two flags hide.
"""
import argparse
import base64
import json
import sys
import time

# Nothing but the standard library before the first stdout line, so an import error is reported
# as a {"t":"fatal"} line instead of a traceback the hub cannot parse.


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg).rstrip() + '\n')
    sys.stderr.flush()


def load_model(name, device):
    from faster_whisper import WhisperModel  # noqa: PLC0415 (deferred: import errors become a fatal line)
    attempts = []
    if device in ('auto', 'cuda'):
        attempts.append(('cuda', 'float16'))
    if device in ('auto', 'cpu'):
        attempts.append(('cpu', 'int8'))
    last = None
    for dev, compute in attempts:
        try:
            t0 = time.perf_counter()
            model = WhisperModel(name, device=dev, compute_type=compute)
            return model, dev, compute, int((time.perf_counter() - t0) * 1000)
        except Exception as e:  # noqa: BLE001 (any load failure falls through to the next device)
            last = e
            log(f'load on {dev}/{compute} failed: {type(e).__name__}: {e}')
    raise RuntimeError(f'cannot load model {name!r} on {device}: {last}')


def transcribe(model, pcm_b64, language):
    import numpy as np  # noqa: PLC0415
    raw = base64.b64decode(pcm_b64, validate=True)
    if len(raw) % 2:
        raw = raw[:-1]
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    lang = None if language in (None, '', 'auto') else language
    segments, info = model.transcribe(audio, beam_size=5, language=lang, vad_filter=True, condition_on_previous_text=False)
    text = ' '.join(s.text.strip() for s in segments if s.text and s.text.strip())
    return text, getattr(info, 'language', lang) or lang or ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='small')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    ap.add_argument('--language', default='auto')
    args = ap.parse_args()

    try:
        model, device, compute, load_ms = load_model(args.model, args.device)
    except Exception as e:  # noqa: BLE001
        emit({'t': 'fatal', 'error': f'{type(e).__name__}: {e}'})
        return 1
    emit({'t': 'ready', 'model': args.model, 'device': device, 'compute': compute, 'loadMs': load_ms})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            log('ignoring a malformed request line')
            continue
        op = req.get('op')
        rid = req.get('id')
        if op == 'stop':
            return 0
        if op == 'ping':
            emit({'t': 'pong'})
            continue
        if op != 'transcribe':
            emit({'id': rid, 'ok': False, 'error': f'unknown op {op!r}'})
            continue
        t0 = time.perf_counter()
        try:
            text, lang = transcribe(model, req.get('pcm') or '', req.get('language') or args.language)
            emit({'id': rid, 'ok': True, 'text': text, 'language': lang, 'ms': int((time.perf_counter() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 (one bad request must not end the process)
            emit({'id': rid, 'ok': False, 'error': f'{type(e).__name__}: {e}'})
    return 0


if __name__ == '__main__':
    sys.exit(main())
