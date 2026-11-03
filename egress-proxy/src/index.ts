// Barter Meta egress proxy (Cloudflare Worker).
//
// Railway egress appears to be blocked by the Meta API (live calls from
// Railway return 404 model_not_found for muse-spark-1.3, while the same
// key and request succeed elsewhere). This Worker is a narrow,
// authenticated reverse proxy: Railway services call it, it forwards to
// the Meta API from Cloudflare's edge, and streams the reply back.
//
// Security shape:
// - Callers authenticate with PROXY_TOKEN (a shared secret the Railway
//   services present as their API key). The Worker never forwards it.
// - The real Meta key lives only as the Worker's META_API_KEY secret and
//   is injected here. It is never logged and never returned.
// - Only two Meta paths are proxied. This is not an open proxy: no
//   caller-chosen hosts, no arbitrary URLs.

interface Env {
  META_API_KEY: string;
  PROXY_TOKEN: string;
  META_API_BASE_URL?: string;
}

const ALLOWED: Record<string, string[]> = {
  "/v1/chat/completions": ["POST"],
  "/v1/models": ["GET"],
};

function error(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code } },
    { status },
  );
}

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "barter-meta-egress" });
    }

    const methods = ALLOWED[url.pathname];
    if (!methods) return error(404, "not_found", "path not proxied");
    if (!methods.includes(request.method)) {
      return error(405, "method_not_allowed", "method not allowed for this path");
    }
    if (!env.META_API_KEY || !env.PROXY_TOKEN) {
      return error(500, "proxy_not_configured", "egress proxy secrets are not configured");
    }

    const auth = request.headers.get("Authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!presented || !(await tokenMatches(presented, env.PROXY_TOKEN))) {
      return error(401, "unauthorized", "missing or invalid egress proxy token");
    }

    const base = (env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    // url.pathname already starts with /v1/...; base ends with /v1.
    const suffix = url.pathname.slice("/v1".length) + url.search;
    const target = `${base}${suffix}`;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.set("Authorization", `Bearer ${env.META_API_KEY}`);

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      // Required by fetch when streaming a request body in Workers.
      ...(request.method === "POST" ? { duplex: "half" } : {}),
    } as RequestInit);

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("x-egress-proxy", "cloudflare");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
