# Salah Cloud Engine

A clean, self-hosted backend for Salah Web. This is source code for your own server, not a hosted GPU service.

## Honest requirements

- An NVIDIA GPU host with NVIDIA drivers and Docker Compose GPU support.
- For the included Wan 2.2 14B text-to-video model, plan for a powerful GPU. The reference workflow was tested on RTX 4090 24 GB VRAM, and one generation can take several minutes. The model downloads total tens of gigabytes. Official guide: https://docs.comfy.org/tutorials/video/wan/wan2_2
- A domain and server account are required for public HTTPS hosting. The repository does not create a cloud account or GPU capacity on your behalf.
- GPU generation is the part that cannot be guaranteed free forever. The program, orchestration code, ComfyUI and open model weights can be self-hosted, but the machine still consumes compute, electricity, storage and bandwidth.

## Architecture

- server.py: FastAPI, SQLite job/project storage, story-to-scene splitter, queue/status, output files, and ComfyUI API client.
- static/index.html: dashboard for server connection, workflow setup, and live job/scene updates.
- comfyui/Dockerfile: builds ComfyUI with CUDA/PyTorch.
- docker-compose.yml: starts ComfyUI GPU engine and the Salah Cloud API.
- download_wan22_14b.sh: downloads the official Wan 2.2 T2V FP8 model pieces.
- Caddyfile: optional HTTPS reverse proxy.

The pipeline generates a voice track and text-driven video for each story scene, overlays the narration with FFmpeg, stores each scene, and joins the outputs into one MP4. Voice-over is not the same as lip-sync. A genuine audio-driven facial animation workflow must be configured separately.

## First-time setup on a Linux NVIDIA GPU host

1. Install NVIDIA GPU drivers and Docker Engine + Docker Compose v2 with NVIDIA Container Toolkit.
2. Copy the engine directory onto the server (clone the repository or upload the directory).
3. From inside the engine directory, run the setup script. It creates a random API token in a local .env file, downloads the model weights (tens of GB), builds the containers and starts the stack:

    bash setup.sh

   To skip the model download temporarily, use:

    bash setup.sh --skip-model-download

   Video generation will not work until the model files have been downloaded.
4. Check the service state and logs:

    docker compose ps
    docker compose logs -f

5. The API binds to 127.0.0.1:8000 by default. For HTTPS/public access, set DOMAIN to a domain you control in .env and run docker compose --profile https up -d. Do not expose ComfyUI port 8188 publicly.

## Configure a ComfyUI API workflow

The backend does not guess how a model's workflow is wired. This avoids silently submitting invalid workflows and burning GPU time.

1. Download the Wan 2.2 text-to-video model weights with download_wan22_14b.sh and wait for ComfyUI health.
2. The official ComfyUI Wan 2.2 text-to-video blueprint is bundled as the default workflow and is expanded to API format automatically.
3. If you prefer a different workflow, open it in ComfyUI, verify it works, export Save (API Format), and upload the JSON in the dashboard.
4. Test a short script first. GET /api/health reports whether ComfyUI and the bundled/custom workflow are available.

The server also accepts a classic ComfyUI graph JSON and attempts conversion via the live /object_info schema. API-format exports are still preferred for custom workflows.

## HTTPS

Point a domain's DNS at the server, open ports 80 and 443, edit .env with DOMAIN=your-domain.example, and run:

    docker compose --profile https up -d

The Caddy container obtains and renews HTTPS certificates. Keep port 8188 private. Set a long random API_TOKEN; it is required by the dashboard for API operations.

## Voice/privacy

- local voice uses espeak-ng in the server container. It is local and free, but speech can sound robotic and Arabic voice quality depends on the installed voice.
- edge voice uses an online TTS endpoint without an API key, but sends the narration text to an external provider. Use it only when you explicitly accept that privacy trade-off.
- If the story has sensitive information, stay with local voice and do not use public/community fallback endpoints.
- Generated job state and final MP4s are stored in the Docker named volume salah_data mounted at /data. ComfyUI intermediates are written to ./outputs; model weights are stored in ./models. Keep all of these server-side folders and the .env file out of Git.

## API routes

- GET /api/health
- GET /api/jobs
- POST /api/jobs
- GET /api/jobs/{id}
- POST /api/jobs/{id}/resume
- POST /api/workflow
- GET /api/workflow/status

Set the dashboard's API token to the same value as .env's API_TOKEN.

## What is not promised

This project does not promise Grok-level quality, continuous lip-sync, a private GPU machine without actually deploying it to a host you control, or unlimited free inference. It provides the application/server code and a self-hostable open-source video engine path; compute availability is still a separate requirement.


## Arabic Islamic storytelling and local voice

See [VOICE-AND-ISLAMIC-CONTENT.md](VOICE-AND-ISLAMIC-CONTENT.md) for the optional Chatterbox Multilingual V3 Arabic TTS service, optional local Qwen3 scene translator, model license notes, and Islamic-category prompt safeguards.

- Add an authorized voice sample as `voice/reference/voice.wav` inside this engine folder to test voice cloning. The uploaded Hady Raie Voice Act ZIP does not include an audio reference or model weights.
- Start the Chatterbox service with `docker compose --profile chatterbox up -d --build`; select the open-source Chatterbox voice in the dashboard.
- Optional local Arabic-to-English visual prompt translation: start Ollama with `docker compose --profile arabic-brain up -d ollama`, pull `qwen3:4b`, and set `PROMPT_TRANSLATION_ENABLED=true` in the private `.env` file.
- For CPU-only hosts, speech synthesis and scene translation can be slow. Video generation still requires a suitable GPU host; free hosting quotas do not provide unlimited GPU inference.
