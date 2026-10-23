#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Salah Cloud setup"
echo "This script must run on a Linux host with an NVIDIA GPU. It does not create or rent a cloud server."

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: Linux is required for the provided CUDA/ComfyUI Docker stack."
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: nvidia-smi was not found. Install the NVIDIA driver and NVIDIA Container Toolkit first."
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed. Install Docker Engine and Docker Compose v2 first."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 is not installed."
  exit 1
fi
if ! docker info 2>/dev/null | grep -qiE 'nvidia|runtimes'; then
  echo "WARNING: Docker GPU runtime availability could not be confirmed. Verify NVIDIA Container Toolkit."
fi

mkdir -p models/diffusion_models models/text_encoders models/vae models/loras outputs data
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
if grep -q '^API_TOKEN=replace_with_a_long_random_secret$' .env; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to generate a secure API token."
    exit 1
  fi
  NEW_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  python3 - "$NEW_TOKEN" <<'PY'
from pathlib import Path
import sys
p = Path(".env")
value = sys.argv[1]
lines = p.read_text(encoding="utf-8").splitlines()
lines = [("API_TOKEN=" + value) if line.startswith("API_TOKEN=") else line for line in lines]
p.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  echo "Generated a private API_TOKEN and saved it in engine/.env. Do not share or commit this file."
fi

if [[ "\${1:-}" != "--skip-model-download" ]]; then
  echo "Downloading official Wan 2.2 model weights. This is tens of GB; check disk space and bandwidth."
  bash ./download_wan22_14b.sh
else
  echo "Skipping model download as requested."
fi

docker compose up -d --build
echo
echo "Salah Cloud containers have been started on this host."
echo "Check status with: docker compose ps"
echo "Check logs with:   docker compose logs -f"
echo "The API binds to 127.0.0.1:8000 by default; it is not a public server."
echo "For HTTPS, set DOMAIN in .env to a domain you control, then run: docker compose --profile https up -d"
echo "GPU video generation is not available until the model weights finish downloading and ComfyUI reports healthy."
