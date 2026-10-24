const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});

async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const isMedia = url.pathname.startsWith("/media/");

    // Serve the existing Salah Cloud dashboard as static assets.
    if (!isApi && !isMedia) return env.ASSETS.fetch(request);

    if (!env.CLOUD_ACCESS_TOKEN) {
      return json({ detail: "Salah Cloud gateway needs configuration. Set CLOUD_ACCESS_TOKEN in Worker secrets." }, 503);
    }

    const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match || !(await constantTimeEqual(match[1].trim(), env.CLOUD_ACCESS_TOKEN))) {
      return json({ detail: "Access denied. Enter your Salah Cloud access token in the dashboard." }, 401);
    }

    if (!env.ENGINE_URL || !env.ENGINE_API_TOKEN) {
      return json({
        detail: "The cloud gateway is online, but no video engine is connected yet. Configure ENGINE_URL and ENGINE_API_TOKEN after starting your own engine."
      }, 503);
    }

    let engine;
    try {
      engine = new URL(env.ENGINE_URL);
    } catch {
      return json({ detail: "ENGINE_URL is not a valid URL." }, 500);
    }

    if (engine.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(engine.hostname)) {
      return json({ detail: "ENGINE_URL must use HTTPS for public deployments." }, 500);
    }

    // ENGINE_URL must be the public origin of the FastAPI server, without an /api suffix.
    engine.pathname = url.pathname;
    engine.search = url.search;
    engine.hash = "";

    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer " + env.ENGINE_API_TOKEN);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("cookie");

    const init = {
      method: request.method,
      headers,
      redirect: "manual"
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

    try {
      const upstream = await fetch(new Request(engine.toString(), init));
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("cache-control", "no-store");
      responseHeaders.set("x-content-type-options", "nosniff");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch {
      return json({
        detail: "Salah Cloud could not reach the configured engine. Check that the engine is online and ENGINE_URL is correct."
      }, 502);
    }
  }
};