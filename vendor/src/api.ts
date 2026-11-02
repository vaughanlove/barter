// Vendor agent API (PAP-lite, modeled on Cliffside Retail's PAP 0.3 demo;
// see README for the kept/omitted subset).
//
//   GET  /api/catalog                          -> products + asking prices
//   GET  /api/products/{sku}/inventory         -> Cliffside-shaped stock + price
//   GET  /openapi.json                         -> minimal API doc for agents
//   POST /poppy/conversations                  -> open conversation, get quote
//   POST /poppy/conversations/{id}/messages    -> quote / barter (proof-gated)
//   GET  /poppy/conversations/{id}/events      -> conversation event list
//   GET  /health
//
// Barter rule: a message carrying a TLSNotary presentation is verified
// (via VERIFIER_URL, the vendor's own verifier) and only a verified lower
// price triggers the discount policy. Everything is emitted via telemetry.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { anchoredAsk, anchoredFloor, beat, decide, type PolicyDecision } from "./discount_policy.ts";
import { proposeCounter } from "./llm_policy.ts";
import { DEMO_SKU, getProduct, listProducts } from "./inventory.ts";

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Barter Dummy Vendor API", version: "0.1" },
  paths: {
    "/api/products/{sku}/inventory": {
      get: {
        operationId: "getInventory",
        summary: "How many of a product are in stock, by size. Works signed out.",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" } }],
      },
    },
  },
};
import { log } from "./telemetry.ts";

interface Conversation {
  id: string;
  sku: string;
  price: number;
  product?: string;
  anchor?: number;
  floorPrice?: number;
  ask?: number;
  rounds?: number;
  sessionId?: string;
  events: Record<string, unknown>[];
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

const conversations = new Map<string, Conversation>();
const verifierUrl = (process.env.VERIFIER_URL ?? "http://localhost:8080/verify").replace(/\/$/, "");
const verifierTimeoutMs = (() => {
  const parsed = Number(process.env.VERIFIER_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();
const vendorName = process.env.VENDOR_NAME ?? "Barter Dummy Vendor";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function emit(
  conv: Conversation,
  event: string,
  attrs: Record<string, string | number | boolean>,
): void {
  const record = {
    ts: new Date().toISOString(),
    event,
    conversationId: conv.id,
    sku: conv.sku,
    ...attrs,
  };
  conv.events.push(record);
  log(event, {
    conversationId: conv.id,
    sku: conv.sku,
    ...(conv.sessionId ? { sessionId: conv.sessionId } : {}),
    ...attrs,
  });
}

// Total discount granted against the monthly promo pool (in-memory,
// resets with the process: demo scope).
let promoPoolSpent = 0;

// Anchored negotiation: Spark proposes in the company's own style,
// the deterministic guard disposes. No proposal survives below the
// floor, at/above the attested price, or past the monthly pool.
async function decideAnchored(conv: Conversation, attested: number): Promise<PolicyDecision> {
  const floor = conv.floorPrice ?? 0;
  const fallback = beat(conv.price, attested, floor);
  if (fallback.action === "reject") return fallback;
  conv.rounds = (conv.rounds ?? 0) + 1;
  const proposal = await proposeCounter({
    product: conv.product ?? conv.sku,
    current: conv.price,
    attested,
    floor,
    round: conv.rounds,
    policyText: process.env.VENDOR_POLICY_TEXT ?? "",
  });
  if (!proposal) return fallback;
  let price = proposal.price;
  if (!(price < attested) || price >= conv.price) return fallback;
  if (price < floor) {
    return { action: "floor", newPrice: floor, reason: "best possible price reached" };
  }
  const poolCap = Number(process.env.VENDOR_MONTHLY_POOL_USD ?? 0);
  if (poolCap > 0) {
    const remaining = poolCap - promoPoolSpent;
    if (remaining <= 0) {
      return { action: "reject", newPrice: conv.price, reason: "monthly promo pool exhausted" };
    }
    if (conv.price - price > remaining) {
      const funded = Math.round((conv.price - remaining) * 100) / 100;
      if (funded < attested && funded >= floor && funded < conv.price) price = funded;
      else return { action: "reject", newPrice: conv.price, reason: "monthly promo pool exhausted" };
    }
  }
  return {
    action: price <= floor ? "floor" : "concede",
    newPrice: price,
    reason: proposal.style || "verified lower offer",
  };
}

// Extract the attested price from the *verified* transcript text. The price
// is only trusted because it came out of presentation verification.
function attestedPrice(verified: Record<string, unknown>): number | null {
  const received = typeof verified.received === "string" ? verified.received : "";
  // Quoted decimal dollars first: "price":"19.95" (Shopify .json).
  const quoted = received.match(/"price"\s*:\s*"([0-9]+(?:\.[0-9]+)?)"/);
  if (quoted) return Number(quoted[1]);
  const bare = received.match(/"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  // Shopify .js prices are integer cents ("price":1995 = $19.95), marked
  // by the sibling cents fields. A bare integer price there is cents.
  if (bare && !bare[1].includes(".") && /"(price_min|price_max|compare_at_price)"/.test(received)) {
    return Number(bare[1]) / 100;
  }
  const dollar = received.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (dollar) return Number(dollar[1]);
  return bare ? Number(bare[1]) : null;
}

async function verifyPresentation(
  presentationB64: string,
): Promise<{ valid: boolean; price: number | null }> {
  try {
    const res = await fetch(verifierUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presentationB64 }),
      signal: AbortSignal.timeout(verifierTimeoutMs),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (body.valid !== true) return { valid: false, price: null };
    return { valid: true, price: attestedPrice(body) };
  } catch {
    return { valid: false, price: null };
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true, vendor: vendorName });
      return true;
    }
    if (req.method === "GET" && path === "/.well-known/poppy.json") {
      // Per-instance discovery: domain is the host serving this document
      // (PAP: organization.domain must match), name/endpoint derive from it,
      // so one build serves every vendor copy unchanged.
      const host = req.headers.host ?? "localhost";
      const proto =
        req.headers["x-forwarded-proto"] ??
        (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
      send(res, 200, {
        protocol_version: "0.3",
        organization: { name: vendorName, domain: host },
        agent: {
          protocols: [{ type: "poppy", endpoint: `${proto}://${host}/poppy/conversations` }],
        },
        apis: [
          {
            type: "openapi",
            url: `${proto}://${host}/openapi.json`,
            description: "Inventory (signed out)",
          },
        ],
      });
      return true;
    }
    if (req.method === "GET" && path === "/api/catalog") {
      send(res, 200, { vendor: vendorName, products: listProducts() });
      return true;
    }
    if (req.method === "GET" && path === "/openapi.json") {
      send(res, 200, OPENAPI);
      return true;
    }
    const invMatch = path.match(/^\/api\/products\/([a-z0-9-]+)\/inventory$/);
    if (req.method === "GET" && invMatch) {
      const product = getProduct(invMatch[1]);
      if (!product) {
        send(res, 404, {
          error: "not_found",
          error_description: `no product with SKU ${invMatch[1]}`,
        });
        return true;
      }
      // Cliffside Inventory shape: { sku, name, price, sizes[] }. Signed out.
      send(res, 200, {
        sku: product.sku,
        name: product.name,
        price: product.price,
        sizes: product.sizes,
      });
      return true;
    }

    if (req.method === "POST" && path === "/poppy/conversations") {
      const body = await readJson(req);
      const productName = typeof body.product === "string" ? body.product.trim() : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      const anchorB64 = typeof body.presentationB64 === "string" ? body.presentationB64 : "";
      // Proof-anchored mirror: a verified online price for the typed
      // product sets this vendor's ask and hidden floor. No anchor proof,
      // no mirrored quote — fall through to the legacy catalog quote.
      if (productName && anchorB64) {
        const { valid, price: anchor } = await verifyPresentation(anchorB64);
        if (!valid || anchor === null) {
          send(res, 422, { error: "anchor proof did not verify" });
          return true;
        }
        const conv: Conversation = {
          id: randomBytes(4).toString("hex"),
          sku: slugify(productName),
          product: productName,
          anchor,
          floorPrice: anchoredFloor(anchor),
          price: anchoredAsk(anchor),
          ask: anchoredAsk(anchor),
          rounds: 0,
          sessionId,
          events: [],
        };
        conversations.set(conv.id, conv);
        emit(conv, "vendor.conversation.created", { price: conv.price, anchor });
        emit(conv, "vendor.quote.issued", { price: conv.price, anchor });
        send(res, 201, {
          id: conv.id,
          vendor: vendorName,
          sku: conv.sku,
          product: conv.product,
          quote: { price: conv.price, currency: "USD" },
        });
        return true;
      }
      const sku = typeof body.sku === "string" ? body.sku : DEMO_SKU;
      const product = getProduct(sku);
      if (!product) {
        send(res, 404, { error: `unknown sku ${sku}` });
        return true;
      }
      const conv: Conversation = {
        id: randomBytes(4).toString("hex"),
        sku,
        price: product.price,
        sessionId,
        events: [],
      };
      conversations.set(conv.id, conv);
      emit(conv, "vendor.conversation.created", { price: conv.price });
      emit(conv, "vendor.quote.issued", { price: conv.price });
      send(res, 201, {
        id: conv.id,
        vendor: vendorName,
        sku,
        quote: { price: conv.price, currency: product.currency },
      });
      return true;
    }

    const msgMatch = path.match(/^\/poppy\/conversations\/([a-z0-9]+)\/messages$/);
    if (req.method === "POST" && msgMatch) {
      const conv = conversations.get(msgMatch[1]);
      if (!conv) {
        send(res, 404, { error: "unknown conversation" });
        return true;
      }
      const body = await readJson(req);
      const data = (body.data ?? {}) as Record<string, unknown>;

      if (body.type === "quote") {
        emit(conv, "vendor.quote.issued", { price: conv.price });
        send(res, 200, { type: "offer", data: { price: conv.price } });
        return true;
      }

      if (body.type === "barter") {
        const presentationB64 =
          typeof data.presentationB64 === "string" ? data.presentationB64 : "";
        if (!presentationB64) {
          emit(conv, "vendor.proof.rejected", {
            price: conv.price,
            reason: "missing presentation",
          });
          send(res, 200, {
            type: "rejected",
            data: { price: conv.price, reason: "proof required to barter" },
          });
          return true;
        }
        emit(conv, "vendor.proof.received", { price: conv.price });
        const { valid, price: attested } = await verifyPresentation(presentationB64);
        if (!valid || attested === null) {
          emit(conv, "vendor.proof.rejected", { price: conv.price, reason: "verification failed" });
          send(res, 200, {
            type: "rejected",
            data: { price: conv.price, reason: "proof did not verify" },
          });
          return true;
        }
        emit(conv, "vendor.proof.verified", { price: conv.price, attestedPrice: attested });
        const decision =
          conv.floorPrice !== undefined
            ? await decideAnchored(conv, attested)
            : decide(conv.price, attested);
        if (conv.floorPrice !== undefined && decision.action !== "reject") {
          promoPoolSpent += Math.max(0, conv.price - decision.newPrice);
        }
        if (decision.action === "reject") {
          emit(conv, "vendor.offer.held", { price: conv.price, attestedPrice: attested });
          send(res, 200, { type: "offer", data: { price: conv.price, note: decision.reason } });
          return true;
        }
        conv.price = decision.newPrice;
        emit(conv, decision.action === "floor" ? "vendor.offer.floor" : "vendor.offer.countered", {
          price: conv.price,
          attestedPrice: attested,
        });
        send(res, 200, {
          type: "offer",
          data: {
            price: conv.price,
            note: decision.reason,
            floorReached: decision.action === "floor",
          },
        });
        return true;
      }

      send(res, 400, { error: `unsupported message type ${String(body.type)}` });
      return true;
    }

    const evMatch = path.match(/^\/poppy\/conversations\/([a-z0-9]+)\/events$/);
    if (req.method === "GET" && evMatch) {
      const conv = conversations.get(evMatch[1]);
      if (!conv) {
        send(res, 404, { error: "unknown conversation" });
        return true;
      }
      send(res, 200, { id: conv.id, price: conv.price, events: conv.events });
      return true;
    }
    return false;
  } catch {
    send(res, 400, { error: "bad request" });
    return true;
  }
}
