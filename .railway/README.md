# Barter on Railway (Infrastructure as Code)

The whole demo deployment is defined in [railway.ts](railway.ts):

| Service | Domain | Source |
|---|---|---|
| `landing` | barter.computer | `ideation/prototype/` (landing, `/llms.txt`, control panel) |
| `prove` | prove.barter.computer | `tlsn-sidecar/` (Dockerfile) |
| `vendor-basecamp` | basecamp.barter.computer | `vendor/` — Basecamp Supply, $84 ask / $68 floor |
| `vendor-ridgeline` | ridgeline.barter.computer | `vendor/` — Ridgeline Outfitters, $72 ask / $64 floor |

Both vendors are the same build; only env differs. `poppy.json` discovery is
served dynamically per instance, so each vendor's domain is its own identity.

## Apply

```sh
npm i -g @railway/cli   # or your preferred install
railway login
railway link            # select/create the "barter" project + environment
railway config plan     # preview — check domains, env, deletions
railway config apply    # apply after confirmation
```

Before the first apply, set the sidecar's signing key in Railway (IaC keeps
it with `preserve()`, so it is never written to this repo):

```sh
openssl rand -hex 32   # set as NOTARY_SIGNING_KEY_HEX on the `prove` service
```

## DNS (barter.computer)

For each custom domain above, Railway returns the exact DNS records to add
when the domain is created (also under service → Settings → Networking).
Add them at the DNS provider for `barter.computer`, exactly as returned —
including any ownership-verification TXT record:

```
@          <record type from Railway>  <target from Railway>   # apex: landing
prove      CNAME  <target from Railway>
basecamp   CNAME  <target from Railway>
ridgeline  CNAME  <target from Railway>
```

The apex (`barter.computer` itself) cannot take a plain CNAME at most
registrars. Use whatever Railway returns for it (ALIAS/ANAME/CNAME
flattening at a provider that supports it, or the A record Railway gives
you). Do not proxy the records through a CDN until TLS is active.

Wait for Railway to show the domains as active (TLS is automatic), then check:

```sh
curl https://barter.computer/llms.txt
curl https://prove.barter.computer/health
curl https://basecamp.barter.computer/.well-known/poppy.json
curl https://ridgeline.barter.computer/.well-known/poppy.json
```

## Notes

- `railway config plan` before every apply; omitting a resource from
  `railway.ts` deletes it on apply.
- The old per-service `railway.toml` (config-as-code, deprecated by Railway)
  was removed from `tlsn-sidecar/` — a service cannot be managed by both.
- `prove` only fetches hosts in `TLSN_ALLOWED_HOSTS` plus public IPs; keep
  the allowlist tight (see `tlsn-sidecar/README.md`).
