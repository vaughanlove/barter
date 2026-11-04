#!/usr/bin/env node
// pap: a minimal Personal Agent Protocol (PAP) client.
//
// Muse Spark acts as your personal agent on TanStack AI. It reads
// the barter protocol from the site's /llms.txt, searches the web,
// and runs the protocol through server tools: create a session,
// hunt the source call behind a price, prove it with TLSNotary,
// open PAP conversations with both vendor agents, and barter over
// verified proofs until a floor wins.
//
// The source-call hunt is a small Spark transformation agent of its
// own: given a retailer product page, it proposes the lean API call
// that sourced the price (a Shopify product JSON, a product API),
// deterministic code fetches and scores the candidates, and the
// original HTML page is the fallback when no lean call survives.
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
import { chat, toolDefinition, maxIterations } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { z } from "zod";

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

const makeAdapter = (timeout, api = "responses") =>
  openaiCompatibleText(MODEL, {
    name: "meta",
    baseURL: API,
    apiKey: KEY,
    api,
    timeout,
    maxRetries: 0,
  });

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
const state = { sessionId: null, proofs: new Map(), conversations: new Map(), seq: 0, final: null };
const proofId = () => `proof-${++state.seq}`;

// ---------------------------------------------------------------------------
// Source-call hunt: a tiny Spark transformation agent plus deterministic
// scoring. Spark proposes candidate API calls behind a product page; code
// fetches each one, extracts name/quantity/price, and picks the leanest
// candidate that matches. The HTML page itself is always a candidate, so
// the fallback is simply "prove the page".

const fetchPage = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "pap-personal-agent/0.2", Accept: "text/html, application/json" },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const capped = buf.subarray(0, 1_500_000);
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    bytes: buf.length,
    text: capped.toString("utf8"),
    finalUrl: res.url || url,
  };
};

const tokensOf = (s) =>
  String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
const nameScore = (name, productName) => {
  if (!name) return 0;
  const wanted = new Set(tokensOf(productName));
  const hits = tokensOf(name).filter((t) => wanted.has(t)).length;
  return Math.min(30, hits * 10);
};

function scanJson(value, inherited, out, depth) {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) scanJson(item, inherited, out, depth + 1);
    return;
  }
  const name = inherited.name ?? value.title ?? value.name ?? value.product_title;
  const quantity = value.inventory_quantity ?? value.quantity ?? value.stock_quantity ?? inherited.quantity;
  const available = typeof value.available === "boolean" ? value.available : inherited.available;
  const rawPrice = value.price ?? value.current_price ?? value.selling_price ?? value.amount;
  if (rawPrice !== undefined && rawPrice !== null && rawPrice !== "") {
    let price = typeof rawPrice === "string" ? Number(rawPrice.replace(/[^0-9.]/g, "")) : Number(rawPrice);
    if (Number.isFinite(price)) {
      // Shopify integer cents, marked by the sibling cents fields.
      if (Number.isInteger(price) && price > 200 && ("price_min" in value || "price_max" in value || "compare_at_price" in value)) price /= 100;
      out.push({ name: name ?? null, price: Math.round(price * 100) / 100, quantity: quantity ?? null, available: available ?? null });
    }
  }
  for (const child of Object.values(value)) scanJson(child, { name, quantity, available }, out, depth + 1);
}

function extractFromBody(body, productName, expectedPrice) {
  const records = [];
  let isJson = false;
  try {
    scanJson(JSON.parse(body.text), {}, records, 0);
    isJson = records.length > 0 || body.contentType.includes("json");
  } catch { /* HTML below */ }
  if (records.length) {
    const scored = records.map((r) => {
      let score = 40 + nameScore(r.name, productName);
      if (typeof expectedPrice === "number") score += Math.abs(r.price - expectedPrice) < 0.02 ? 40 : -Math.min(30, Math.abs(r.price - expectedPrice));
      if (r.quantity !== null && r.quantity !== undefined) score += 5;
      return { ...r, score };
    }).sort((a, b) => b.score - a.score);
    return { ...scored[0], isJson };
  }
  const plain = body.text.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
  const amounts = [...plain.matchAll(/\$\s*([0-9]+(?:\.[0-9]{2})?)/g)].map((m) => Number(m[1]));
  if (!amounts.length) return null;
  const price = typeof expectedPrice === "number"
    ? amounts.reduce((best, n) => (Math.abs(n - expectedPrice) < Math.abs(best - expectedPrice) ? n : best), amounts[0])
    : amounts[0];
  const title = body.text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
  return { name: title, price, quantity: null, available: null, isJson: false, score: 15 + nameScore(title, productName) };
}

function deterministicCandidates(pageUrl, html) {
  const urls = new Set([pageUrl]);
  try {
    const u = new URL(pageUrl);
    if (/\/products?\//.test(u.pathname)) {
      const clean = u.pathname.replace(/\.(json|js)$/i, "");
      urls.add(`${u.origin}${clean}.json`);
      urls.add(`${u.origin}${clean}.js`);
    }
    if (html) {
      for (const m of html.matchAll(/(?:https?:)?\/\/[^\s"'<>]+?(?:\.json|\.js|\/api\/[^\s"'<>]+)/gi)) {
        try {
          const candidate = new URL(m[0].startsWith("//") ? `https:${m[0]}` : m[0]);
          if (candidate.hostname === u.hostname) urls.add(candidate.toString());
        } catch { /* ignore malformed */ }
      }
      for (const m of html.matchAll(/(?:src|href)="([^"]+(?:\.json|\/api\/)[^"]*)"/gi)) {
        try {
          const candidate = new URL(m[1], pageUrl);
          if (candidate.hostname === u.hostname) urls.add(candidate.toString());
        } catch { /* ignore malformed */ }
      }
    }
  } catch { /* pageUrl itself stays the fallback */ }
  return [...urls].slice(0, 8);
}

async function sparkCandidates(pageUrl, productName, expectedPrice, page) {
  const scriptSrcs = [...(page?.text ?? "").matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]).slice(0, 15);
  const ldJson = [...(page?.text ?? "").matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].slice(0, 1200)).slice(0, 2);
  const priceSnippets = [...(page?.text ?? "").matchAll(/.{60}(?:"price"|\$\s?[0-9]).{60}/gi)].map((m) => m[0]).slice(0, 5);
  try {
    const result = await chat({
      adapter: makeAdapter(30_000, "chat-completions"),
      threadId: `pap-hunt-${Date.now()}`,
      stream: false,
      systemPrompts: [
        "You find the machine-readable source call behind a retailer product page so a TLSNotary proof can attest the smallest useful response. Prefer official product APIs and Shopify product JSON over HTML. Never invent a host: candidates must stay on the page's host. Return only the structured candidates.",
      ],
      messages: [{
        role: "user",
        content: `Product: ${productName}\nPage: ${pageUrl}\nExpected shelf price: ${typeof expectedPrice === "number" ? `$${expectedPrice}` : "unknown"}\nScript sources: ${JSON.stringify(scriptSrcs)}\nJSON-LD: ${JSON.stringify(ldJson)}\nPrice snippets: ${JSON.stringify(priceSnippets)}\n\nPropose up to 5 candidate URLs on the same host that likely return this product's name, quantity, and price as JSON. Kind examples: shopify-json, product-api, page-json. Return ONLY JSON: {"candidates":[{"url":"...","kind":"...","why":"..."}]}`,
      }],
      modelOptions: { max_tokens: 2000, response_format: { type: "json_object" } },
    });
    const parsed = JSON.parse(String(result.text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const host = new URL(pageUrl).hostname;
    return (parsed.candidates ?? [])
      .map((c) => c.url)
      .filter((u) => { try { return new URL(u).hostname === host; } catch { return false; } });
  } catch (err) {
    console.error(`[pap] hunt model unavailable, using deterministic candidates: ${String(err?.message ?? err).slice(0, 120)}`);
    return [];
  }
}

async function findProvablePrice({ url, product: productName, expected_price: expectedPrice }) {
  let page = null;
  try { page = await fetchPage(url); } catch { /* candidates still generated from the URL */ }
  const effectiveUrl = page?.finalUrl ?? url;
  const proposed = await sparkCandidates(effectiveUrl, productName, expectedPrice, page);
  const deterministic = deterministicCandidates(effectiveUrl, page?.text);
  const candidateUrls = [...new Set([...proposed, ...deterministic])].slice(0, 8);
  const evaluated = [];
  for (const candidateUrl of candidateUrls) {
    try {
      const body = candidateUrl === effectiveUrl && page ? page : await fetchPage(candidateUrl);
      if (body.status >= 400) continue;
      const found = extractFromBody(body, productName, expectedPrice);
      if (!found || typeof found.price !== "number" || found.price <= 0) continue;
      // A Spark-proposed API with no product-name overlap is a guess
      // about some other endpoint, unless it follows the known
      // product API pattern for this page.
      if (found.isJson && !deterministic.includes(candidateUrl)
        && nameScore(found.name, productName) < 10
        && !/\/products?\/[^\s]+\.(?:json|js)(?:\?|$)/i.test(candidateUrl)) continue;
      // An API candidate that cannot reproduce the expected price is
      // the wrong product or wrong variant, however lean it is. The
      // HTML page may still carry the right price in text, so it
      // stays eligible as the fallback.
      if (found.isJson && typeof expectedPrice === "number" && Math.abs(found.price - expectedPrice) >= 0.02) continue;
      const leanBonus = Math.max(0, 20 - Math.floor(body.bytes / 50_000));
      evaluated.push({
        url: candidateUrl,
        host: new URL(candidateUrl).hostname,
        path: `${new URL(candidateUrl).pathname}${new URL(candidateUrl).search}`,
        price: found.price,
        product_name: found.name,
        quantity: found.quantity,
        available: found.available,
        bytes: body.bytes,
        source_kind: found.isJson ? "product API" : "HTML page",
        score: found.score + leanBonus + (found.isJson ? 15 : 0),
      });
    } catch { /* candidate rejected silently; the page remains the fallback */ }
  }
  evaluated.sort((a, b) => b.score - a.score);
  const best = evaluated[0];
  if (best && typeof expectedPrice === "number" && Math.abs(best.price - expectedPrice) >= 0.02) {
    return {
      found: false,
      url,
      expected_price: expectedPrice,
      observed_price: best.price,
      note: "Candidates carried a different price than expected (geo storefront or wrong variant). Prove the original page through the sidecar instead.",
    };
  }
  if (!best) {
    return { found: false, url, note: "No candidate carried a readable price. Prove the original page HTML." };
  }
  return {
    found: true,
    url: best.url,
    host: best.host,
    path: best.path,
    price: best.price,
    product_name: best.product_name,
    quantity: best.quantity,
    available: best.available,
    bytes: best.bytes,
    source_kind: best.source_kind,
    candidates_considered: evaluated.map((c) => ({ url: c.url, bytes: c.bytes, price: c.price, kind: c.source_kind })),
  };
}

if (args.includes("--hunt")) {
  const huntUrl = args[args.indexOf("--hunt") + 1];
  const expected = args.includes("--expect") ? Number(args[args.indexOf("--expect") + 1]) : undefined;
  console.log(JSON.stringify(await findProvablePrice({ url: huntUrl, product, expected_price: expected }), null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// PAP tools, executed by TanStack AI's agent loop in order.

const defineTool = (name, description, inputSchema, execute) =>
  toolDefinition({ name, description, inputSchema }).server(async (a) => {
    try {
      const out = await execute(a);
      console.error(`[pap] ${name} -> ${JSON.stringify(out).slice(0, 220)}`);
      return out;
    } catch (err) {
      const out = { error: String(err?.message ?? err) };
      console.error(`[pap] ${name} ERROR ${out.error}`);
      return out;
    }
  });

const tools = [
  defineTool("search_web", "Search the web for retailer product pages. Returns result titles, URLs, and snippets. Use it to find ONE official or retailer product page, then call find_provable_price on it.",
    z.object({ query: z.string() }),
    async (a) => {
      const res = await fetch(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          input: `Search the web for: ${a.query}\nReturn the most relevant retailer or official product pages with prices when visible.`,
          tools: [{ type: "web_search" }],
          include: ["web_search_call.results"],
          max_output_tokens: 2500,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`web search ${res.status}: ${JSON.stringify(data).slice(0, 240)}`);
      const results = [];
      let text = "";
      for (const item of data.output ?? []) {
        if (item.type === "web_search_call" && item.action?.results) {
          for (const r of item.action.results.slice(0, 8)) {
            results.push({ title: r.title, url: r.url, snippet: (r.snippets ?? []).join(" ").slice(0, 300) });
          }
        }
        if (item.type === "message") {
          for (const c of item.content ?? []) if (c.type === "output_text") text += c.text;
        }
      }
      return { results, text: text.slice(0, 2500) };
    }),
  defineTool("create_session", "Create the barter session FIRST, before searching. Returns the session id and url.",
    z.object({ product: z.string(), keyphrase: z.string().optional() }),
    async (a) => {
      const r = await http(`${BASE}/sessions`, {
        product: a.product,
        initiatedBy: "pap-personal-agent",
        ...(a.keyphrase || keyphrase ? { keyphrase: a.keyphrase || keyphrase } : {}),
      });
      state.sessionId = r.id;
      return r;
    }),
  defineTool("find_provable_price", "Hunt the source call behind a retailer product page. A small Spark transformation agent proposes lean API candidates; code fetches and scores them for product name, quantity, and price. Returns the best host/path to prove, preferring a product API over the HTML page. Use this before proving the anchor.",
    z.object({ url: z.string(), product: z.string(), expected_price: z.number().optional() }),
    async (a) => findProvablePrice(a)),
  defineTool("find_price", "Fallback price locator for a retailer page, only when find_provable_price found nothing. Returns price, snippet, confidence.",
    z.object({ url: z.string(), product: z.string() }),
    async (a) => http(`${BASE}/find-price`, { url: a.url, product: a.product })),
  defineTool("prove", "TLSNotary-prove an https response. Returns a proof id to handle it by.",
    z.object({ host: z.string(), path: z.string() }),
    async (a) => {
      const r = await http(`${PROVE}/prove`, { host: a.host, path: a.path });
      const id = proofId();
      state.proofs.set(id, r.presentationB64);
      return { proof_id: id, serverName: r.serverName, chars: r.presentationB64.length };
    }),
  defineTool("store_proof", "Store a proof in the session record at presentation time.",
    z.object({ proof_id: z.string(), host: z.string(), path: z.string(), attested_price: z.number() }),
    async (a) => http(`${BASE}/sessions/${state.sessionId}/proofs`, {
      presentationB64: state.proofs.get(a.proof_id),
      host: a.host,
      path: a.path,
      attestedPrice: a.attested_price,
    })),
  defineTool("open_conversation", "Open a PAP conversation at a vendor with the anchor proof. vendor is basecamp or ridgeline.",
    z.object({ vendor: z.string(), product: z.string(), proof_id: z.string(), session_id: z.string() }),
    async (a) => {
      const base = VENDOR_URLS[a.vendor];
      if (!base) throw new Error(`unknown vendor ${a.vendor}`);
      const r = await http(`${base}/poppy/conversations`, {
        product: a.product,
        presentationB64: state.proofs.get(a.proof_id),
        sessionId: state.sessionId,
      });
      state.conversations.set(r.id, { base, host: new URL(base).hostname, price: r.quote.price });
      return { conversation: r.id, vendor: a.vendor, quote: r.quote };
    }),
  defineTool("prove_quote", "Prove a vendor's current quote from its conversation events endpoint. Returns a proof id.",
    z.object({ conversation: z.string() }),
    async (a) => {
      const c = state.conversations.get(a.conversation);
      if (!c) throw new Error("unknown conversation");
      const path = `/poppy/conversations/${a.conversation}/events`;
      const r = await http(`${PROVE}/prove`, { host: c.host, path });
      const id = proofId();
      state.proofs.set(id, r.presentationB64);
      return { proof_id: id, attested_price: c.price };
    }),
  defineTool("barter", "Present a proof to a conversation. Returns the counter offer.",
    z.object({ conversation: z.string(), proof_id: z.string() }),
    async (a) => {
      const c = state.conversations.get(a.conversation);
      if (!c) throw new Error("unknown conversation");
      const r = await http(`${c.base}/poppy/conversations/${a.conversation}/messages`, {
        type: "barter",
        data: { presentationB64: state.proofs.get(a.proof_id) },
      });
      if (typeof r.data?.price === "number") c.price = r.data.price;
      return r;
    }),
  defineTool("post_event", "Post a session event (quote, barter, best, done, or a plain note under type note).",
    z.object({
      type: z.string(),
      vendor: z.string().optional(),
      price: z.number().optional(),
      url: z.string().optional(),
      note: z.string().optional(),
    }),
    async (a) => {
      const { type, ...fields } = a;
      return http(`${BASE}/sessions/${state.sessionId}/events`, { type, ...fields });
    }),
  defineTool("finish", "End the run: give product, best price, winning vendor. Posts best and done for you.",
    z.object({ product: z.string(), best_price: z.number(), vendor: z.string() }),
    async (a) => {
      await http(`${BASE}/sessions/${state.sessionId}/events`, {
        type: "best", price: a.best_price, vendor: a.vendor,
      });
      await http(`${BASE}/sessions/${state.sessionId}/events`, { type: "done", needsApproval: true });
      state.final = { final_url: `${BASE}/s/${state.sessionId}`, best_price: a.best_price, vendor: a.vendor };
      return state.final;
    }),
];

const spec = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
const instructions = `You are the user's personal shopping agent, running a minimal Personal Agent Protocol (PAP) client from a terminal, on TanStack AI with Muse Spark. Follow this protocol spec exactly:\n\n${spec}\n\nRules for this run: use your tools, never invent prices or proofs. Create the session first. Use search_web to identify ONE retailer product page, then call find_provable_price on that page before proving anything: it hunts the lean source call behind the price. If it returns found, prove its host and path; if not, prove the original page HTML. Alternate barter between the two vendors until one holds at its floor or 3 exchanges pass, then call finish.\n\nWork economically. Find ONE reference price, prove it once, and move straight to the vendors. Do not survey multiple retailers, do not prove backup prices, and do not re-prove the anchor. The only other proofs in the run are fresh proofs of rival vendor quotes, one per barter step. If a page will not prove, try at most one alternative source, then proceed with what you have.`;

let result;
try {
  result = await chat({
    adapter: makeAdapter(90_000),
    threadId: `pap-${Date.now()}`,
    stream: false,
    systemPrompts: [instructions],
    messages: [{
      role: "user",
      content: `Find me the best price on ${product}.${keyphrase ? `\nKeyphrase: ${keyphrase}` : ""}`,
    }],
    tools,
    agentLoopStrategy: maxIterations(40),
    toolExecution: "sequential",
    modelOptions: { max_output_tokens: 4000 },
  });
} catch (err) {
  // Fail fast: surface the upstream error instead of stalling, and
  // leave the session link behind so the partial run is inspectable.
  console.error(`Meta API unavailable: ${String(err?.message ?? err).slice(0, 400)}`);
  if (state.sessionId) console.log(`${BASE}/s/${state.sessionId}`);
  process.exit(1);
}

if (state.final) {
  console.log(`${product}: best price $${state.final.best_price} at ${state.final.vendor}.`);
  console.log(state.final.final_url);
  console.log("Want me to go ahead and buy it?");
  process.exit(0);
}
if (result?.text) {
  const cleaned = result.text.split("\n").filter((line) => !/^\{\s*tool:\s*'[^']+'\s*\}$/.test(line.trim())).join("\n").trim();
  if (cleaned) console.log(cleaned);
}
if (state.sessionId) console.log(`${BASE}/s/${state.sessionId}`);
