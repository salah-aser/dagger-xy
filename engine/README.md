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
3. Enter the engine directory and prepare local storage:

    mkdir -p models/diffusion_models models/text_encoders models/vae models/loras outputs data
    cp .env.example .env
    python3 -c "import secrets; print(secrets.token_urlsafe(48))"

4. Paste the generated value after API_TOKEN= in .env. Never commit .env.
5. Download the model weights (these are large files; run once):

    bash download_wan22_14b.sh

6. Start the stack:

    docker compose up -d --build
    docker compose logs -f

7. Open http://SERVER-IP:8000 on the server network. The compose file binds the API to 127.0.0.1; for access from your computer use an SSH tunnel or enable HTTPS with a domain using the Caddy instructions below. Do not expose ComfyUI port 8188 publicly.

## Configure a ComfyUI API workflow

The backend does not guess how a model's workflow is wired. This avoids silently submitting invalid workflows and burning GPU time.

1. In ComfyUI, install/download the matching Wan 2.2 text-to-video workflow and models.
2. Open the workflow, verify it works once inside ComfyUI, then choose Save (API Format) / export the API workflow JSON.
3. Open the Salah Cloud dashboard, choose that JSON under ComfyUI API workflow, and click Save workflow.
4. Test a short script first. GET /api/health reports whether ComfyUI and the workflow are available.

The server also accepts a classic ComfyUI graph JSON and attempts conversion via the live /object_info schema. An API-format export is preferred, especially for subgraphs.

## HTTPS

Point a domain's DNS at the server, open ports 80 and 443, edit .env with DOMAIN=your-domain.example, and run:

    docker compose --profile https up -d

The Caddy container obtains and renews HTTPS certificates. Keep port 8188 private. Set a long random API_TOKEN; it is required by the dashboard for API operations.

## Voice/privacy

- local voice uses espeak-ng in the server container. It is local and free, but speech can sound robotic and Arabic voice quality depends on the installed voice.
- edge voice uses an online TTS endpoint without an API key, but sends the narration text to an external provider. Use it only when you explicitly accept that privacy trade-off.
- If the story has sensitive information, stay with local voice and do not use public/community fallback endpoints.
- Generated assets and job state are stored in ./data. Keep this directory out of Git.

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
