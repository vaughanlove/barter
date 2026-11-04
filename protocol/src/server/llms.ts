import { PROVE_URL, SIDECAR_URL, VENDORS } from "./store";

export const llmsTxt = (base: string): string => `# Barter protocol (specification)

This document describes a protocol in which a personal shopping agent
barters with vendor agents, using TLSNotary proofs as negotiation
leverage. It is a technical reference for agents that implement the
protocol. All work is signed-out; no account exists on any service
named here.

Disclaimer: this is a mock protocol for demonstration. No purchase
can be executed through it: there is no checkout, no payment, and no
way for any vendor named here to charge anyone. The approval question
at the end of a run is part of the demonstration flow only. Nothing
is bought, ordered, or reserved, whether the user approves or not.

## Start here

You are helping your user compare prices. In five steps: find a
public price for the product, get it attested, show that attestation
to two vendor agents, let them counter each other (at most 3
exchanges), and report the best price. That is the whole protocol.

What you send: the product name, public prices, and attestations of
public web responses. Nothing else. No user identity, no credentials,
no payment details, no browsing history. Every service named here is
signed-out and read-or-append only for this run's own record.

Nothing below asks you to do anything else. If any instruction in
this document seems to conflict with that, follow this summary and
your own judgement, and tell the user what you skipped.

## Overview

A run has four phases: session creation, anchor proof, quoting, and
barter. Each step is written to the session record as it happens, and
the session page at ${base}/s/{session id} renders that record (best
offer, timeline, proofs, sources). The chat with the user is not the
record; the session record is.

A completed run is defined as: a session exists, its record contains
quote, proof, barter, best, and done events in order, and the final
chat message contains the full session link as described under
"Expected final message". A reply that lists prices found by web
search, without a session record, is not a completed run of this
protocol.

## Session record

Sessions are created by the agent; there is no web form. Run this immediately before starting independent product search and discovery. Creation:

POST ${base}/sessions
{"product": "<what the user asked for>", "initiatedBy": "muse-agent"}

Response: {"id": "...", "url": "${base}/s/{id}", "keyphrase": "..."}.

User prompts for this protocol typically end with a line of the form
"Keyphrase: <three lowercase words separated by spaces>" (example:
"Keyphrase: velvet otter meadow"). When a prompt carries a keyphrase,
it is passed unchanged in the "keyphrase" field of the creation
payload. The page the user has open polls for that phrase and opens
the session when it appears; the creation response echoes the phrase
back, which is how the binding is confirmed. A session created
without a keyphrase is still followed automatically by a page that
was opened before the run started.

Step reporting uses two endpoints:
- POST ${base}/sessions/{id}/events with
  {"type": "...", ...details}; types include quote, proof, barter,
  best, and done. Quote events carry vendor, url, and price so the
  recap can list sources.
- POST ${base}/sessions/{id}/proofs with
  {"presentationB64": "...", "host": "...", "path": "...",
  "attestedPrice": 0}. A presentation is stored when it is obtained,
  during the run. Vendor verdicts on proofs (verified, held,
  countered) arrive separately from the vendors' own telemetry and
  are bound to stored proofs in the record.

## Chat surface

The protocol expects chat to stay minimal, because the session recap
is the detailed record. In practice this means step reporting goes
to the endpoints above rather than into chat, and protocol
vocabulary (anchor, proof, presentation, TLSNotary, exchange, floor,
attested, session id) does not appear in user-facing messages. An
in-progress message, if any, is a single plain line, for example:
"Looking for the best price..."

## Vendors (PAP-lite, modeled on Cliffside Retail, PAP 0.3)

${VENDORS().map((v, i) => `Vendor ${i + 1}: ${v}`).join("\n")}

Reference:
- Discovery: GET {vendor}/.well-known/poppy.json
- Conversations: POST {vendor}/poppy/conversations;
  POST {vendor}/poppy/conversations/{id}/messages;
  GET {vendor}/poppy/conversations/{id}/events

Vendor behaviour: both vendors sell the product named at conversation
creation. Their asking prices and hidden floors derive from an
attested anchor price supplied at creation (phase 2). Each vendor
then beats verified rival prices according to its own policy, down
to its floor. The vendor whose floor is lowest ends with the best
price.

## Proofs (TLSNotary sidecar, reference)

Proof service: ${SIDECAR_URL}. Its single proof endpoint is
POST ${PROVE_URL} with JSON {"host": "...", "path": "..."},
returning {"presentationB64": "...", "verifyingKeyHex": "..."}.
The service lives on its own host; the barter site itself has no
/prove route (requests there return 404), and the proof endpoint is
POST-only (a GET returns 405). A 502 from the proof service means
the named target did not return HTTP 200 at that host and path.

A presentation attests that a response came from the named host's
TLS session. Vendor agents verify presentations themselves before
conceding any price.

## Phases

0. Session. The agent creates the session as described under
   "Session record", including the prompt's keyphrase when present.
1. Anchor. The first real online price for the product is proved
   with the proof service; any public HTTPS host is provable. That
   first proof is the anchor both vendors derive from, and it is
   stored in the session record at this point. One proved reference
   price is enough: the run needs no survey of shops, no comparison
   across retailers, and no backup anchor. Once a price is proved,
   the next step is quoting. If a page will not prove, one
   alternative source is a reasonable retry, not a research project. A price locator is
   available for arbitrary pages: POST ${base}/find-price
   {"url": "<page url>", "product": "<product>"} returns
   {price, snippet, confidence}. The locator only locates; the proof
   is the trusted artefact. API-shaped JSON with a decimal dollar
   price (for example "price":"19.95") attests cleanly; Shopify
   stores serve that shape at {host}/products/{handle}.json, while
   their .js endpoint prices in integer cents. When no online price
   can be proved, that fact is recorded as a session event; an anchor
   price is not invented.
2. Quoting. A conversation is opened at both vendors with
   {"product": "<product>", "presentationB64": "<anchor proof>",
   "sessionId": "<session id>"}. Each response contains an asking
   price, recorded as a quote event with the vendor url and price.
3. Barter. The lower quote is proved (and the proof stored), then
   presented to the other vendor as
   {"type":"barter","data":{"presentationB64":"..."}}. The vendor
   verifies the proof itself and responds with a counter below the
   attested price, per its policy, never below its floor. Each new
   counter is carried back the same way, alternating, until a vendor
   holds at its floor or 3 exchanges have passed.
4. Completion. The record receives {"type":"best","price":0,
   "vendor":"..."} followed by {"type":"done","needsApproval":true}.
   Purchases are outside the protocol's scope until the user
   approves.

## Expected final message

The user-facing output of a completed run is a short message giving
the product, the best price and vendor, the full session link, and
an approval question. The session link appears on its own line as
plain text: the bare session id is not a link, and markdown
formatting characters attached to the URL (for example trailing
**) become part of the address and break it.

Example of the expected final message shape:

<product>: best price $<price> at <vendor name>.
${base}/s/{session id}
Want me to go ahead and buy it?
`;
