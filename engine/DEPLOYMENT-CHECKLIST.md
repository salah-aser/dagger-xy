# Deployment checklist

- [ ] Create or choose a Linux host with a compatible NVIDIA GPU and sufficient VRAM.
- [ ] Install NVIDIA drivers, Docker Engine, Compose v2, and NVIDIA Container Toolkit.
- [ ] Put the engine directory on that host.
- [ ] Create a long random API_TOKEN in a local .env; never commit it.
- [ ] Download the official model weights with download_wan22_14b.sh.
- [ ] Start docker compose up -d --build.
- [ ] Configure and verify the ComfyUI API workflow.
- [ ] Verify /api/health reports ComfyUI online and workflow_configured: true.
- [ ] If remotely accessible, configure a domain + HTTPS with Caddy. Do not expose port 8188.
- [ ] Run one short test project. Only then run long stories.
- [ ] Set a backup policy for data/ and models/.

A machine/provider account is required to make the server run continuously. The code cannot provision a GPU machine or guarantee its cost is zero forever.
