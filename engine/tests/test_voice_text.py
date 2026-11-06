import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from voice_engine.server import (  # noqa: E402
    _merge_original_marks,
    _strip_arabic_marks,
    apply_arabic_phrase_lexicon,
    normalize_arabic_text,
    prepare_arabic_chunk,
    split_speech_text,
)


def test_normalization_removes_tatweel_and_invisible_controls_without_changing_spelling():
    source = "إِنَّ\u0640هُ\u200f  مُهِمٌّ\n\nجِدًّا"
    normalized = normalize_arabic_text(source)
    assert "إِنَّهُ" in normalized
    assert "\u0640" not in normalized
    assert "\u200f" not in normalized
    assert "\n\n" not in normalized


def test_split_speech_text_preserves_words_and_punctuation():
    source = "هذه جملة طويلة، ثم تأتي جملة ثانية؛ وبعدها سؤال مهم؟"
    chunks = split_speech_text(source, max_chars=22)
    assert len(chunks) > 1
    assert " ".join(chunks).replace(" ", "") == source.replace(" ", "")
    assert all(chunk for chunk in chunks)
    assert all(not chunk.endswith(("ا", "ل", "م")) or len(chunk) > 1 for chunk in chunks)


def test_original_vowel_marks_win_while_missing_letters_get_model_marks():
    original = "كَتَبَ الرجل"
    predicted = "كُتِبَ الرَّجُلُ"
    merged = _merge_original_marks(original, predicted)
    assert merged.startswith("كَتَبَ")
    assert "الرَّجُلُ" in merged
    assert _strip_arabic_marks(merged) == _strip_arabic_marks(original)


def test_phrase_lexicon_only_rewrites_curated_exact_phrases():
    spoken, applied = apply_arabic_phrase_lexicon("قال الراوي: بسم الله الرحمن الرحيم.")
    assert applied == ["بسم الله الرحمن الرحيم"]
    assert "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ" in spoken
    unchanged, applied = apply_arabic_phrase_lexicon("الله رحيم بعباده")
    assert unchanged == "الله رحيم بعباده"
    assert applied == []


def test_diacritizer_preserves_existing_marks_and_quranic_annotation_marks(monkeypatch):
    class FakeIchkil:
        @staticmethod
        def diacritize(text: str) -> str:
            return text.replace("كتب", "كُتِبَ").replace("الرجل", "الرَّجُلُ")

    monkeypatch.setitem(sys.modules, "ichkil", FakeIchkil)
    source = "كَتَبَ الرجل ۞"
    prepared = prepare_arabic_chunk(source)
    assert prepared.startswith("كَتَبَ")
    assert "الرَّجُلُ" in prepared
    assert "۞" in prepared
    assert _strip_arabic_marks(prepared) == _strip_arabic_marks(source)
