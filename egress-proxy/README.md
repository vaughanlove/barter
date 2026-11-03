# Barter Meta egress proxy

A tiny Cloudflare Worker that sits between Railway and the Meta API.

Why: live Meta calls from Railway egress return `404 model_not_found`
for `muse-spark-1.3`, while the same key and request succeed from other
egress. This Worker forwards from Cloudflare's edge instead.

## Shape

- `GET /health` — unauthenticated liveness.
- `POST /v1/chat/completions`, `GET /v1/models` — the only proxied paths.
- Callers (the Railway vendor services) authenticate with `PROXY_TOKEN`,
  presented as their API key. The Worker strips it and injects the real
  `META_API_KEY` secret. Neither secret is logged or returned.
- Responses stream through untouched, so SSE chat works as before.

## Deploy

```sh
npx wrangler@latest login
npx wrangler@latest deploy            # prints the workers.dev URL
npx wrangler@latest secret put META_API_KEY   # the real Meta API key
npx wrangler@latest secret put PROXY_TOKEN    # a fresh shared secret
```

## Point the vendors at it

On each Railway vendor service (`vendor-basecamp`, `vendor-ridgeline`):

- `META_API_BASE_URL=https://<worker-host>/v1`
- `MODEL_API_KEY=<PROXY_TOKEN>` (the vendors' TanStack AI adapter sends
  it as the bearer token; the Worker swaps in the real Meta key)

`META_API_BASE_URL` is also declared in `.railway/railway.ts`.
`MODEL_API_KEY` stays `preserve()` there — set its value with the
Railway CLI or dashboard, never in source.

The landing service can reuse the same Worker later by setting the
same two variables; it is not wired up by default.
