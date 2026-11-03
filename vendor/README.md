## Vendor

Headless vite app that emulates a vendor's agent and API that a muse-like agent will interact with when sourcing products and bartering.

## Spin up a dummy vendor

Deploy the same build once per vendor (see `.railway/railway.ts` for the two
demo instances). Per instance, set only env:

1. `VENDOR_NAME`, `VENDOR_PRICE`, `VENDOR_FLOOR` for that vendor.
2. Nothing else: `/.well-known/poppy.json` is served dynamically, with
   `organization.domain` taken from the host serving the document and the
   endpoint derived from it (PAP: own domain = own identity).
3. Serve over HTTPS. Personal agents discover the vendor at `https://<host>/.well-known/poppy.json`.

Each deployment is an independent Company under PAP (own domain = own identity, signed-out only).

## Protocol profile (PAP-lite)

Modeled on [Cliffside Retail](https://www.cliffside-retail.com/developers), the PAP 0.3 demo company. Implements [Personal Agent Protocol 0.3](https://personalagentprotocol.org/docs/0.3) in reduced form, as taught to the personal agent in the proof API's `llms.txt`. Only what the barter demo needs:

- Kept: `poppy.json` discovery (Cliffside shape, minus auth), the signed-out inventory API (`GET /api/products/{sku}/inventory`, Cliffside `Inventory` shape), `poppy` conversation protocol (`POST {endpoint}`, `POST {endpoint}/{id}/messages`, `GET {endpoint}/{id}/events`), quotes/offers in message `data`.
- Omitted: OAuth sign-in and scopes, `Poppy-Session` header verification, rewards/whoami, sizes/private pages, mediated sign-in, handoff/close, approvals, and purchase. Signed-out quote + barter only; user approval happens outside the protocol.

## Architecture

`src/api.ts` — the poppy conversation endpoints available to the personal agent (served by the Vite plugin in `vite.config.ts`).

`src/inventory.ts` — a simplified vendor inventory: one demo SKU, asking price from `VENDOR_PRICE`.

`src/discount_policy.ts` — proof-gated discounts: concede only when a TLSNotary presentation verifies _and_ attests a lower price; never below the floor. Anchored mode: `POST /poppy/conversations {product, presentationB64}` derives ask/floor from the attested anchor (`VENDOR_MARKUP_PCT`, `VENDOR_FLOOR_PCT`) and beats rivals per `VENDOR_UNDERCUT_MODE` (`penny` = $0.01, `percent` = `VENDOR_UNDERCUT_PCT`%).

`src/telemetry.ts` — OpenTelemetry-shaped log emission for every event (`vendor.conversation.created`, `vendor.quote.issued`, `vendor.proof.received/verified/rejected`, `vendor.offer.countered/held/floor`). Each event is printed as one JSON line on stdout and, if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, POSTed as OTLP/HTTP JSON to `{endpoint}/v1/logs` — feed either stream into the demo control panel.

`src/llm_policy.ts` — Muse Spark on [TanStack AI](https://tanstack.com/ai/latest) (`@tanstack/ai` 1.0). The Meta API is an OpenAI-compatible Chat Completions endpoint, so the generic `openaiCompatibleText` adapter from `@tanstack/ai-openai/compatible` points at `META_API_BASE_URL` (default `https://api.meta.ai/v1`) with `MODEL_API_KEY` and model `VENDOR_MODEL` (default `muse-spark-1.3`). Counter-proposals use structured output in JSON-object mode (the mode the Meta API supports), validated against a zod schema before the deterministic guard in `discount_policy.ts` disposes. Any model failure returns `null` and the guard falls back to its deterministic step. Each accepted proposal records provenance on its events: `model`, `modelProvider: "Meta"`, and `runtime` (`VENDOR_AGENT_RUNTIME`, default `TanStack AI`; set explicitly on both Railway vendor services).

`POST /api/chat` + `src/main.ts` — the storefront page is vanilla TypeScript. Its "Ask this vendor" box uses `ChatClient` from `@tanstack/ai-client` against `/api/chat`, which streams the same TanStack AI adapter over SSE (`chat()` + `toServerSentEventsResponse`) with a storefront-only system prompt. The chat can explain the shop and the proof-gated barter flow; it cannot offer discounts or move prices. Without `MODEL_API_KEY` the endpoint returns `503` and the page keeps its static content.

## Run

```sh
cp .env.example .env   # optional; defaults work
vp dev
```

Barter flow: `POST /poppy/conversations` (quote) → `POST /poppy/conversations/{id}/messages` with `{"type":"barter","data":{"presentationB64":"..."}}` → verified counter-offer or rejection. The presentation is checked via `VERIFIER_URL` (the vendor's own verifier, sidecar `/verify` shape); the attested price is read from the verified transcript, never from the caller's claim.
