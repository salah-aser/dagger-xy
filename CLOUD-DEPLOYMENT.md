# Salah Cloud — free edge gateway deployment

This adds a public dashboard and a protected Cloudflare Workers gateway to the existing Salah Cloud project. It does **not** create GPU hardware or make the Wan video model run inside Cloudflare.

## What can be free

- The dashboard and gateway can be deployed to the free Cloudflare Workers plan at a `workers.dev` URL.
- The free Workers plan currently includes up to 100,000 requests per day. Free services have quotas and can change; this is not an unlimited hosting guarantee.
- The gateway stores no scripts or videos itself. It forwards authenticated API and media requests to the FastAPI engine you configure.
- A custom domain is optional; the default `workers.dev` subdomain is enough to start.

## Deploy the dashboard + gateway

1. Create a free Cloudflare account at https://dash.cloudflare.com/ and enable your `workers.dev` subdomain in Workers & Pages.
2. Install Node.js LTS on your computer, download this GitHub repository as a ZIP, and extract it.
3. Open PowerShell in the extracted `dagger-xy` folder.
4. Sign in and deploy the frontend/gateway:

   ```powershell
   npx wrangler@4 login
   npx wrangler@4 deploy
   ```

5. Copy the URL printed by Wrangler. It should look like `https://salah-cloud.YOUR-SUBDOMAIN.workers.dev`. Open it to view the dashboard.

6. Set the cloud access password. Use a long, unique value and keep it private:

   ```powershell
   npx wrangler@4 secret put CLOUD_ACCESS_TOKEN
   ```

   Wrangler prompts you to enter the secret value. This is the token you enter in the dashboard's “رمز الدخول الخاص” field.

## Connect a video engine (required for generation)

The gateway is only a secure front door. You must also have a running FastAPI engine reachable over HTTPS:

- `ENGINE_URL`: the public HTTPS origin of the FastAPI server, for example `https://your-engine.example.com`. Do not append `/api`.
- `ENGINE_API_TOKEN`: the exact `API_TOKEN` value from the engine's private `engine/.env` file.

Set each one through Wrangler so the values are not committed to Git:

```powershell
npx wrangler@4 secret put ENGINE_URL
npx wrangler@4 secret put ENGINE_API_TOKEN
```

Then open the Worker URL, enter that same Worker URL into the dashboard's server address field, enter your `CLOUD_ACCESS_TOKEN`, and press “اختبار السيرفر”.

For a temporary laptop test, a Cloudflare Quick Tunnel can publish a local API URL, but its URL changes and it only works while your laptop and engine remain running. Do not expose ComfyUI's port 8188 directly. A stable always-on engine requires a machine that stays powered on and has sufficient compute.

## Important hardware and cost limits

The included Wan 2.2 14B video workflow needs a powerful NVIDIA GPU (the documented reference setup targets about 24 GB VRAM and downloads tens of gigabytes of model weights). The previously discussed GTX 1050 4 GB laptop cannot run that workflow as configured. Cloudflare Workers is not a free GPU server and this gateway cannot generate videos by itself. A free dashboard/API gateway is achievable; unlimited, always-on AI video generation at $0 is not something this design can promise.

## Security

- Never commit `engine/.env`, access tokens, model weights, private stories, or generated videos to GitHub.
- Use separate long secrets for `CLOUD_ACCESS_TOKEN` and `ENGINE_API_TOKEN`.
- The gateway forwards the engine token server-side and never sends it to the browser.
- The dashboard is publicly viewable; API and media requests are protected by `CLOUD_ACCESS_TOKEN`.
- If a token is exposed, rotate it with `npx wrangler@4 secret put CLOUD_ACCESS_TOKEN`.
