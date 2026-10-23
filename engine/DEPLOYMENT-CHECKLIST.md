# Deployment checklist

- [ ] Create or choose a Linux host with a compatible NVIDIA GPU and sufficient VRAM.
- [ ] Install NVIDIA drivers, Docker Engine, Compose v2, and NVIDIA Container Toolkit.
- [ ] Put the engine directory on that host.
- [ ] Run bash setup.sh; it generates a long random API_TOKEN in engine/.env, downloads Wan model weights, and starts the stack.
- [ ] Verify /api/health reports ComfyUI online and workflow_configured: true.
- [ ] If remotely accessible, set DOMAIN in .env to a domain you control and run docker compose --profile https up -d. Do not expose port 8188.
- [ ] Open the site root on your server and confirm it auto-connects. If using the separate GitHub Pages dashboard, enter the HTTPS server URL and API_TOKEN.
- [ ] Run one short test project. Only then run long stories.
- [ ] Set a backup policy for data/ and models/.

A machine/provider account is required to make the server run continuously. The code cannot provision a GPU machine or guarantee its cost is zero forever.
