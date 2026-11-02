import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The test servers are loopback-only; make sure a proxy configured for
// external traffic in the developer environment does not intercept them.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

let apiServer: Server;
let verifierServer: Server;
let baseUrl: string;
let handleApi: typeof import("./api.ts").handleApi;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createConversation(): Promise<string> {
  const created = await postJson("/poppy/conversations", {});
  expect(created.status).toBe(201);
  expect(created.body.quote).toMatchObject({ price: 76, currency: "USD" });
  return String(created.body.id);
}

async function barter(id: string, presentationB64?: string) {
  return postJson(`/poppy/conversations/${id}/messages`, {
    type: "barter",
    data: presentationB64 ? { presentationB64 } : {},
  });
}

async function events(id: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/poppy/conversations/${id}/events`);
  const body = (await response.json()) as { events: { event: string }[] };
  return body.events.map((event) => event.event);
}

beforeAll(async () => {
  verifierServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const { presentationB64 } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        presentationB64?: string;
      };
      const send = (body: unknown) => {
        if (!res.destroyed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        }
      };
      if (presentationB64 === "quoted-low") {
        send({ valid: true, received: '{"product":{"variants":[{"price":"65.00"}]}}' });
      } else if (presentationB64?.startsWith("price-")) {
        send({ valid: true, received: `{"price": ${presentationB64.slice(6)}}` });
      } else if (presentationB64 === "valid-low") {
        send({ valid: true, received: 'HTTP/1.1 200 OK\r\n\r\n{"price": 65}' });
      } else if (presentationB64 === "valid-floor") {
        send({ valid: true, received: 'HTTP/1.1 200 OK\r\n\r\n{"price": 10}' });
      } else if (presentationB64 === "slow") {
        res.on("error", () => undefined);
        setTimeout(() => send({ valid: true, received: '{"price": 1}' }), 300);
      } else {
        send({ valid: false });
      }
    });
  });
  const verifierPort = await listen(verifierServer);

  process.env.VENDOR_NAME = "Test Vendor";
  process.env.VENDOR_PRICE = "76";
  process.env.VENDOR_FLOOR = "60";
  process.env.VENDOR_UNDERCUT = "3";
  process.env.VERIFIER_URL = `http://127.0.0.1:${verifierPort}/verify`;
  process.env.VERIFIER_TIMEOUT_MS = "50";

  ({ handleApi } = await import("./api.ts"));
  apiServer = createServer((req, res) => {
    void handleApi(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  const apiPort = await listen(apiServer);
  baseUrl = `http://127.0.0.1:${apiPort}`;
});

afterAll(async () => {
  await close(apiServer);
  await close(verifierServer);
});

describe("discovery", () => {
  it("serves per-instance poppy.json matching the serving host", async () => {
    const response = await fetch(`${baseUrl}/.well-known/poppy.json`);
    const body = (await response.json()) as Record<string, unknown>;
    const host = new URL(baseUrl).host;
    expect(body.protocol_version).toBe("0.3");
    expect(body.organization).toMatchObject({ domain: host });
    const agent = body.agent as { protocols: { endpoint: string }[] };
    expect(agent.protocols[0].endpoint).toBe(`http://${host}/poppy/conversations`);
  });
});

describe("bartering tactics", () => {
  it("publishes the live tactics for this vendor instance", async () => {
    process.env.VENDOR_POLICY_TEXT = "Move boldly, but only on proof.";
    process.env.VENDOR_MARKUP_PCT = "2";
    process.env.VENDOR_FLOOR_PCT = "12";
    process.env.VENDOR_UNDERCUT_MODE = "percent";
    process.env.VENDOR_UNDERCUT_PCT = "5";
    process.env.VENDOR_MONTHLY_POOL_USD = "100000";

    const response = await fetch(`${baseUrl}/api/tactics`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      vendor: "Test Vendor",
      policy: "Move boldly, but only on proof.",
      discountCeilingPct: 12,
      monthlyPromoPoolUsd: 100000,
    });
    expect(body.opening).toMatchObject({ markupPct: 2 });
    expect(body.counterStyle).toMatchObject({ mode: "percent", pct: 5 });
    const business = body.business as Record<string, unknown>;
    expect(business.stockCoverMonths).toBeGreaterThanOrEqual(2.6);
    expect(business.restockCycleWeeks).toBe(4);
    expect(typeof business.stockedDaysAgo).toBe("number");
    expect(typeof business.daysToRestock).toBe("number");
    expect(typeof business.why).toBe("string");
  });

  it("records why a counter was made and which decision path made it", async () => {
    process.env.VENDOR_MARKUP_PCT = "5";
    process.env.VENDOR_FLOOR_PCT = "8";
    process.env.VENDOR_UNDERCUT_MODE = "penny";
    delete process.env.MODEL_API_KEY;
    const created = await postJson("/poppy/conversations", {
      product: "Trace Soap",
      presentationB64: "price-20",
    });
    const id = String(created.body.id);

    await barter(id, "price-19");
    const response = await fetch(`${baseUrl}/poppy/conversations/${id}/events`);
    const body = (await response.json()) as { events: Record<string, unknown>[] };
    const counter = body.events.find((event) => event.event === "vendor.offer.countered");

    expect(counter).toMatchObject({
      vendor: "Test Vendor",
      product: "Trace Soap",
      reason: "verified lower offer",
      source: "deterministic fallback",
    });
    expect(typeof counter?.stockUnits).toBe("number");
    expect(counter?.stockPosture).toMatch(/stock/);
    expect(counter?.discountUsedPct).toBeGreaterThan(0);
    expect(typeof counter?.headroomToCeilingPct).toBe("number");
  });
});

describe("proof-anchored mirror pricing", () => {
  async function anchored(): Promise<string> {
    process.env.VENDOR_MARKUP_PCT = "5";
    process.env.VENDOR_FLOOR_PCT = "8";
    process.env.VENDOR_UNDERCUT_MODE = "penny";
    const created = await postJson("/poppy/conversations", {
      product: "Deodorant",
      presentationB64: "price-20",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ product: "Deodorant", sku: "deodorant" });
    expect(created.body.quote).toMatchObject({ price: 21 });
    return String(created.body.id);
  }

  it("derives the ask from the attested anchor price", async () => {
    await anchored();
  });

  it("steps down toward its discount ceiling, then stops at it", async () => {
    const id = await anchored();

    const beaten = await barter(id, "price-20.4");
    expect(beaten.body).toMatchObject({
      type: "offer",
      data: { price: 19.95, floorReached: false },
    });

    const floored = await barter(id, "price-10");
    expect(floored.body).toMatchObject({
      type: "offer",
      data: { price: 18.4, floorReached: true },
    });
  });
});

describe("proof-gated barter", () => {
  it("rejects barter without a presentation and keeps the quote", async () => {
    const id = await createConversation();

    const result = await barter(id);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      type: "rejected",
      data: { price: 76, reason: "proof required to barter" },
    });
    expect(await events(id)).toContain("vendor.proof.rejected");
  });

  it("rejects an invalid presentation", async () => {
    const id = await createConversation();

    const result = await barter(id, "not-a-presentation");

    expect(result.body).toMatchObject({
      type: "rejected",
      data: { price: 76, reason: "proof did not verify" },
    });
    expect(await events(id)).toEqual(
      expect.arrayContaining(["vendor.proof.received", "vendor.proof.rejected"]),
    );
  });

  it("rejects when the verifier exceeds the configured timeout", async () => {
    const id = await createConversation();
    const started = Date.now();

    const result = await barter(id, "slow");

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.body).toMatchObject({
      type: "rejected",
      data: { price: 76, reason: "proof did not verify" },
    });
  });

  it("reads a quoted string price from the verified transcript (Shopify shape)", async () => {
    const id = await createConversation();

    const conceded = await barter(id, "quoted-low");
    expect(conceded.body).toMatchObject({
      type: "offer",
      data: { price: 62, floorReached: false },
    });
  });

  it("concedes only after a verified lower price and stops at the floor", async () => {
    const id = await createConversation();

    const conceded = await barter(id, "valid-low");
    expect(conceded.body).toMatchObject({
      type: "offer",
      data: { price: 62, floorReached: false },
    });

    const floored = await barter(id, "valid-floor");
    expect(floored.body).toMatchObject({
      type: "offer",
      data: { price: 60, floorReached: true },
    });
    expect(await events(id)).toEqual(
      expect.arrayContaining([
        "vendor.proof.verified",
        "vendor.offer.countered",
        "vendor.offer.floor",
      ]),
    );
  });
});
