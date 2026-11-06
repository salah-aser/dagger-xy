FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    CHATTERBOX_DEVICE=cpu

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir "chatterbox-tts" "fastapi" "uvicorn[standard]"

# Keep the PyPI dependency layer cached; overlay the upstream source revision
# that includes multilingual V3 model selection without re-resolving dependencies.
RUN pip install --no-cache-dir --force-reinstall --no-deps "https://github.com/resemble-ai/chatterbox/archive/ab55923c27757c90cfcc407baa57dc25a7d25217.zip"

# Lightweight MIT Arabic diacritizer (CPU/ONNX); model weights are cached in HF_HOME on first use.
RUN pip install --no-cache-dir "ichkil==1.0.0"

COPY server.py ./server.py
COPY arabic_lexicon.json ./arabic_lexicon.json
EXPOSE 8010
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8010"]
