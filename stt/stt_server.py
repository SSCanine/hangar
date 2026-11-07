"""Hangar speech-to-text: faster-whisper on the CPU, OpenAI-style endpoint.

POST /v1/audio/transcriptions   multipart field "file"  ->  {"text": "..."}
GET  /health                    ->  {"ok": true, "model": "small", "loaded": bool}

CPU only on purpose (int8): it never touches the GPU, so it can't fight a render.
Run with: python stt_server.py [--port 3621] [--model small]
Needs: pip install faster-whisper fastapi uvicorn python-multipart
"""

import argparse
import os
import tempfile
import threading
import time

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "3621")))
parser.add_argument("--model", default=os.getenv("HANGAR_STT_MODEL", "small"))
parser.add_argument("--threads", type=int, default=6)
args, _ = parser.parse_known_args()

app = FastAPI(title="Hangar STT")
_model = None
_lock = threading.Lock()


def model():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
        return _model


@app.get("/health")
def health():
    return {"ok": True, "model": args.model, "loaded": _model is not None}


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), language: str | None = Form(None), model_name: str | None = Form(None, alias="model")):
    suffix = os.path.splitext(file.filename or "clip.webm")[1] or ".webm"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(file.file.read())
        t0 = time.time()
        segments, info = model().transcribe(path, language=language or None, vad_filter=True, beam_size=1)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language, "seconds": round(time.time() - t0, 2)}
    except Exception as e:  # surface decode/model errors to the caller
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}") from e
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


if __name__ == "__main__":
    # Load the model in the background so /health answers right away.
    threading.Thread(target=model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
