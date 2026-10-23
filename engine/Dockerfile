FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SALAHDATA=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./server.py
COPY static ./static
COPY workflows ./workflows
RUN mkdir -p /data/outputs
EXPOSE 8000
CMD ["uvicorn","server:app","--host","0.0.0.0","--port","8000"]
