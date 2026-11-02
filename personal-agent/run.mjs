#!/usr/bin/env node
// pap: a minimal Personal Agent Protocol (PAP) client.
//
// Muse Spark acts as your personal agent. It reads the barter
// protocol from the site's /llms.txt, then plans with function tools:
// create a session, hunt a price with Meta web search grounding,
// prove it with TLSNotary, open PAP conversations with both vendor
// agents, and barter over verified proofs until a floor wins.
//
// It doubles as the end-to-end smoke test for the whole system:
//   node run.mjs "Carpe deodorant"
//   node run.mjs "Dr. Bronner soap" --keyphrase "cedar lather grove"
//
// Config (env): MODEL_API_KEY (required), BARTER_BASE, PROVE_BASE,
// VENDOR_A, VENDOR_B, VP_MODEL. MODEL_API_KEY is also read from the
// repo-root .env when present.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [join(here, "..", ".env"), join(here, ".env")]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const KEY = process.env.MODEL_API_KEY;
if (!KEY) {
  console.error("MODEL_API_KEY is not set (env or repo .env)");
  process.exit(2);
}
const MODEL = process.env.VP_MODEL ?? "muse-spark-1.3";
const API = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
const BASE = (process.env.BARTER_BASE ?? "https://barter.computer").replace(/\/$/, "");
const PROVE = (process.env.PROVE_BASE ?? "https://prove.barter.computer").replace(/\/$/, "");
const VENDOR_URLS = {
  basecamp: (process.env.VENDOR_A ?? "https://basecamp.barter.computer").replace(/\/$/, ""),
  ridgeline: (process.env.VENDOR_B ?? "https://ridgeline.barter.computer").replace(/\/$/, ""),
};

const args = process.argv.slice(2);
const product = args.find((a) => !a.startsWith("--")) ?? "";
const keyphrase =
  args.includes("--keyphrase") ? args[args.indexOf("--keyphrase") + 1] : undefined;
if (!product) {
  console.error('usage: node run.mjs "<product>" [--keyphrase "three spoken words"]');
  process.exit(2);
}

const http = async (url, body, method = body === undefined ? "GET" : "POST") => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 240)}`);
  return json;
};

// Agent state. Presentations never enter the model context (they are
// tens of KB); the planner handles them by short proof ids.
const state = { sessionId: null, proofs: new Map(), conversations: new Map(), seq: 0 };
const proofId = () => `proof-${++state.seq}`;

const TOOLS = [
  { type: "web_search" },
  ...[
    ["create_session", "Create the barter session FIRST, before searching. Returns the session id and url.", { product: "string", keyphrase: "string (optional)" }, ["product"]],
    ["find_price", "Locate the selling price on a retailer page. Returns price, snippet, confidence.", { url: "string", product: "string" }, ["url", "product"]],
    ["prove", "TLSNotary-prove an https response. Returns a proof id to handle it by.", { host: "string", path: "string" }, ["host", "path"]],
    ["store_proof", "Store a proof in the session record at presentation time.", { proof_id: "string", host: "string", path: "string", attested_price: "number" }, ["proof_id"]],
    ["open_conversation", "Open a PAP conversation at a vendor with the anchor proof. vendor is basecamp or ridgeline.", { vendor: "string", product: "string", proof_id: "string", session_id: "string" }, ["vendor", "product", "proof_id"]],
    ["prove_quote", "Prove a vendor's current quote from its conversation events endpoint. Returns a proof id.", { conversation: "string" }, ["conversation"]],
    ["barter", "Present a proof to a conversation. Returns the counter offer.", { conversation: "string", proof_id: "string" }, ["conversation", "proof_id"]],
    ["post_event", "Post a session event (quote, barter, best, done, or a plain note under type note).", { type: "string", fields: "object (optional)" }, ["type"]],
    ["finish", "End the run: give product, best price, winning vendor. Posts best and done for you.", { product: "string", best_price: "number", vendor: "string" }, ["product", "best_price", "vendor"]],
  ].map(([name, description, props, required]) => ({
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([k, v]) => {
          const [type, ...rest] = v.split(" ");
          return [k, { type: type === "object" ? "object" : type, description: rest.join(" ") }];
        }),
      ),
      required,
      additionalProperties: false,
    },
  })),
];

async function runTool(name, a) {
  switch (name) {
    case "create_session": {
      const r = await http(`${BASE}/sessions`, {
        product: a.product,
        initiatedBy: "pap-personal-agent",
        ...(a.keyphrase || keyphrase ? { keyphrase: a.keyphrase || keyphrase } : {}),
      });
      state.sessionId = r.id;
      return r;
    }
    case "find_price":
      return http(`${BASE}/find-price`, { url: a.url, product: a.product });
    case "prove": {
      const r = await http(`${PROVE}/prove`, { host: a.host, path: a.path });
      const id = proofId();
      state.proofs.set(id, r.presentationB64);
      return { proof_id: id, serverName: r.serverName, chars: r.presentationB64.length };
    }
    case "store_proof":
      return http(`${BASE}/sessions/${state.sessionId}/proofs`, {
        presentationB64: state.proofs.get(a.proof_id),
        host: a.host,
        path: a.path,
        attestedPrice: a.attested_price,
      });
    case "open_conversation": {
      const base = VENDOR_URLS[a.vendor];
      if (!base) throw new Error(`unknown vendor ${a.vendor}`);
      const r = await http(`${base}/poppy/conversations`, {
        product: a.product,
        presentationB64: state.proofs.get(a.proof_id),
        sessionId: state.sessionId,
      });
      state.conversations.set(r.id, { base, host: new URL(base).hostname, price: r.quote.price });
      return { conversation: r.id, vendor: a.vendor, quote: r.quote };
    }
    case "prove_quote": {
      const c = state.conversations.get(a.conversation);
      if (!c) throw new Error("unknown conversation");
      const path = `/poppy/conversations/${a.conversation}/events`;
      const r = await http(`${PROVE}/prove`, { host: c.host, path });
      const id = proofId();
      state.proofs.set(id, r.presentationB64);
      return { proof_id: id, attested_price: c.price };
    }
    case "barter": {
      const c = state.conversations.get(a.conversation);
      if (!c) throw new Error("unknown conversation");
      const r = await http(`${c.base}/poppy/conversations/${a.conversation}/messages`, {
        type: "barter",
        data: { presentationB64: state.proofs.get(a.proof_id) },
      });
      if (typeof r.data?.price === "number") c.price = r.data.price;
      return r;
    }
    case "post_event":
      return http(`${BASE}/sessions/${state.sessionId}/events`, { type: a.type, ...(a.fields ?? {}) });
    case "finish": {
      await http(`${BASE}/sessions/${state.sessionId}/events`, {
        type: "best", price: a.best_price, vendor: a.vendor,
      });
      await http(`${BASE}/sessions/${state.sessionId}/events`, { type: "done", needsApproval: true });
      return { final_url: `${BASE}/s/${state.sessionId}`, best_price: a.best_price, vendor: a.vendor };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const spec = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
const instructions = `You are the user's personal shopping agent, running a minimal Personal Agent Protocol (PAP) client from a terminal. Follow this protocol spec exactly:\n\n${spec}\n\nRules for this run: use your tools, never invent prices or proofs. Prices are handled only through find_price results and proofs. Create the session first. Alternate barter between the two vendors until one holds at its floor or 6 exchanges pass, then call finish.\n\nWork economically. Find ONE reference price, prove it once, and move straight to the vendors. Do not survey multiple retailers, do not prove backup prices, and do not re-prove the anchor. The only other proofs in the run are fresh proofs of rival vendor quotes, one per barter step. If a page will not prove, try at most one alternative source, then proceed with what you have.`;

let input = [
  {
    role: "user",
    content: `Find me the best price on ${product}.${keyphrase ? `\nKeyphrase: ${keyphrase}` : ""}`,
  },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryableStatus = (s) => s === 408 || s === 429 || s >= 500;

// One planner turn, retried briefly in memory. Retrying is safe at
// this boundary: no tool has run for this turn yet, and all protocol
// state (session, proofs, conversations) already lives server-side
// or in `state`. The policy is fail fast: a couple of quick retries
// for a single blip, then surface the upstream error instead of
// stalling a run on a degraded API. Tool calls are deliberately
// not retried here: barter is not idempotent, so a failed tool
// result goes back to the planner as an error it can react to.
async function plannerTurn() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          instructions,
          input,
          tools: TOOLS,
          include: ["web_search_call.results"],
          max_output_tokens: 4000,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      lastError = new Error(`Meta API ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
      if (!retryableStatus(res.status)) throw lastError;
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < 3) {
      const delay = 750 * attempt + Math.floor(Math.random() * 250);
      console.error(`[pap] planner attempt ${attempt} failed (${lastError.message.slice(0, 120)}), retrying in ${Math.round(delay / 100) / 10}s`);
      await sleep(delay);
    }
  }
  throw lastError ?? new Error("planner failed");
}

let finalText = "";
for (let turn = 0; turn < 40; turn++) {
  let data;
  try {
    data = await plannerTurn();
  } catch (err) {
    console.error(`Meta API unavailable after retries: ${err.message}`);
    if (state.sessionId) console.log(`${BASE}/s/${state.sessionId}`);
    process.exit(1);
  }
  const calls = (data.output ?? []).filter((o) => o.type === "function_call");
  const texts = (data.output ?? [])
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .filter((c) => c.type === "output_text")
    .map((c) => c.text);
  if (!calls.length) {
    finalText = texts.join("\n");
    break;
  }
  input = [...input, ...(data.output ?? [])];
  for (const call of calls) {
    let out;
    try {
      const a = JSON.parse(call.arguments || "{}");
      out = await runTool(call.name, a);
      console.error(`[pap] ${call.name} -> ${JSON.stringify(out).slice(0, 160)}`);
    } catch (err) {
      out = { error: String(err?.message ?? err) };
      console.error(`[pap] ${call.name} ERROR ${out.error}`);
    }
    input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(out) });
    if (call.name === "finish" && !out.error) {
      console.log(`${product}: best price $${out.best_price} at ${out.vendor}.`);
      console.log(out.final_url);
      console.log("Want me to go ahead and buy it?");
      process.exit(0);
    }
  }
}
if (finalText) console.log(finalText);
if (state.sessionId) console.log(`${BASE}/s/${state.sessionId}`);
