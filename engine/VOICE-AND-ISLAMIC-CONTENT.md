# Salah Cloud: Arabic Islamic narration and voice pipeline

This document records the implementation direction for the Arabic Islamic storytelling category.

## What the uploaded Hady Raie Voice Act ZIP actually contains

The ZIP contains React/TypeScript UI and a Node/Express server. Its `server.ts` calls Google Gemini through `@google/genai` using `GEMINI_API_KEY`, including cloud TTS model names. It does not contain the trained Gemini TTS weights, and it contains no WAV/MP3 speaker reference recordings. Copying this project therefore cannot remove Gemini's service quotas. The API-dependent voice engine must be replaced by a self-hosted model to make local speech generation quota-independent.

## Self-hosted Arabic speech

The optional `engine/voice_engine` service uses Chatterbox Multilingual V3. The upstream repository states that its multilingual model supports Arabic and is MIT-licensed. The model weights are downloaded on first use and cached in the container volume. This is an open model that can be self-hosted; it is not the Gemini voice model and cannot be promised to sound identical to a Gemini sample.

### Run the optional voice service

From a Linux host with Docker Compose installed, inside this `engine` folder:

```bash
docker compose --profile chatterbox up -d --build
```

This profile includes the normal services as well as Chatterbox. The normal ComfyUI/video engine still requires a compatible NVIDIA GPU and sufficient VRAM. Chatterbox defaults to CPU mode so it can be tested independently on machines without GPU passthrough; CPU speech generation may be slow. On an appropriate NVIDIA Linux host, set `CHATTERBOX_DEVICE=cuda` in `.env` and add `gpus: all` to the `chatterbox` service in the compose file before starting it.

The first TTS request downloads model weights and may take several minutes. Check logs with:

```bash
docker compose logs -f chatterbox
```

Choose **محلي مفتوح المصدر — Chatterbox عربي** in the dashboard voice selector. If the service is not running, the API returns a visible error instead of silently substituting a robotic voice.

### Optional reference voice

The uploaded ZIP does not include an audio reference, so voice cloning cannot be configured from that ZIP alone. If you own or are authorized to clone the target voice, place a clean WAV reference clip at:

`engine/voice/reference/voice.wav`

The voice engine will use it as a reference; without it, it generates with the model's default speaker. A short, clean sample with one speaker and no music is preferable. Do not use someone's voice without their permission.

## Islamic category and narration rules

The dashboard now sends a `content_category` field. For the Islamic story/history/education categories, the video prompt builder includes safeguards:

- Treat the supplied script as the source of truth; do not invent verses, hadith, attributions, names, events, or miracles.
- Avoid generated subtitles, fake Arabic lettering and sacred calligraphy, which video models often render incorrectly.
- Apply the configured respectful luminous-face rule if a prophet, messenger, or companion is depicted.
- Ask for plausible pre-modern Arab/Islamic clothing, architecture, tools and landscape consistent with the specific scene; avoid modern props and orientalist fantasy clichés.
- Keep each shot to one moment and one continuous composition and preserve recurring character descriptions.

These are prompt-level guardrails, not a theological fact-checker. Human review is required for religious claims, Qur'anic text, hadith grading, historical specifics, and sensitive depictions. The existing scene splitter preserves the script text; it does not rewrite religious text or verify sources.

## Current video-model limitation

The bundled Wan 2.2 TI2V-5B weights are Apache-2.0 on the Hugging Face model card, but the reference requirements target a powerful GPU; a GTX 1050 with 4 GB VRAM is not suitable for this workflow as configured. The scene prompt builder now adds Islamic-category constraints, but the underlying video model is principally documented for English and Chinese prompting. A separate Arabic-aware scene-to-English prompt stage is still needed for best visual adherence; this stage should preserve the exact events and avoid adding religious details rather than freely rewriting the story.

## No false promises

- The web dashboard and lightweight proxy can fit within free hosting quotas.
- Self-hosted weights remove a per-request third-party voice API dependency, but downloading, storage, electricity and compute are not literally cost-free.
- Free public GPU sessions can expire or be unavailable.
- No model guarantees perfect Arabic pronunciation, faithful religious interpretation, consistent characters or Grok-level video quality without evaluation and iteration.
