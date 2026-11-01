import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

test("products are escaped on the session page", async () => {

  const created = await post("/sessions", { product: '"><script>alert(1)</script>' });
  const { id } = await created.json();
  const html = await (await fetch(`${base}/s/${id}`)).text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
});
