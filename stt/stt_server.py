"""
Servidor de transcripción (STT) para Hermes.
Mantiene el modelo Whisper RESIDENTE en RAM, así que el costo de carga
se paga una sola vez al arrancar y cada nota de voz solo cuesta el tiempo
de transcripción.

Lanzar:  python stt_server.py
Endpoint: POST /transcribe  (multipart: file=<audio>)  -> { text, audio_seconds, elapsed }
"""
import os
import time
import tempfile

from fastapi import FastAPI, UploadFile, File
from faster_whisper import WhisperModel

MODEL    = os.environ.get("STT_MODEL", "large-v3-turbo")
THREADS  = int(os.environ.get("STT_THREADS", "6"))
LANG     = os.environ.get("STT_LANG", "es")          # "" o "auto" = autodetección
COMPUTE  = os.environ.get("STT_COMPUTE", "int8")
PORT     = int(os.environ.get("STT_PORT", "8000"))

print(f"[stt] cargando modelo '{MODEL}' (threads={THREADS}, compute={COMPUTE})...", flush=True)
_t0 = time.time()
model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS)
print(f"[stt] modelo listo en {time.time() - _t0:.1f}s", flush=True)

app = FastAPI(title="Hermes STT")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "audio.ogg")[1] or ".ogg"
    data = await file.read()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        t1 = time.time()
        lang = None if LANG in ("", "auto") else LANG
        segments, info = model.transcribe(
            path, language=lang, beam_size=1, vad_filter=True
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        elapsed = time.time() - t1
        print(f"[stt] {info.duration:.1f}s audio -> {elapsed:.2f}s  ({text[:60]!r})", flush=True)
        return {
            "text": text,
            "audio_seconds": round(info.duration, 2),
            "elapsed": round(elapsed, 2),
            "language": info.language,
        }
    finally:
        os.remove(path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
