# barter

> **New session? Start with [ideation/HANDOFF.md](ideation/HANDOFF.md)** — current state, live URLs, next tasks, and gotchas.

## Layout

- `ideation/prototype/` — landing page (`/`), `/llms.txt`, and the session control panel (`/panel`).
- `tlsn-sidecar/` — the deployable TLSNotary proof service for Railway (`/prove`, `/verify`, `/pubkey`, `/health`). See [tlsn-sidecar/README.md](tlsn-sidecar/README.md).
- `vendor/` — vendor agent demo app (PAP-lite; deploy once per vendor). See [vendor/README.md](vendor/README.md).
- `ideation/` — hand-drawn sketches, formalized diagrams, and demo flows.
- `.railway/` — Railway Infrastructure as Code for the whole deployment. See [.railway/README.md](.railway/README.md).

## Test the Meta API

Requires `MODEL_API_KEY` in `.env` (repo root).

```sh
node ideation/formalize.mjs --help  # diagram pipeline; full run uses the API
```

Runs `GET /models` (auth check), then a minimal chat completion, and prints status, latency, reply, and token usage.
