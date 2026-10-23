# Salah Web / Salah Cloud

This repository now contains a self-hostable server architecture in the engine/ directory.

- Public control panel: https://salah-aser.github.io/dagger-xy/
- Server setup: engine/README.md
- Backend: FastAPI + SQLite job storage + authenticated media routes.
- Video engine: ComfyUI + the official Wan 2.2 text-to-video blueprint, bundled into the API image by default.
- Deployment: Docker Compose on a Linux host with a compatible NVIDIA GPU.
- Optional HTTPS reverse proxy: Caddy.
- Model weights and generated projects stay on the server disk and are excluded from Git.

## What has actually been deployed?

GitHub Pages hosts the dashboard only. The GPU backend source has been added and its Python tests run in GitHub Actions; no GPU server has been created or started by this repository. To generate real AI video, run the setup on a Linux NVIDIA GPU machine and connect to its API URL from the dashboard.

## Limits and privacy

No source code can guarantee a private always-on GPU server or unlimited free video inference for life. Compute, storage, electricity and bandwidth require real resources. The official Wan 2.2 14B workflow needs a powerful GPU (the reference workflow targets 24 GB VRAM) and downloads tens of GB of model weights. The user's previously described GTX 1050 4 GB laptop is not suitable for this server configuration.

This repository remains public. Do not commit secrets, voice recordings, generated private stories, model weights or the engine/.env file. The default voice is local espeak-ng and may sound robotic; optional Edge TTS sends text to an external provider. Video generation creates a scene and overlays a voice-over; it does not guarantee character-perfect continuity or lip synchronization.
