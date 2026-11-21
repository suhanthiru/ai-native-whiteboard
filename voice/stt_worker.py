"""Speech-to-text worker: faster-whisper over JSON lines on stdin/stdout.

Request:  {"id": "...", "pcm16_b64": "<little-endian int16 mono>", "rate": 16000}
Response: {"id": "...", "text": "..."} or {"id": "...", "error": "..."}
The first line written is {"ready": true, "device": "cuda"|"cpu", "model": "..."}.
"""
import base64
import json
import os
import sys

import numpy as np

MODEL = os.environ.get("WB_WHISPER_MODEL", "small.en")
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models", "whisper")


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def load_model():
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(MODEL, device="cuda", compute_type="float16", download_root=MODEL_DIR), "cuda"
    except Exception as cuda_error:  # CUDA libs missing or no GPU: fall back to CPU int8
        sys.stderr.write(f"CUDA unavailable ({cuda_error}); using CPU\n")
        return WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=MODEL_DIR), "cpu"


def transcribe(model, pcm_b64, rate):
    audio = np.frombuffer(base64.b64decode(pcm_b64), dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        # Linear resample; the app already sends 16 kHz so this is a safety net.
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio), n, endpoint=False), np.arange(len(audio)), audio).astype(np.float32)
    segments, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()


def main():
    try:
        model, device = load_model()
    except Exception as error:
        emit({"ready": False, "error": str(error)})
        return
    emit({"ready": True, "device": device, "model": MODEL})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            text = transcribe(model, request["pcm16_b64"], int(request.get("rate", 16000)))
            emit({"id": request.get("id"), "text": text})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)})


if __name__ == "__main__":
    main()
