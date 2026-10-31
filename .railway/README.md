# Barter on Railway (Infrastructure as Code)

The whole demo deployment is defined in [railway.ts](railway.ts):

| Service | Domain | Source |
|---|---|---|
| `landing` | barter.vaughan.love | `ideation/prototype/` (landing, `/llms.txt`, control panel) |
| `prove` | prove.vaughan.love | `tlsn-sidecar/` (Dockerfile) |
| `vendor-basecamp` | basecamp.vaughan.love | `vendor/` — Basecamp Supply, $84 ask / $68 floor |
| `vendor-ridgeline` | ridgeline.vaughan.love | `vendor/` — Ridgeline Outfitters, $72 ask / $64 floor |

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

## DNS (vaughan.love)

For each custom domain above, Railway shows a CNAME target after apply
(service → Settings → Networking). Add one CNAME per subdomain at your DNS
provider pointing at the target Railway gives you, e.g.:

```
barter     CNAME  <target from Railway>
prove      CNAME  <target from Railway>
basecamp   CNAME  <target from Railway>
ridgeline  CNAME  <target from Railway>
```

Wait for Railway to show the domains as active (TLS is automatic), then check:

```sh
curl https://barter.vaughan.love/llms.txt
curl https://prove.vaughan.love/health
curl https://basecamp.vaughan.love/.well-known/poppy.json
curl https://ridgeline.vaughan.love/.well-known/poppy.json
```

## Notes

- `railway config plan` before every apply; omitting a resource from
  `railway.ts` deletes it on apply.
- The old per-service `railway.toml` (config-as-code, deprecated by Railway)
  was removed from `tlsn-sidecar/` — a service cannot be managed by both.
- `prove` only fetches hosts in `TLSN_ALLOWED_HOSTS` plus public IPs; keep
  the allowlist tight (see `tlsn-sidecar/README.md`).
