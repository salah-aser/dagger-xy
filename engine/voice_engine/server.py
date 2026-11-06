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
_QURANIC_ANNOTATION_MARKS = re.compile(r"[\u06D6-\u06ED]")
_ALL_ARABIC_MARKS = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")
_LEXICON_PATH = Path(__file__).with_name("arabic_lexicon.json")
_MAX_DIACRITIZER_CHARS = 1024
_MAX_SPEECH_CHARS = 180


def normalize_arabic_text(text: str) -> str:
    """Normalize spacing and invisible controls without changing Arabic spelling."""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\u0640", "")
    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\u2066-\u2069]", "", text)
    text = re.sub(r"[\t\r\f\v ]+", " ", text)
    text = re.sub(r" *\n+ *", "\n", text)
    return text.strip()


def _strip_arabic_marks(text: str) -> str:
    return _ALL_ARABIC_MARKS.sub("", text)


def _letter_boundary_pattern(phrase: str) -> str:
    mark = r"[\u064B-\u065F\u0670\u06D6-\u06ED]*"
    pieces = []
    for char in phrase:
        if char.isspace():
            pieces.append(r"\s+")
        else:
            pieces.append(re.escape(char) + mark)
    arabic_letter = r"\u0621-\u064A\u066E-\u06D3"
    return r"(?<![" + arabic_letter + r"])" + "".join(pieces) + r"(?![" + arabic_letter + r"])"


def apply_arabic_phrase_lexicon(text: str) -> tuple[str, list[str]]:
    """Apply only exact, curated reading forms; never perform broad spelling substitutions."""
    try:
        import json
        entries = json.loads(_LEXICON_PATH.read_text(encoding="utf-8")).get("entries", [])
    except FileNotFoundError:
        logger.warning("Arabic pronunciation lexicon file is missing; continuing without phrase overrides.")
        return text, []
    except Exception:
        logger.exception("Could not read Arabic pronunciation lexicon; continuing without phrase overrides.")
        return text, []

    applied: list[str] = []
    for entry in entries:
        source = str(entry.get("text", "")).strip()
        spoken = str(entry.get("spoken", "")).strip()
        if not source or not spoken:
            continue
        pattern = re.compile(_letter_boundary_pattern(source))
        updated, count = pattern.subn(lambda _match, value=spoken: value, text)
        if count:
            text = updated
            applied.append(source)
    return text, applied


def _split_units(text: str, max_chars: int = _MAX_SPEECH_CHARS) -> list[str]:
    """Split at punctuation/newlines, then at whitespace only; never split a word."""
    clauses: list[str] = []
    start = 0
    for index, char in enumerate(text):
        if char in "،,؛;:!?؟.…" and (index + 1 == len(text) or text[index + 1].isspace()):
            part = text[start:index + 1].strip()
            if part:
                clauses.append(part)
            start = index + 1
        elif char == "\n":
            part = text[start:index].strip()
            if part:
                clauses.append(part)
            start = index + 1
    tail = text[start:].strip()
    if tail:
        clauses.append(tail)

    pieces: list[str] = []
    for clause in clauses:
        remaining = clause
        while len(remaining) > max_chars:
            cut = remaining.rfind(" ", 0, max_chars + 1)
            if cut <= 0:
                cut = remaining.find(" ", max_chars)
            if cut <= 0:
                # An unbroken token is kept intact rather than corrupted.
                break
            pieces.append(remaining[:cut].strip())
            remaining = remaining[cut:].strip()
        if remaining:
            pieces.append(remaining)

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = (current + " " + piece).strip()
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = piece
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or ([text.strip()] if text.strip() else [])


def split_speech_text(text: str, max_chars: int = _MAX_SPEECH_CHARS) -> list[str]:
    return _split_units(text, max_chars=max_chars)


def _text_units_with_marks(text: str) -> list[tuple[str, str]]:
    units: list[list[str]] = []
    for char in text:
        if (unicodedata.category(char).startswith("M") or _QURANIC_ANNOTATION_MARKS.fullmatch(char)) and units:
            units[-1][1] += char
        else:
            units.append([char, ""])
    return [(base, marks) for base, marks in units]


def _merge_original_marks(original: str, predicted: str) -> str:
    """Keep writer-supplied vowel marks; fill only unmarked letters with model predictions."""
    original_units = _text_units_with_marks(original)
    predicted_units = _text_units_with_marks(predicted)
    if len(original_units) != len(predicted_units):
        return predicted
    merged: list[str] = []
    vowel_marks = set("\u064b\u064c\u064d\u064e\u064f\u0650\u0652\u0653\u0654\u0655\u0670")
    shadda = "\u0651"
    for (original_char, original_marks), (predicted_char, predicted_marks) in zip(original_units, predicted_units):
        if original_char != predicted_char:
            return predicted
        supplied_vowels = [mark for mark in original_marks if mark in vowel_marks]
        supplied_shadda = shadda in original_marks
        predicted_vowels = [mark for mark in predicted_marks if mark in vowel_marks]
        predicted_shadda = shadda in predicted_marks
        annotations = [mark for mark in original_marks if _QURANIC_ANNOTATION_MARKS.fullmatch(mark)]
        if supplied_vowels:
            chosen_vowels = supplied_vowels
        else:
            chosen_vowels = predicted_vowels
        chosen_shadda = supplied_shadda or predicted_shadda
        chosen_marks = (shadda if chosen_shadda else "") + "".join(chosen_vowels) + "".join(annotations)
        merged.append(original_char + chosen_marks)
    return unicodedata.normalize("NFC", "".join(merged))


def prepare_arabic_chunk(text: str) -> str:
    """Diacritize an Arabic chunk, while preserving supplied marks and Quranic annotations."""
    if not _ARABIC_LETTERS.search(text):
        return text
    try:
        import ichkil

        # Ichkil has a 1024-character model limit. Speech chunks are capped much lower,
        # but retain this guard for direct calls and future integrations.
        if len(_strip_arabic_marks(text)) > _MAX_DIACRITIZER_CHARS:
            return " ".join(prepare_arabic_chunk(part) for part in _split_units(text, 800))
        plain = _strip_arabic_marks(text)
        predicted = ichkil.diacritize(plain)
        if not predicted or _strip_arabic_marks(predicted) != plain:
            logger.warning("Arabic diacritizer changed base characters; keeping supplied text unchanged.")
            return text
        result = _merge_original_marks(text, predicted)
        logger.info("Arabic text prepared with contextual best-effort tashkeel.")
        return result
    except Exception:
        logger.exception("Arabic diacritization failed; falling back to normalized Arabic text.")
        return text


def prepare_arabic_text(text: str) -> dict:
    normalized = normalize_arabic_text(text)
    lexicon_text, applied_overrides = apply_arabic_phrase_lexicon(normalized)
    chunks = split_speech_text(lexicon_text)
    prepared_chunks = [prepare_arabic_chunk(chunk) for chunk in chunks]
    return {
        "normalized_text": normalized,
        "spoken_text": " ".join(prepared_chunks),
        "chunks": prepared_chunks,
        "phrase_overrides": applied_overrides,
        "warnings": [
            "التشكيل الآلي مساعد وقد يخطئ في الإعراب والسياق.",
            "راجع الآيات والأحاديث والأسماء قبل إنتاج الصوت.",
            "لم يتم تصحيح الإملاء أو إعادة صياغة النص؛ احتُفظ بالكلمات كما كُتبت.",
        ],
    }

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
        prepared = prepare_arabic_text(text)
        speech_chunks = prepared["chunks"]
    else:
        text = normalize_arabic_text(text)
        speech_chunks = split_speech_text(text)

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
            # Short fades avoid clicks at concatenation boundaries.
            fade_samples = min(int(model.sr * 0.008), waveform.shape[-1] // 4)
            if fade_samples > 1:
                ramp = torch.linspace(0.0, 1.0, fade_samples, dtype=waveform.dtype)
                waveform[:, :fade_samples] *= ramp
                waveform[:, -fade_samples:] *= torch.flip(ramp, dims=[0])
            if waveforms:
                previous = speech_chunks[index - 1].rstrip()
                if re.search(r"[.!?؟…]$", previous):
                    pause_seconds = 0.30
                elif re.search(r"[،,؛;:]$", previous):
                    pause_seconds = 0.16
                else:
                    pause_seconds = 0.06
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
        "arabic_fusha_processing": "conservative normalization + Ichkil tashkeel + preservation of supplied harakat",
        "arabic_pronunciation_lexicon": _LEXICON_PATH.is_file(),
        "long_text_handling": "punctuation-aware, word-safe chunks with pauses and edge fades",
    }


@app.post("/prepare-text")
def prepare_text(
    payload: SpeechRequest,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    if INTERNAL_TOKEN and not hmac.compare_digest(x_internal_token, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid internal voice-engine token.")
    if payload.language_id != "ar":
        normalized = normalize_arabic_text(payload.text)
        return {"normalized_text": normalized, "spoken_text": normalized, "chunks": [normalized], "phrase_overrides": [], "warnings": []}
    return prepare_arabic_text(payload.text)


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
