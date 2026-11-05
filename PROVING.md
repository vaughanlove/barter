# Proving: extension to PAP 0.3

This document defines the proving extension to PAP 0.3.

This protocol is designed to build on top of [PAP 0.3](https://personalagentprotocol.org/docs/0.3). It does not replace it.

Related protocols: [Universal Commerce Protocol (UCP)](https://ucp.dev/) and [Agentic Commerce Protocol (ACP)](https://www.agenticcommerce.dev/). eCommerce pricing feeds defined in UCP or ACP greatly improve the ease of generating proofs of prices.

PAP 0.3 defines discovery, conversations, and quotes. This extension adds one field, `presentationB64`, to two existing calls. It also defines when a vendor may change a price in response to that field.

It does not define pricing policy, a floor price, checkout, or a session record.

Reference implementations: [`tlsn-sidecar/`](tlsn-sidecar/README.md) (prover), [`vendor/src/api.ts`](vendor/src/api.ts) (vendor), [`personal-agent/run.mjs`](personal-agent/run.mjs) (personal agent).

## Proof format

A proof is a TLSNotary presentation encoded as a base64 string.

The field name is `presentationB64`.

A valid presentation proves that an HTTPS response came from the TLS session of the named host. The presentation discloses the request target, the response headers, and the response body. It discloses header names but not values for `User-Agent` and `Authorization`.

The *attested price* is the price parsed from the disclosed response body of a presentation that passes verification. A price sent in any other field has no effect.

## Prover interface

A prover provides three endpoints.

```http
POST /prove
{"host": "shop.example", "path": "/products/widget.json"}
→ {"serverName": "shop.example", "presentationB64": "…", "verifyingKeyHex": "…"}

POST /verify
{"presentationB64": "…"}
→ {"valid": true, "serverName": "…", "time": …, "sent": "…", "received": "…"}

GET /pubkey
→ {"algorithm": "secp256k1", "verifyingKeyHex": "…", "fingerprint": "…"}
```

`POST /prove` accepts `{host, port, path, headers}`. `port` is optional and defaults to `443`. `path` is optional and defaults to `/`. `headers` is optional. The prover returns an error if the target does not return HTTP 200.

`POST /verify` accepts `{presentationB64}`. On success it returns `valid: true` and the disclosed transcript in `sent` and `received`. On failure it returns `{"valid": false, "error": "…"}`.

`GET /pubkey` returns the notary verifying key for the presentations the prover issues.

Verification does not require the prover. A vendor may call `/verify`, or verify the presentation locally against the key from `/pubkey`.

Price parsing is applied to `received` after verification. The reference vendor reads a `"price"` field first, then a `$` amount. Responses should be small. A product API response, for example Shopify `{host}/products/{handle}.json`, is preferred to an HTML page.

## Call 1: open a conversation

The personal agent sends the anchor proof when it opens the conversation. The anchor is the first public price the agent proves for the product.

```http
POST {vendor}/poppy/conversations
{"product": "carpe deodorant", "presentationB64": "<anchor proof>"}

→ 201 {"id": "…", "quote": {"price": 20.94, "currency": "USD"}}
→ 422 {"error": "anchor proof did not verify"}
```

The vendor verifies `presentationB64` before it returns a quote. If verification fails, or no price can be parsed from the verified transcript, the vendor returns `422`. If verification succeeds, the vendor sets its asking price from the attested price according to its own pricing policy.

This deployment also sends `sessionId` in this call. `sessionId` links the conversation to a record on barter.computer. It is not part of this extension.

## Call 2: barter

The personal agent sends a proof of the other vendor's current quote.

```http
POST {vendor}/poppy/conversations/{id}/messages
{"type": "barter", "data": {"presentationB64": "<proof of rival quote>"}}

→ 200 {"type": "offer", "data": {"price": 19.93, "note": "…", "floorReached": false}}
→ 200 {"type": "rejected", "data": {"price": 20.94, "reason": "proof did not verify"}}
```

The proof target is the rival vendor's events endpoint:

```http
GET {vendor}/poppy/conversations/{id}/events
```

That endpoint returns the conversation state, including the current price, over HTTPS. It is proved with `POST /prove` using that vendor's host and the events path. No separate quote format is defined.

## Vendor rule

The vendor applies these steps in order:

1. If `presentationB64` is missing, return `{"type": "rejected", "data": {"price": <current price>, "reason": "proof required to barter"}}`.
2. If the presentation does not verify, or no price can be parsed from the verified transcript, return `{"type": "rejected", "data": {"price": <current price>, "reason": "proof did not verify"}}`.
3. If the attested price is greater than or equal to the current price, return the current price as an `offer`.
4. If the attested price is lower than the current price, return an `offer` with a price below the attested price. The new price must not be below the vendor's floor. If the floor is reached, set `floorReached: true` in the response.

The vendor must parse the price from the verified transcript. It must not use a price supplied separately by the caller.

The floor is set by the vendor. It is not sent in any request or response.

## Trust

Verification establishes that the disclosed bytes came from the named host's TLS session, under the notary key in the presentation. The vendor checks that key against `/pubkey`.

In this deployment the prover and the notary are the same service. A vendor that verifies a presentation from this prover trusts that service not to issue a false attestation. Separating the prover from the notary is not defined here.

Limits of the reference prover: TLS 1.2 only, no compressed responses, and a maximum transcript size. These limits are the reason a product API response is preferred to an HTML page.
