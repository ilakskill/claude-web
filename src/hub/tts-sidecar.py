"""cw text-to-speech sidecar: a long-lived Kokoro or Piper process driven by src/hub/tts.js.

    python tts-sidecar.py --engine kokoro --kokoro-model kokoro-v1.0.onnx --kokoro-voices voices-v1.0.bin --threads 8 --voice af_heart
    python tts-sidecar.py --engine piper --piper-model en_US-amy-medium.onnx

Protocol (one JSON object per line, UTF-8):
  stdout, once, after the model is loaded:
    {"t": "ready", "engine": "kokoro", "loadMs": 2500, "providers": ["CPUExecutionProvider"]}
    or {"t": "fatal", "error": "..."} followed by exit code 1.
  stdin requests, answered in order on stdout:
    {"id": 1, "op": "synthesize", "text": "...", "voice": "af_heart", "speed": 1.0, "out": "C:\\...\\x.wav"}
      -> {"id": 1, "ok": true, "ms": 1800, "seconds": 4.2, "rate": 24000}   (a 16-bit mono WAV is at `out`)
      -> {"id": 1, "ok": false, "error": "..."}
    {"op": "ping"} -> {"t": "pong"}
    {"op": "stop"} -> exit 0 (EOF on stdin also exits 0).
  The WAV is written to `out + ".part"` and renamed, so a file at `out` is always complete.
  stderr: diagnostics only (the hub logs each line as WARN). Text is never logged here.

Run it with the interpreter that has kokoro-onnx / piper-tts installed. tts.js passes `-P` (the
script's own directory stays off sys.path) but not -I or -s: on this PC the packages live in the
user site-packages, which those two flags hide.
"""
import argparse
import json
import os
import sys
import time
import wave

# Nothing but the standard library before the first stdout line, so an import error is reported
# as a {"t":"fatal"} line instead of a traceback the hub cannot parse.

KOKORO_LANG = {'a': 'en-us', 'b': 'en-gb', 'e': 'es', 'f': 'fr-fr', 'h': 'hi', 'i': 'it', 'j': 'ja', 'p': 'pt-br', 'z': 'cmn'}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg).rstrip() + '\n')
    sys.stderr.flush()


def write_wav(path, pcm16_bytes, rate):
    tmp = path + '.part'
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16_bytes)
    os.replace(tmp, path)


def load_kokoro(args):
    import onnxruntime as ort  # noqa: PLC0415 (deferred: import errors become a fatal line)
    from kokoro_onnx import Kokoro  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    opts = ort.SessionOptions()
    if args.threads > 0:
        # The default (one thread per logical CPU) is several times slower than 8 on a 32-thread CPU.
        opts.intra_op_num_threads = args.threads
    sess = ort.InferenceSession(args.kokoro_model, sess_options=opts, providers=['CPUExecutionProvider'])
    kokoro = Kokoro.from_session(sess, args.kokoro_voices)
    voices = set(kokoro.get_voices())

    def render(text, voice, speed):
        if voice not in voices:
            raise ValueError(f'unknown Kokoro voice {voice!r}')
        samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=KOKORO_LANG.get(voice[:1], 'en-us'))
        return (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes(), rate

    return render, sess.get_providers()


def load_piper(args):
    from piper import PiperVoice  # noqa: PLC0415
    from piper.config import SynthesisConfig  # noqa: PLC0415
    voice = PiperVoice.load(args.piper_model)

    def render(text, _voice, speed):
        cfg = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed)))
        pcm = b''.join(c.audio_int16_bytes for c in voice.synthesize(text, syn_config=cfg))
        return pcm, voice.config.sample_rate

    return render, ['piper']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', required=True, choices=['kokoro', 'piper'])
    ap.add_argument('--kokoro-model', default='')
    ap.add_argument('--kokoro-voices', default='')
    ap.add_argument('--piper-model', default='')
    ap.add_argument('--threads', type=int, default=8)
    ap.add_argument('--voice', default='af_heart', help='voice for the warm-up and for requests that name none')
    args = ap.parse_args()

    t0 = time.perf_counter()
    try:
        render, providers = (load_kokoro if args.engine == 'kokoro' else load_piper)(args)
        # The first inference builds onnxruntime's caches (about 4 s for Kokoro); do it before
        # "ready" so the first real request is as fast as the later ones.
        render('Ready.', args.voice, 1.0)
    except Exception as e:  # noqa: BLE001
        emit({'t': 'fatal', 'error': f'{type(e).__name__}: {e}'})
        return 1
    emit({'t': 'ready', 'engine': args.engine, 'loadMs': int((time.perf_counter() - t0) * 1000), 'providers': providers})

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
        if op != 'synthesize':
            emit({'id': rid, 'ok': False, 'error': f'unknown op {op!r}'})
            continue
        t1 = time.perf_counter()
        try:
            text = str(req.get('text') or '').strip()
            out = str(req.get('out') or '')
            if not text or not out:
                raise ValueError('text and out are required')
            pcm, rate = render(text, str(req.get('voice') or args.voice), float(req.get('speed') or 1.0))
            write_wav(out, pcm, rate)
            seconds = len(pcm) / 2 / rate
            emit({'id': rid, 'ok': True, 'ms': int((time.perf_counter() - t1) * 1000), 'seconds': round(seconds, 2), 'rate': rate})
        except Exception as e:  # noqa: BLE001 (one bad request must not end the process)
            emit({'id': rid, 'ok': False, 'error': f'{type(e).__name__}: {e}'})
    return 0


if __name__ == '__main__':
    sys.exit(main())
