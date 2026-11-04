# Barter protocol service (barter.computer)

The public face of Barter: the landing page, the protocol
specification (`/llms.txt`), session records (`/s/{id}`), the control
panel (`/panel`), the JEV price classifier (`/find-price`), and the
OTLP log intake (`/v1/logs`) vendor telemetry lands in.

This is a [TanStack Start](https://tanstack.com/start) app. It began
as `ideation/prototype/server.mjs`; the move here was parity-first, so
routes, pages, copy, and behavior match the prototype, reimplemented
on Start server routes with the same SQLite schema (the Railway
volume at `/data/barter.db` keeps working untouched).

## Layout

- `src/routes/` — one file per route. Pages return the same HTML the
  prototype served (templates live in `src/server/pages.ts`); API and
  SSE endpoints are Start server handlers.
- `src/server/store.ts` — sessions, events, proofs, panel logs.
  SQLite via `node:sqlite` at `BARTER_DB_PATH`, JSON-file fallback.
- `src/server/findPrice.ts` — the JEV price classifier (Muse Spark).
- `src/server/llms.ts` — the protocol specification text.
- `server.test.mjs` — boots the built server (`dist/` via `srvx`)
  against a throwaway DB and runs the behavioral suite the prototype
  carried. Two keyphrase tests fail exactly as they did against the
  prototype (pre-existing; the product behavior they assert was not
  implemented there either).

## Run

```sh
pnpm install
pnpm build
pnpm start        # srvx serves dist/server + dist/client
pnpm test         # build + node --test
pnpm dev          # Vite dev server
```

Environment: `PORT`, `BARTER_DB_PATH`, `LANDING_VENDOR_URL`,
`LANDING_VENDOR_URL_B`, `LANDING_SIDECAR_URL`, `MODEL_API_KEY`,
`META_API_BASE_URL`, `JEV_MODEL`, `META_PROTOCOL`.

## Deploy

Railway service `landing`: root directory `protocol`, build
`pnpm build`, start `pnpm start`, healthcheck `/panel`, volume
`/data`. See `.railway/railway.ts`.
