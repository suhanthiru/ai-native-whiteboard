"""Text-to-speech worker over JSON lines on stdin/stdout.

Engines, in order: Kokoro (kokoro-onnx, needs voice/models/kokoro-v1.0.onnx and
voices-v1.0.bin), then Piper (needs the `piper` command and WB_PIPER_MODEL).

Request:  {"id": "...", "text": "..."}
Response: {"id": "...", "wav_b64": "..."} or {"id": "...", "error": "..."}
The first line written is {"ready": true, "engine": "..."} or {"ready": false, "error": "..."}.
"""
import base64
import io
import json
import os
import subprocess
import sys
import wave

HERE = os.path.dirname(__file__)
KOKORO_MODEL = os.path.join(HERE, "models", "kokoro-v1.0.onnx")
KOKORO_VOICES = os.path.join(HERE, "models", "voices-v1.0.bin")
KOKORO_VOICE = os.environ.get("WB_KOKORO_VOICE", "af_heart")
PIPER_MODEL = os.environ.get("WB_PIPER_MODEL", "")


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def to_wav(samples, rate):
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buffer.getvalue()


def kokoro_engine():
    if not (os.path.exists(KOKORO_MODEL) and os.path.exists(KOKORO_VOICES)):
        raise RuntimeError("Kokoro model files are not in voice/models/")
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(KOKORO_MODEL, KOKORO_VOICES)

    def speak(text):
        samples, rate = kokoro.create(text, voice=KOKORO_VOICE, speed=1.0, lang="en-us")
        return to_wav(samples, rate)

    return "kokoro", speak


def piper_engine():
    if not PIPER_MODEL or not os.path.exists(PIPER_MODEL):
        raise RuntimeError("set WB_PIPER_MODEL to a Piper .onnx voice")

    def speak(text):
        result = subprocess.run(["piper", "--model", PIPER_MODEL, "--output_file", "-"], input=text.encode("utf-8"), capture_output=True, check=True)
        return result.stdout

    return "piper", speak


def main():
    errors = []
    engine = None
    for factory in (kokoro_engine, piper_engine):
        try:
            engine = factory()
            break
        except Exception as error:
            errors.append(f"{factory.__name__}: {error}")
    if engine is None:
        emit({"ready": False, "error": "; ".join(errors)})
        return
    name, speak = engine
    emit({"ready": True, "engine": name})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            wav = speak(request["text"])
            emit({"id": request.get("id"), "wav_b64": base64.b64encode(wav).decode("ascii")})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)})


if __name__ == "__main__":
    main()
