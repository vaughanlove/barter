# Handoff — end of day (2026-10-31)

Feed this to the next agent/session. Everything below was verified live today
unless marked as a plan.

## What barter is

A hackathon demo: a user's personal agent (Meta Muse, on-device, the
orchestrator — Muse is designed to run this whole flow, including search via
Meta's internal search) barters with vendor agents over PAP-lite (modeled on
Cliffside Retail, PAP 0.3), using TLSNotary presentations as leverage. Vendor
agents verify proofs themselves, trustlessly, and only concede on a verified
lower price. No barter server in the middle; `llms.txt` teaches the protocol.

## Live system (verified 2026-10-31)

All four Railway services are SUCCESS and answering:

- https://barter.vaughan.love — landing page, `/llms.txt`, `/panel` (control
  panel, light mode, per-session OTEL log viewer). `/llms.txt` teaches the
  protocol; a user verbally tells Muse "go to barter.vaughan.love".
- https://prove.vaughan.love — TLSNotary sidecar. `/health`, `/pubkey`
  (fingerprint `118a8b67111c929a`, keyMode persistent), `POST /prove`,
  `POST /verify`.
- https://basecamp.vaughan.love — dummy vendor "Basecamp Supply"
  ($84 ask / $68 floor, barter target).
- https://ridgeline.vaughan.love — dummy vendor "Ridgeline Outfitters"
  ($72 ask / $64 floor, lowest quote).

Verified end-to-end today: vendor discovery (per-instance poppy.json),
inventory, conversation + quote, proof-less barter rejected, and vendor
OTEL logs appearing in the landing control panel (`/api/sessions`).

## Repo map

- `ideation/prototype/server.mjs` — landing + llms.txt + panel + session/QR
  flow. Zero-dependency Node. This is the deployed `landing` service.
- `tlsn-sidecar/` — Rust (Axum) TLSNotary service. `/prove` runs MPC-TLS
  (prover + notary in one process, pinned tlsn rev 24b10ba) against public
  HTTPS hosts and returns a selectively disclosed presentation. Has SSRF
  guards + `TLSN_ALLOWED_HOSTS`. Local binary builds/tests were verified
  against example.com.
- `vendor/` — Vite vendor agent. `src/api.ts` (poppy conversations,
  Cliffside-shaped inventory, dynamic poppy.json), `src/inventory.ts`,
  `src/discount_policy.ts` (concede only on verified attested lower price,
  $3 undercut, hidden floor), `src/telemetry.ts` (OTLP logs). Same build
  deployed per vendor; only env differs. Tests: `pnpm run test` (5 passing),
  `pnpm exec vp check`, `pnpm run build` — run these after vendor edits.
- `.railway/railway.ts` — Railway IaC for all 4 services. `railway config
  plan` currently reports up to date. Project "barter"
  (a039be1f-133c-4003-a309-4130d5ea356b), workspace vaughanlove's Projects,
  env production. Railway CLI lives at ~/.railway/bin/railway (5.71.0).
- `ideation/formalized/` — v1 diagram/spec + `demo-flows.md` (the demo plan).
- The old Void dev notary was DELETED (superseded by the sidecar). Do not
  resurrect it. Historical mentions in `formalized/v1.*` are provenance.

## Git / deploy state

- Repo: github.com/vaughanlove/barter, branch main, everything pushed
  (initial commit + vendor healthcheck fix + this handoff).
- Railway builds from GitHub on push. To deploy: commit, push, watch
  `railway deployment list --service <name>`, check `railway logs --service`.
- Secrets: `MODEL_API_KEY` only in repo-root `.env` (gitignored).
  `NOTARY_SIGNING_KEY_HEX` only in Railway (set via CLI, never in repo;
  IaC uses `preserve()`). Do not commit keys. The demo vendor's floor is
  env-only and never exposed via API.

## Known issues / gotchas

- `/llms.txt` renders the session base URL from the Host header, so behind
  Railway it can say `http://barter.vaughan.love` instead of https. Fix with
  `x-forwarded-proto` if it matters for the agent run.
- The sidecar's prover and notary share one process: attestation mechanics
  are real, but a verifier must trust this deployment not to collude with
  itself. Production path = independent notary; keep saying this honestly.
- TLSNotary limits: TLS 1.2, no compression, small transcripts (16KB default
  receive cap, env-tunable). Vendor quote responses must stay API-shaped.
- Vendor barter concession path is fully tested only with a fake verifier
  (committed tests). A real concession needs a TLSNotary presentation of a
  vendor quote response containing `"price"` — the deployed vendors are now
  HTTPS, so this is testable end-to-end next.
- Custom domains are registered + ACTIVE; if a domain misbehaves, check
  `railway domain list --service <name>` before touching IaC (Railway cannot
  register NEW custom domains from config; add via CLI/dashboard, then they
  are managed in railway.ts).

## Next work (Vaughan's list, in his order)

1. **Real agent behind the vendors.** Replace/augment the deterministic
   discount policy with an actual Muse Spark-driven vendor agent (open agent)
   that negotiates in the poppy conversation, keeping the proof gate as a
   hard rule: no verified presentation, no concession, never below floor.
   Policy file is `vendor/src/discount_policy.ts`; conversation handling is
   the `barter` branch in `vendor/src/api.ts`.
2. **Stand-in vendor for arbitrary finds (online demo).** When Muse finds a
   product at a real company, generate a stand-in vendor for it: same product
   identity, banded price (±% around the found price, seeded), standard poppy
   endpoints + proof gate. This is the online-demo provider model alongside
   the two dummy vendors.
3. **Trivial traffic/usage tracking.** Vendor OTEL -> landing panel already
   works. Still missing: landing-side counting (page views, llms.txt fetches,
   sessions started) rendered somewhere simple. Note from Vaughan: the
   platform landing is currently also on GitHub Pages — reconcile which
   landing is canonical before instrumenting. Keep it trivial (counters +
   panel), no analytics stack.
4. **Vendor discount-policy knobs (the company side).** Show that vendors
   configure *how* they negotiate, not just a hidden floor. Today
   `vendor/src/discount_policy.ts` only has floor + undercut (env:
   `VENDOR_FLOOR`, `VENDOR_UNDERCUT`). Extend the policy model per vendor
   instance, e.g.: total % discount allowed per deal (and/or per period),
   number of coupons the vendor is willing to issue (count + codes, issued
   as an alternative/complement to price cuts), lowest breakeven cost
   (hard floor derived from cost, distinct from the asking-price band),
   max concession per round / max rounds, and proof threshold (minimum
   verified gap before any concession). Surface the *shape* in the vendor's
   public profile (e.g. "up to 15% with verified proof, coupons available")
   while keeping exact floors/costs private. Wire each knob to env per
   Railway vendor service so the two dummies negotiate visibly differently.
5. **Unique domain (voice-dictation problem).** `vaughan` mis-transcribes
   when voice-dictated, so a unique domain is probably needed after all.
   Leading candidate: **provablybarter.com** ("Barter, provably.") with
   barterproof.com as the mishearing redirect. Availability/trademark NOT
   checked. Related investigation: whether a QR code can open the Muse app
   with a hydrated prompt. Findings so far: Muse's AASA claims
   `muse.ai/chat`, `/chat/*`, `/thread/*` universal links (so opening the app
   via link likely works), but NO public evidence it reads `?prompt=`/`?q=`/
   `?text=`. Test on a real phone by encoding those four URL forms as QRs.
   Fallback that works today: QR -> session page -> Copy prompt -> Open Muse.

## Demo line to protect

"Go to barter.vaughan.love and find me a deal." — one sentence, Muse reads
`llms.txt`, quotes -> proof -> barter (max 3 rounds) -> best offer -> user
approves. Never buy before approval. Rehearse the degrade path (cached
prices, simulated providers) so a vendor fetch failure is invisible.
