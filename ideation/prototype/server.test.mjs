import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "barter-landing-"));
process.env.BARTER_DB_PATH = join(dir, "barter.db");
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = process.env.NO_PROXY;

const { server } = await import("./server.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const getWithHost = (path, host) =>
  new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1", () => {
      socket.end(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head] = text.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), body: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) });
    });
  });

test("apex serves minimal Poppy discovery for the requested domain", async () => {
  const response = await fetch(`${base}/.well-known/poppy.json`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    protocol_version: "0.1",
    organization: { name: "Barter", domain: "127.0.0.1" },
    web: {},
  });

  const www = await getWithHost("/.well-known/poppy.json", "www.barter.computer");
  assert.equal(www.status, 200);
  assert.equal(www.body.organization.domain, "barter.computer");

  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /Simulated vendors: <a href="https:\/\/basecamp\.barter\.computer">Basecamp Supply<\/a>/);
  assert.match(home, /<a href="https:\/\/ridgeline\.barter\.computer">Ridgeline Outfitters<\/a>/);
  assert.match(home, /href="\/how-it-works"/);
  assert.match(home, /href="\/s\/A3CECA"/);

  const how = await (await fetch(`${base}/how-it-works`)).text();
  assert.match(how, /How the personal agent follows the protocol/);
  assert.match(how, /How the vendors are set up/);
  assert.match(how, /What a proof does and does not say/);
  assert.match(how, /Basecamp Supply/);
  assert.match(how, /Ridgeline Outfitters/);
});

test("typed product creates a persisted session with a recap", async () => {
  const created = await post("/sessions", { product: "Deodorant", budget: 25 });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  assert.equal((await post(`/sessions/${id}/events`, { type: "quote", vendor: "Ridgeline Outfitters", url: "https://ridgeline.example", price: 20.4 })).status, 201);
  const proof = await post(`/sessions/${id}/proofs`, {
    presentationB64: "aGVsbG8td29ybGQ=",
    host: "www.target.com",
    path: "/p/deodorant",
    attestedPrice: 20,
  });
  assert.equal(proof.status, 201);
  assert.equal((await post(`/sessions/${id}/events`, { type: "best", price: 19.37, vendor: "Ridgeline Outfitters" })).status, 201);
  assert.equal((await post(`/sessions/${id}/events`, { type: "done", needsApproval: true })).status, 201);

  const html = await (await fetch(`${base}/s/${id}`)).text();
  assert.match(html, /Deodorant/);
  assert.match(html, /\$19\.37/);
  assert.match(html, /presented/);
  assert.match(html, /www\.target\.com/);
  assert.match(html, /Ridgeline Outfitters/);

  const listed = await (await fetch(`${base}/api/sessions`)).json();
  const mine = listed.sessions.find((s) => s.id === id);
  assert.equal(mine.status, "done");
  assert.ok(mine.logs.some((l) => l.event === "quote"));
});

test("landing issues a keyphrase, polls for it, and follows it", async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /find me the best price on/);
  assert.match(home, /Keyphrase: [a-z]+ [a-z]+ [a-z]+/);
  assert.ok(!/Keyphrase: [a-z]+-/.test(home), "keyphrase must be spoken words, no hyphens");
  assert.match(home, /\/api\/handoff/);
  assert.match(home, /name="phrase"/);
  assert.ok(!home.includes('name="product"'), "homepage must not create sessions");

  const created = await post("/sessions", {
    product: "Trail Shoes",
    initiatedBy: "muse-agent",
    keyphrase: "velvet otter meadow",
  });
  const { id, keyphrase } = await created.json();
  assert.equal(keyphrase, "velvet otter meadow");

  const found = await fetch(`${base}/api/keyphrase/velvet%20otter%20meadow`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).id, id);
  // However the agent mangles separators, the same session is found.
  assert.equal((await fetch(`${base}/api/keyphrase/VELVET-Otter, meadow 27`)).status, 200);
  assert.equal((await fetch(`${base}/api/keyphrase/nope nope nope`)).status, 404);

  const followed = await fetch(`${base}/follow?phrase=velvet otter meadow`, { redirect: "manual" });
  assert.equal(followed.status, 303);
  assert.equal(followed.headers.get("location"), `/s/${id}`);
  const missed = await fetch(`${base}/follow?phrase=nope nope nope`, { redirect: "manual" });
  assert.equal(missed.headers.get("location"), "/?missing=1");
});

test("handoff follows the newest session even without a keyphrase", async () => {
  const since = Date.now() - 1000;
  const created = await post("/sessions", { product: "Phraseless Gadget", initiatedBy: "muse-agent" });
  const { id } = await created.json();

  const viaLatest = await fetch(`${base}/api/handoff?phrase=unclaimed words here&since=${since}`);
  assert.equal(viaLatest.status, 200);
  assert.deepEqual(await viaLatest.json(), { id, url: `/s/${id}`, via: "latest" });

  const tooEarly = await fetch(`${base}/api/handoff?phrase=unclaimed words here&since=${Date.now() + 60000}`);
  assert.equal(tooEarly.status, 404);

  const viaPhrase = await fetch(`${base}/api/handoff?phrase=velvet otter meadow&since=${since}`);
  assert.equal((await viaPhrase.json()).via, "keyphrase");
});

test("session page shows each barter step once despite dual reporting", async () => {
  const created = await post("/sessions", { product: "Dedup Soap" });
  const { id } = await created.json();
  const ev = (type, body = {}) => post(`/sessions/${id}/events`, { type, ...body });

  // Same facts arrive twice: once from the agent, once from vendor OTEL.
  await post(`/sessions/${id}/proofs`, {
    presentationB64: "aGVsbG8td29ybGQ=",
    host: "ridgeline.barter.computer",
    attestedPrice: 17.53,
  });
  await ev("vendor.conversation.created", { price: 18.05 });
  await ev("vendor.quote.issued", { price: 18.05 });
  await ev("quote", { vendor: "basecamp", price: 18.05 });
  await ev("vendor.proof.received", { price: 18.05 });
  await ev("vendor.proof.verified", { price: 18.05, attestedPrice: 17.53 });
  await ev("vendor.offer.countered", { price: 17.15, attestedPrice: 17.53 });
  await ev("best", { vendor: "basecamp", price: 17.15 });
  await ev("done", { needsApproval: true });

  const html = await (await fetch(`${base}/s/${id}`)).text();
  const rows = (t) => (html.match(new RegExp(`<div class="trow" data-type="${t}"`, "g")) ?? []).length;
  assert.equal(rows("quote"), 1);
  assert.equal(rows("proof"), 1);
  assert.equal(rows("vendor.offer.countered"), 1);
  assert.equal(rows("vendor.conversation.created"), 0);
  assert.equal(rows("vendor.quote.issued"), 0);
  assert.equal(rows("vendor.proof.received"), 0);
  assert.equal(rows("vendor.proof.verified"), 0);
  assert.match(html, /verified · countered/, "verdict survives as the proof row badge");
  const tree = html.slice(html.indexOf('id="tchildren">'), html.indexOf("<script>"));
  assert.ok(!tree.includes("up $"), "vendor old price must not read as an increase");
  assert.match(tree, /down \$0\.90/);
});

test("session actions can be inspected with the vendor decision trace", async () => {
  const created = await post("/sessions", { product: "Trace Beans" });
  const { id } = await created.json();
  await post(`/sessions/${id}/proofs`, {
    presentationB64: "aGVsbG8td29ybGQ=",
    host: "ridgeline.barter.computer",
    attestedPrice: 2,
  });
  await post("/v1/logs", {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "Ridgeline Outfitters" } }] },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: "sessionId", value: { stringValue: id } },
            { key: "event.name", value: { stringValue: "vendor.offer.countered" } },
            { key: "price", value: { doubleValue: 1.96 } },
            { key: "attestedPrice", value: { doubleValue: 2 } },
            { key: "reason", value: { stringValue: "penny under, holding firm" } },
            { key: "source", value: { stringValue: "deterministic fallback" } },
            { key: "stockUnits", value: { doubleValue: 148 } },
            { key: "stockPosture", value: { stringValue: "deep stock" } },
            { key: "discountUsedPct", value: { doubleValue: 4.8 } },
            { key: "headroomToCeilingPct", value: { doubleValue: 6.4 } },
            { key: "promoPoolRemainingPct", value: { doubleValue: 91 } },
          ],
        }],
      }],
    }],
  });

  const html = await (await fetch(`${base}/s/${id}`)).text();
  assert.ok(!html.includes("Replay actions"));
  assert.match(html, /class="tdetail"/);
  assert.match(html, /Actor: Ridgeline Outfitters/);
  assert.match(html, /Decision note: penny under, holding firm/);
  assert.match(html, /Decision source: deterministic fallback/);
  assert.match(html, /Stock picture: about 148 units \(deep stock\)/);
  assert.match(html, /Discount picture: 4\.8% of the opening ask used/);
  assert.match(html, /Promo pool: 91% remaining/);
  assert.match(html, /no natural-language message is recorded/);
});

test("live stream receives proof and vendor steps, not just agent events", async () => {
  const created = await post("/sessions", { product: "Live Beans" });
  const { id } = await created.json();

  const ctl = new AbortController();
  let received = "";
  const pump = (async () => {
    try {
      // SSE headers only flush with the first event, so connect in the
      // background and post the steps before reading.
      const stream = await fetch(`${base}/sessions/${id}/stream?live=1`, { signal: ctl.signal });
      const reader = stream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    } catch {}
  })();
  await new Promise((r) => setTimeout(r, 300));

  await post(`/sessions/${id}/proofs`, {
    presentationB64: "aGVsbG8td29ybGQ=",
    host: "ridgeline.barter.computer",
    attestedPrice: 2,
  });
  await post("/v1/logs", {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: "sessionId", value: { stringValue: id } },
            { key: "event.name", value: { stringValue: "vendor.offer.countered" } },
            { key: "price", value: { doubleValue: 1.96 } },
            { key: "attestedPrice", value: { doubleValue: 2 } },
          ],
        }],
      }],
    }],
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(received.includes('"type":"proof"') && received.includes("vendor.offer.countered"))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ctl.abort();
  await pump;
  assert.match(received, /"type":"proof"/);
  assert.match(received, /vendor\.offer\.countered/);
});

test("products are escaped on the session page", async () => {

  const created = await post("/sessions", { product: '"><script>alert(1)</script>' });
  const { id } = await created.json();
  const html = await (await fetch(`${base}/s/${id}`)).text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
});
