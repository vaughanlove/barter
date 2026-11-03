# pap: a minimal Personal Agent Protocol client

`pap` is a small Muse clone for one job: acting as your personal
agent under the Personal Agent Protocol (PAP) that
[barter.computer](https://barter.computer) teaches in its
[`/llms.txt`](https://barter.computer/llms.txt).

It exists for two audiences:

- **Testing.** A programmatic personal agent you can point at a local
  or production deployment and run the whole barter flow end to end:
  session, web hunt, TLSNotary proof, vendor barter, best offer,
  approval gate. If `pap` can finish a run, the system works.
- **Judges and the cautious.** If you do not want to hook your own
  agent up to an unfamiliar protocol, install this reference client
  instead. It is a few hundred lines, reads the protocol from the
  site itself, and does exactly what the spec says, nothing else.

## Run it

```sh
cd personal-agent
pnpm install
MODEL_API_KEY=... node run.mjs "Carpe deodorant"
node run.mjs "Dr. Bronner soap" --keyphrase "cedar lather grove"
```

`MODEL_API_KEY` is a Meta Model API key. It is also read from the
repo-root `.env` when present. Tool calls and key steps are logged
to stderr; the final best offer, the plain session link, and the
approval question are printed to stdout.

## Point it at your own deployment

All endpoints come from the environment, so the same binary smoke
tests a laptop build or production:

| Variable | Default |
|---|---|
| `BARTER_BASE` | `https://barter.computer` |
| `PROVE_BASE` | `https://prove.barter.computer` |
| `VENDOR_A` | `https://basecamp.barter.computer` |
| `VENDOR_B` | `https://ridgeline.barter.computer` |
| `VP_MODEL` | `muse-spark-1.3` |
| `META_API_BASE_URL` | `https://api.meta.ai/v1` |

## How it works

Muse Spark plans with tools on TanStack AI; deterministic code
executes them. The planner gets web search plus a small tool set
that mirrors the protocol: `create_session`, `search_web`,
`find_provable_price`, `find_price`, `prove`, `store_proof`,
`open_conversation`, `prove_quote`, `barter`, `post_event`,
`finish`. Proofs are handled by short ids, never pasted into the
model context. Prices and proofs only ever move through tool
results, and the run ends at an approval question. Nothing is
bought.

`find_provable_price` is the source-call hunt: a tiny Spark
transformation agent proposes the lean API call that sourced a
retailer price (a Shopify product JSON, for example), code
fetches and scores candidates for name, quantity, and price, and
the HTML page itself is the fallback when no lean call survives.
TLSNotary proves small API responses far better than full pages,
so this is the step that makes proving practical. Debug it with
`node run.mjs "<product>" --hunt <product page URL>` and an
optional `--expect <price>`.
