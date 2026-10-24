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

For a voice-only smoke test on a machine that cannot run the GPU video service, start just the voice container:

```bash
docker compose --profile chatterbox up -d --build chatterbox
```
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


## Optional offline Arabic scene translator

Wan's prompt support is documented primarily for English and Chinese, so the API can optionally send each Arabic scene to a local Ollama instance running the Qwen3 4B instruct model. The translated prompt is used only for the visual-generation request; the original Arabic story and displayed narration remain unchanged. Qwen3 4B is published under Apache-2.0 on its official model card.

From the `engine` folder:

```bash
docker compose --profile arabic-brain up -d ollama
docker compose exec ollama ollama pull qwen3:4b
```

Then edit the private `.env` file and set:

```env
PROMPT_TRANSLATION_ENABLED=true
OLLAMA_MODEL=qwen3:4b
```

Recreate the API container:

```bash
docker compose up -d --force-recreate salah-api
```

The first model pull downloads several gigabytes, and translation can be slow on CPU. Keep the `arabic-brain` profile turned off when you do not need it. The translator is constrained to translate only the scene description; nevertheless, it is not a religious authority and can still mistranslate. Review final scene prompts and religiously sensitive output.

## Windows voice-only smoke test

This phase tests only the local Chatterbox speech engine; it does not start ComfyUI or video generation. Use it to confirm Arabic narration and authorized reference-voice conditioning before deploying a GPU video backend.

1. Install Docker Desktop for Windows using the official guide: https://docs.docker.com/desktop/setup/install/windows-install/ . Choose the WSL 2 backend and start Docker Desktop.
2. Download the latest repository ZIP. Place your authorized reference sample at engine/voice/reference/voice.wav. This file is intentionally excluded from Git.
3. From PowerShell in the repository root, create a private engine/.env file with two random tokens:

```powershell
$apiToken = node -e "process.stdout.write(require('crypto').randomBytes(40).toString('base64url'))"
$voiceToken = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
@("API_TOKEN=$apiToken", "CHATTERBOX_INTERNAL_TOKEN=$voiceToken", "CHATTERBOX_DEVICE=cpu", "PROMPT_TRANSLATION_ENABLED=false") | Set-Content -Encoding ascii .\engine\.env
```

4. Start the isolated voice API and TTS service:

```powershell
docker compose --env-file engine/.env -f engine/docker-compose.voice-test.yml up -d --build
```

5. Watch the first model download and startup:

```powershell
docker compose --env-file engine/.env -f engine/docker-compose.voice-test.yml logs -f chatterbox
```

The first run downloads several gigabytes of image and model data. CPU voice generation may be slow. Keep the reference recording and both tokens private.

To make a temporary website test, run a Cloudflare Quick Tunnel to localhost:8000 and keep its terminal open. Set the Worker secret ENGINE_URL to the current temporary HTTPS tunnel URL and ENGINE_API_TOKEN to the local API_TOKEN value. In the hosted dashboard, enter the separate CLOUD_ACCESS_TOKEN. Quick Tunnel URLs expire/change when the tunnel stops; do not treat them as production hosting. The website's voice preview can work while ComfyUI remains offline, but video generation cannot.

Free GPU access is limited. Kaggle documents a free P100 notebook accelerator but sessions/availability are limited, not an always-on server. The official Wan 2.1 T2V 1.3B page reports about 8.19 GB VRAM, so a GTX 1050 4 GB laptop is below that target. Google Colab's free managed runtime forbids web-service hosting and certain content-generation web UI use. A fully free, permanent, Grok-class video engine cannot be guaranteed.