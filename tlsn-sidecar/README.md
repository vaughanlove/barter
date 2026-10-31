# tlsn-sidecar

TLSNotary proof service for the barter hackathon demo. It runs an MPC-TLS
session to a real public HTTPS server, has the transcript attested by the
sidecar notary, and returns a selectively disclosed presentation that anyone
can verify against `/pubkey`.

This supersedes the Void dev notary's hash-signing flow (`notary/`). The dev
notary only proves "the notary signed a hash a prover submitted"; this service
proves "this response came from that server's TLS session", with only the
chosen bytes revealed.

## API

```sh
curl localhost:8080/health
curl localhost:8080/pubkey

# Prove a public page/API response. Keep responses small and uncompressed.
curl -X POST localhost:8080/prove -H 'Content-Type: application/json' \
  -d '{"host":"example.com","path":"/"}'

# Verify a presentation returned by /prove.
curl -X POST localhost:8080/verify -H 'Content-Type: application/json' \
  -d '{"presentationB64":"..."}'
```

`/prove` reveals the request target, request headers except `User-Agent` and
`Authorization` values, all response headers, and the response body. Secrets
are never returned. Requests are serialized inside the service; the MPC-TLS
work is intentionally not parallelized for the demo.

## Railway

Deployed as the `prove` service in the project-level Infrastructure as Code
at [`.railway/railway.ts`](../.railway/railway.ts) (see
[`.railway/README.md`](../.railway/README.md) for plan/apply and DNS steps).
Railway builds the included `Dockerfile` from `tlsn-sidecar/`.

1. Generate a stable notary key and set it on the `prove` service
   (IaC references it with `preserve()`; it never enters the repo):

   ```sh
   openssl rand -hex 32
   ```

   ```ini
   NOTARY_SIGNING_KEY_HEX=<the 64 hex characters>
   ```

2. Strongly recommended for any public deployment:

   ```ini
   TLSN_ALLOWED_HOSTS=example.com,your-vendor.example
   ```

   Without an allowlist, the service refuses targets that resolve to private,
   loopback, link-local, multicast, documentation, or CGNAT addresses, but any
   public hostname can still be requested.
3. `railway config plan`, then `railway config apply`. Railway supplies `PORT`.

Optional: `TLSN_MAX_RECV_DATA` can raise the transcript receive cap from
16384 to at most 1048576 bytes. Larger transcripts cost more MPC time and
memory; keep vendor calls API-shaped and send `Accept-Encoding: identity`
(the service does this itself).

## Local run

```sh
NOTARY_SIGNING_KEY_HEX=$(openssl rand -hex 32) cargo run --release
```

## Trust and limits (hackathon scope)

- **Same-process notary:** prover and notary run in one Railway service.
  This demonstrates the attestation and disclosure mechanics, but a verifier
  must trust this deployment not to collude with itself. A production design
  separates the notary operator from the prover.
- **TLS 1.2 / no compression:** TLSNotary MPC-TLS constraints. Use small API
  responses rather than full HTML pages where possible.
- **Not general ZK:** this is MPC-TLS attestation with selective disclosure,
  not a zero-knowledge proof about hidden data.
