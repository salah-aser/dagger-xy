# Salah Web / Salah Cloud

The browser-only prototype has been replaced with a clean, self-hostable server architecture.

- Public control-panel preview: https://salah-aser.github.io/dagger-xy/
- Self-hosted backend and GPU engine source: [engine/README.md](engine/README.md)
- API server: FastAPI + SQLite + ComfyUI client
- Video engine: ComfyUI + open Wan 2.2 models
- Deployment: Docker Compose on a Linux machine with a compatible NVIDIA GPU
- Optional HTTPS: Caddy reverse proxy
- Data and generated files: stored on the host under engine/data and engine/outputs

## Important limits

The public GitHub Pages site is only a frontend; it does not generate video by itself. To produce real AI video, deploy the engine directory on a GPU host and configure a working ComfyUI API workflow. The code and models can be self-hosted, but GPU compute, power, bandwidth, and storage are not guaranteed free forever. Wan 2.2 14B is a large model and needs a capable GPU. Your existing laptop with a GTX 1050 4GB is not enough for this model.

The repository is public at present. Do not commit secrets, voice recordings, generated private stories, model weights, or the engine .env file. Outputs and server job data stay on your self-hosted server once deployed.

## Security

- An API token is required for protected API operations.
- Generated media is served through authenticated endpoints.
- The default voice provider is local espeak-ng, which prioritizes privacy but has basic/robotic Arabic pronunciation. An optional online voice provider sends text outside the server.
- Do not expose ComfyUI's port 8188 directly to the internet.
