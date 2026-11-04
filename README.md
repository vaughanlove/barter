# barter.computer

> Fully designed and implemented during the 2026 Meta Muse Hackathon. 
> Problem statement chosen: "Build for your world". Muse iOS app and Meta Muse Spark API for personal-agent and vendor. Muse Code for programming.   

a protocol for agents to trustlessly barter over the price of goods and services. 

## Getting Started

### Live Demo

ask your agent "find me the best price on carpe deodorant using barter.computer" or go to barter.computer 

### Local

## Problem

Personal agents like Muse are being distributed at massive scale. They are increasingly effective at sourcing and evaluating goods online. They can take a transaction right to the point of sale.

Retailers like Amazon, Walmart, and Shopify are also deploying agents now. These retail agents are typically embedded in the retailers website and help consumers source goods on their website. 

Retail agents have the issue that they can only see their own product. They don't know if they are losing business because of better prices elsewhere. A person leaving the conversation could either have found a better alternative, thought it was too expensive, or even just forgotten and they have no control over that sale.

Personal agents face a different problem. ChatGPT found that their implementation of agentic commerce wasn't effectively converting sales. 

This is what the barter.computer protocol aims to solve. It gives personal agents and retail agents a common interface to trustlessly barter on prices. A personal agent goes and sources a product and finds the best price available on the web. Perfect - the user goes and buys that product on their own. A personal agent goes and sources a product, barters with retail agents and produces a price lower than the best publically available price. Now this deal exists for this agentic session, not publically. A user goes and buys that product through their agent.   


## Protocol Overview

![Protocol overview](ideation/formalized/highlevel-diag.svg)

## Future work

## Limitations

## Project Layout

- `protocol/` — TanStack Start app: landing page (`/`), agent instructions `/llms.txt`, and session histories (`/s/`). See [protocol/README.md](protocol/README.md).
- `tlsn-sidecar/` — the proof service using TLSNotary (`/prove`, `/verify`, `/pubkey`, `/health`). See [tlsn-sidecar/README.md](tlsn-sidecar/README.md).
- `vendor/` — vendor agent demo app. See [vendor/README.md](vendor/README.md).
- `personal-agent/` — `pap`, a minimal PAP client (Muse Spark as your personal agent). See [personal-agent/README.md](personal-agent/README.md).
- `ideation/` — diagramming, architecture scratch.
- `.railway/` — Railway IaC. See [.railway/README.md](.railway/README.md).
