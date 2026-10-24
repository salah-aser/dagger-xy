from __future__ import annotations

import hmac
import io
import os
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

APP_NAME = "Salah Cloud Voice Engine"
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cpu").strip().lower()
REFERENCE_AUDIO = Path(os.getenv("CHATTERBOX_REFERENCE_AUDIO", "/reference/voice.wav"))
INTERNAL_TOKEN = os.getenv("CHATTERBOX_INTERNAL_TOKEN", "")
MODEL = None
MODEL_LOCK = threading.Lock()
GENERATION_LOCK = threading.Lock()

app = FastAPI(title=APP_NAME, version="1.0.0")


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language_id: Literal["ar", "en"] = "ar"
    exaggeration: float = Field(default=0.45, ge=0.0, le=1.2)
    cfg_weight: float = Field(default=0.35, ge=0.0, le=1.0)


def get_model():
    global MODEL
    if MODEL is not None:
        return MODEL
    with MODEL_LOCK:
        if MODEL is None:
            # Model weights are downloaded by Hugging Face on first use and cached in HF_HOME.
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            MODEL = ChatterboxMultilingualTTS.from_pretrained(
                device=DEVICE,
                t3_model="v3",
            )
    return MODEL


def synthesize(payload: SpeechRequest) -> bytes:
    import torch
    import torchaudio

    model = get_model()
    kwargs = {
        "language_id": payload.language_id,
        "exaggeration": payload.exaggeration,
        "cfg_weight": payload.cfg_weight,
    }
    # Voice cloning is opt-in and uses only a reference sample supplied by the owner.
    # Put an authorized, clean WAV sample at engine/voice/reference/voice.wav.
    if REFERENCE_AUDIO.is_file() and REFERENCE_AUDIO.stat().st_size > 1024:
        kwargs["audio_prompt_path"] = str(REFERENCE_AUDIO)

    with GENERATION_LOCK:
        waveform = model.generate(payload.text.strip(), **kwargs)
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform)
    waveform = waveform.detach().cpu()
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)

    buffer = io.BytesIO()
    torchaudio.save(buffer, waveform, int(model.sr), format="wav")
    audio = buffer.getvalue()
    if not audio.startswith(b"RIFF") or len(audio) < 1024:
        raise RuntimeError("The TTS model returned an invalid or empty WAV file.")
    return audio


@app.get("/health")
def health() -> dict:
    return {
        "service": "online",
        "model": "Chatterbox Multilingual V3",
        "language_support": ["ar", "en"],
        "model_loaded": MODEL is not None,
        "device": DEVICE,
        "reference_voice_configured": REFERENCE_AUDIO.is_file(),
    }


@app.post("/tts")
async def tts(
    payload: SpeechRequest,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> Response:
    if INTERNAL_TOKEN and not hmac.compare_digest(x_internal_token, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid internal voice-engine token.")
    try:
        audio = await run_in_threadpool(synthesize, payload)
    except Exception as exc:
        # Keep infrastructure details and stack traces out of public responses.
        message = str(exc)
        if "out of memory" in message.lower():
            raise HTTPException(status_code=503, detail="Voice engine ran out of memory. Try a shorter passage or use a larger machine.") from exc
        raise HTTPException(status_code=500, detail="Voice synthesis failed. Check voice-engine logs and model download status.") from exc
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
