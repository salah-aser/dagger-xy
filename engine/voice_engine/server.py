from __future__ import annotations

import hmac
import io
import logging
import os
import re
import threading
import unicodedata
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
logger = logging.getLogger("uvicorn.error")


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language_id: Literal["ar", "en"] = "ar"
    exaggeration: float = Field(default=0.45, ge=0.0, le=1.2)
    cfg_weight: float = Field(default=0.35, ge=0.0, le=1.0)


_ARABIC_LETTERS = re.compile(r"[\u0621-\u064A\u066E-\u06D3]")
_ARABIC_MARKS = re.compile(r"[\u064B-\u065F\u0670]")


def normalize_arabic_text(text: str) -> str:
    """Conservative normalization: preserve letters and meaning-bearing hamza forms."""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\u0640", "")  # tatweel
    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\u2066-\u2069]", "", text)
    text = re.sub(r"[\t\r\f\v ]+", " ", text)
    text = re.sub(r" *\n+ *", " \n ", text)
    return re.sub(r" +", " ", text).strip()


def split_speech_text(text: str, max_chars: int = 260) -> list[str]:
    """Split only between words, preferring sentence boundaries; never cut a word."""
    sentences = [part.strip() for part in re.split(r"(?<=[.!?؟؛…])\s+|\n+", text) if part.strip()]
    chunks: list[str] = []
    current = ""

    def split_long_sentence(sentence: str) -> list[str]:
        words = re.findall(r"\S+(?:\s+|$)", sentence)
        pieces: list[str] = []
        buffer = ""
        for word in words:
            word = word.strip()
            if not word:
                continue
            if buffer and len(buffer) + 1 + len(word) > max_chars:
                pieces.append(buffer)
                buffer = word
            elif len(word) > max_chars:
                if buffer:
                    pieces.append(buffer)
                    buffer = ""
                pieces.append(word)
            else:
                buffer = (buffer + " " + word).strip()
        if buffer:
            pieces.append(buffer)
        return pieces

    for sentence in sentences or [text.strip()]:
        if len(sentence) <= max_chars:
            candidate = (current + " " + sentence).strip()
            if current and len(candidate) > max_chars:
                chunks.append(current)
                current = sentence
            else:
                current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        long_parts = split_long_sentence(sentence)
        if long_parts:
            chunks.extend(long_parts[:-1])
            current = long_parts[-1]

    if current:
        chunks.append(current)
    return chunks or [text.strip()]


def _without_arabic_marks(text: str) -> str:
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def prepare_arabic_chunk(text: str) -> str:
    """Add best-effort tashkeel to unvocalized Arabic while preserving supplied tashkeel."""
    if not _ARABIC_LETTERS.search(text) or _ARABIC_MARKS.search(text):
        return text
    try:
        import ichkil

        result = ichkil.diacritize(text)
        if not result or _without_arabic_marks(result) != _without_arabic_marks(text):
            logger.warning("Arabic diacritizer output failed character-preservation check; using original text.")
            return text
        logger.info("Arabic tashkeel applied to an unvocalized narration chunk.")
        return result
    except Exception:
        logger.exception("Arabic diacritization failed; falling back to original Arabic text.")
        return text


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
    text = payload.text.strip()
    if payload.language_id == "ar":
        text = normalize_arabic_text(text)
        speech_chunks = split_speech_text(text)
        speech_chunks = [prepare_arabic_chunk(chunk) for chunk in speech_chunks]
    else:
        speech_chunks = [text]

    kwargs = {
        "language_id": payload.language_id,
        "exaggeration": payload.exaggeration,
        "cfg_weight": payload.cfg_weight,
    }
    if REFERENCE_AUDIO.is_file() and REFERENCE_AUDIO.stat().st_size > 1024:
        kwargs["audio_prompt_path"] = str(REFERENCE_AUDIO)

    # Generate manageable word-safe chunks, then join them into one WAV.
    waveforms = []
    with GENERATION_LOCK:
        for index, chunk in enumerate(speech_chunks):
            waveform = model.generate(chunk, **kwargs)
            if not isinstance(waveform, torch.Tensor):
                waveform = torch.as_tensor(waveform)
            waveform = waveform.detach().cpu()
            if waveform.ndim == 1:
                waveform = waveform.unsqueeze(0)
            elif waveform.ndim == 3 and waveform.shape[0] == 1:
                waveform = waveform.squeeze(0)
            if waveform.ndim != 2:
                raise RuntimeError(f"Unexpected TTS waveform shape: {tuple(waveform.shape)}")
            if waveforms:
                previous_ends_sentence = bool(re.search(r"[.!?؟؛…]$", speech_chunks[index - 1]))
                pause_seconds = 0.18 if previous_ends_sentence else 0.08
                silence = torch.zeros(
                    (waveform.shape[0], int(model.sr * pause_seconds)),
                    dtype=waveform.dtype,
                )
                waveforms.append(silence)
            waveforms.append(waveform)

    waveform = torch.cat(waveforms, dim=-1)
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
        "arabic_fusha_processing": "normalization + best-effort tashkeel for unvocalized text",
        "long_text_handling": "word-safe chunks joined into one WAV",
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
        # Keep details private from HTTP clients, but retain a traceback in local Docker logs.
        logger.exception("Chatterbox speech synthesis failed")
        message = str(exc)
        if "out of memory" in message.lower():
            raise HTTPException(status_code=503, detail="Voice engine ran out of memory. Try a shorter passage or use a larger machine.") from exc
        raise HTTPException(status_code=500, detail="Voice synthesis failed. Check voice-engine logs and model download status.") from exc
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
