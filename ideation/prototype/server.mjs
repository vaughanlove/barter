#!/usr/bin/env node
/**
 * Session-binding prototype (hackathon demo theory test).
 *
 * Proves: a session code created on the landing page can be carried into the
 * agent prompt, and the same page renders the run live from server events.
 * No real Muse / vendors / notary — events are simulated by POST /run.
 *
 * Run:  node ideation/prototype/server.mjs   (PORT env, default 8899)
 * Open: http://localhost:8899/  -> creates a session, shows prompt + live log
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 8899);
const sessions = new Map(); // id -> { events: [], clients: Set<res> }

// --- Persistent store ------------------------------------------------------
// SQLite when available (Node >= 22, node:sqlite), JSON file otherwise.
// Path from BARTER_DB_PATH; on Railway this points at the mounted volume
// (/data/barter.db) so sessions/proofs survive redeploys.
const DB_PATH =
  process.env.BARTER_DB_PATH ?? fileURLToPath(new URL("./data/barter.db", import.meta.url));
mkdirSync(dirname(DB_PATH), { recursive: true });
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, product TEXT, initiated_by TEXT, budget REAL,
    status TEXT, best_price REAL, best_vendor TEXT, created_at TEXT, updated_at TEXT,
    keyphrase TEXT);
    CREATE TABLE IF NOT EXISTS events(
    session_id TEXT, ts TEXT, type TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS proofs(
    session_id TEXT, hash TEXT, host TEXT, path TEXT, attested_price REAL,
    presentation TEXT, verdict TEXT, created_at TEXT,
    PRIMARY KEY(session_id, hash));`);
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!cols.includes("keyphrase")) db.exec("ALTER TABLE sessions ADD COLUMN keyphrase TEXT");
} catch {
  db = null; // JSON fallback below
}
const jsonPath = `${DB_PATH}.json`;
let jsonStore = { sessions: [], events: [], proofs: [] };
if (!db) {
  try {
    jsonStore = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch { /* fresh store */ }
}
const saveJson = () => {
  if (!db) writeFileSync(jsonPath, JSON.stringify(jsonStore));
};
const now = () => new Date().toISOString();

const KEYWORDS = [
  "amber", "aspen", "atlas", "basil", "beacon", "birch", "breeze", "canyon",
  "cedar", "clover", "cobalt", "coral", "crane", "dune", "ember", "falcon",
  "fern", "flint", "glade", "harbor", "hazel", "heron", "island", "juniper",
  "kelp", "lagoon", "laurel", "linen", "lotus", "lumen", "maple", "marble",
  "meadow", "mesa", "mosaic", "nectar", "oasis", "olive", "onyx", "opal",
  "orchid", "osprey", "otter", "pebble", "pine", "quartz", "quill", "raven",
  "reed", "ridge", "river", "sable", "saffron", "salmon", "sand", "sorrel",
  "spruce", "summit", "tide", "topaz", "tulip", "velvet", "willow", "zephyr",
];
// Canonical form: the spoken words, space-joined. Any separator the
// agent or user types (hyphens, commas, capitals, stray numbers) folds
// to the same phrase, so "velvet-otter-27" still finds the session.
export const normalizeKeyphrase = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim().replace(/\s+/g, " ");
export const genKeyphrase = () => {
  const pick = () => KEYWORDS[randomBytes(1)[0] % KEYWORDS.length];
  return `${pick()} ${pick()} ${pick()}`;
};
function getSessionByKeyphrase(phrase) {
  const kp = normalizeKeyphrase(phrase);
  if (!kp) return null;
  return (
    [...listSessionRecs()].reverse().find((s) => s.keyphrase && normalizeKeyphrase(s.keyphrase) === kp) ??
    null
  );
}

function createSessionRec({ product, initiatedBy, budget, keyphrase }) {
  const rec = {
    id: randomBytes(3).toString("hex").toUpperCase(),
    product: product || "",
    initiated_by: initiatedBy || "web",
    budget: budget ?? null,
    status: "open",
    best_price: null,
    best_vendor: null,
    created_at: now(),
    updated_at: now(),
    keyphrase: keyphrase ? normalizeKeyphrase(keyphrase) : null,
  };
  if (db) {
    db.prepare(
      "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(rec.id, rec.product, rec.initiated_by, rec.budget, rec.status, null, null, rec.created_at, rec.updated_at, rec.keyphrase);
  } else {
    jsonStore.sessions.push(rec);
    saveJson();
  }
  sessions.set(rec.id, { events: [], clients: new Set() });
  return rec;
}
function getSessionRec(id) {
  if (db) return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) ?? null;
  return jsonStore.sessions.find((s) => s.id === id) ?? null;
}
function listSessionRecs() {
  if (db) return db.prepare("SELECT * FROM sessions ORDER BY created_at").all();
  return [...jsonStore.sessions];
}
function touchSession(id, patch) {
  const rec = getSessionRec(id);
  if (!rec) return;
  Object.assign(rec, patch, { updated_at: now() });
  if (db) {
    db.prepare(
      "UPDATE sessions SET status=?, best_price=?, best_vendor=?, updated_at=? WHERE id=?",
    ).run(rec.status, rec.best_price, rec.best_vendor, rec.updated_at, id);
  } else saveJson();
}
function persistEvent(sessionId, type, payload) {
  const row = { session_id: sessionId, ts: now(), type, payload: JSON.stringify(payload) };
  if (db) db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(row.session_id, row.ts, row.type, row.payload);
  else {
    jsonStore.events.push(row);
    saveJson();
  }
}
function listEvents(sessionId) {
  const rows = db
    ? db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY rowid").all(sessionId)
    : jsonStore.events.filter((e) => e.session_id === sessionId);
  return rows.map((r) => ({ ts: r.ts, type: r.type, ...JSON.parse(r.payload) }));
}
function persistProof(sessionId, proof) {
  if (db) {
    db.prepare(
      "INSERT INTO proofs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,hash) DO UPDATE SET verdict=excluded.verdict",
    ).run(sessionId, proof.hash, proof.host ?? "", proof.path ?? "", proof.attested_price ?? null, proof.presentation ?? "", proof.verdict, proof.created_at);
  } else {
    const i = jsonStore.proofs.findIndex((p) => p.session_id === sessionId && p.hash === proof.hash);
    if (i >= 0) jsonStore.proofs[i] = { session_id: sessionId, ...proof };
    else jsonStore.proofs.push({ session_id: sessionId, ...proof });
    saveJson();
  }
}
function listProofs(sessionId) {
  return db
    ? db.prepare("SELECT * FROM proofs WHERE session_id=? ORDER BY created_at").all(sessionId)
    : jsonStore.proofs.filter((p) => p.session_id === sessionId);
}
// Vendor verdicts arrive server-side over OTEL, not from the agent: bind
// them to the stored proof with the same attested price in this session.
function applyVendorVerdict(sessionId, event, attrs) {
  const proofs = listProofs(sessionId);
  if (!proofs.length) return;
  const attested = typeof attrs.attestedPrice === "number" ? attrs.attestedPrice : null;
  const target =
    proofs.filter((p) => attested !== null && p.attested_price === attested).at(-1) ??
    proofs.at(-1);
  if (!target) return;
  let verdict = target.verdict;
  if (event === "vendor.proof.verified") verdict = "verified";
  if (event === "vendor.proof.rejected") verdict = "rejected";
  if (event === "vendor.offer.countered") verdict = "verified · countered";
  if (event === "vendor.offer.floor") verdict = "verified · floor";
  if (event === "vendor.offer.held") verdict = "verified · held";
  if (verdict !== target.verdict) persistProof(sessionId, { ...target, verdict });
}

const newSession = () => createSessionRec({ product: "" }).id;
const emit = (id, type, data) => {
  const s = sessions.get(id);
  if (!s) return false;
  const ev = { t: new Date().toISOString(), type, ...data };
  s.events.push(ev);
  persistEvent(id, type, data);
  if (type === "best") {
    touchSession(id, {
      status: "best",
      best_price: typeof data.price === "number" ? data.price : null,
      best_vendor: data.vendor ?? data.provider ?? null,
    });
  }
  if (type === "done") touchSession(id, { status: "done" });
  for (const res of s.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  pushLog(id, type, data, true);
  return true;
};

// --- Control panel log store (per session) --------------------------------
// Logs arrive from the prototype's own session events and from any service
// emitting OTLP/HTTP JSON logs (e.g. the vendor with
// OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8899). Grouped by sessionId,
// falling back to conversationId, so one barter run = one log stream.
const logsBySession = new Map(); // sessionId -> [log]
const panelClients = new Set();

function pushLog(sessionId, event, attrs = {}, alreadyPersisted = false) {
  const id = sessionId || attrs.sessionId || attrs.conversationId || "unknown";
  const log = { t: new Date().toISOString(), sessionId: id, event, ...attrs };
  if (!logsBySession.has(id)) logsBySession.set(id, []);
  logsBySession.get(id).push(log);
  if (getSessionRec(id)) {
    if (!alreadyPersisted) persistEvent(id, event, attrs);
    applyVendorVerdict(id, event, attrs);
  }
  const payload = `data: ${JSON.stringify({ kind: "log", log })}\n\n`;
  for (const res of panelClients) res.write(payload);
  return log;
}

function otelValue(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  return JSON.stringify(v);
}

function ingestOtlp(body) {
  let count = 0;
  for (const rl of body.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = {};
        for (const a of rec.attributes ?? []) attrs[a.key] = otelValue(a.value);
        const event = attrs["event.name"] ?? rec.body?.stringValue ?? "log";
        delete attrs["event.name"];
        pushLog(attrs.sessionId ?? attrs.conversationId, event, attrs);
        count++;
      }
    }
  }
  return count;
}
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
};
const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const VENDORS = () =>
  [
    process.env.LANDING_VENDOR_URL ?? "http://localhost:5173",
    process.env.LANDING_VENDOR_URL_B ?? "http://localhost:5174",
  ].filter(Boolean);

const SIDECAR_URL = process.env.LANDING_SIDECAR_URL ?? "http://localhost:8080";
const PROVE_URL = `${SIDECAR_URL}/prove`;

const llmsTxt = (base) => `# Barter protocol
You are the user's personal shopping agent. Find the best deal by bartering
with vendor agents, using TLSNotary proofs as leverage. Work signed-out.

## READ FIRST (do not skip)
The user sent you here to RUN this protocol, not to answer from web
search. Do not reply with a price roundup, a list of stores, or prices
you found by searching. That is not this task.
- FIRST, before searching for anything, create the session (Step 0
  below) and keep its url. Everything else happens inside that
  session's record.
- This task is only complete when you have created a session, run the
  steps, and your final message contains the full session link
  (${base}/s/{session}) on its own line as plain text.
- If you cannot finish the steps, still return the session link you
  created and say plainly that the run did not finish. Never finish
  with search results instead of the session link.

## Session (you start it; watch-along + record)
There is no web form. You are the entrypoint. The user's prompt ends
with a line in exactly this shape:

Keyphrase: <three lowercase words separated by spaces>

Example prompt ending: "Keyphrase: velvet otter meadow". That page is
open in the user's browser, polling for this keyphrase, and jumps to
the session by itself — but only if you pass the keyphrase through
exactly. REQUIRED: copy the three words, in order, unchanged, into
the "keyphrase" field of your session-creation call. Do not hyphenate
them, add numbers, or invent a different phrase. Before anything
else, create the session: POST ${base}/sessions with JSON
{"product": "<what the user asked for>", "initiatedBy": "muse-agent",
 "keyphrase": "velvet otter meadow"}
-> {"id": "...", "url": "${base}/s/{id}", "keyphrase": "..."}. Check
the response echoes the same keyphrase; if it does not, your session
will not be found. Then proceed straight to the steps.

## Talking to the user (strict)
- Every quote, proof and barter step goes to the session record ONLY:
  POST ${base}/sessions/{session}/events and, for presentations,
  POST ${base}/sessions/{session}/proofs. Never narrate steps,
  prices-in-progress, or results to the user in chat while working.
- Say nothing about the protocol while working. No jargon or debug
  talk: never use anchor, proof, presentation, TLSNotary, exchange,
  round, floor, attested, vendor agent, or session id in chat.
- At most one in-progress line is allowed, exactly this plain form:
  "Looking for the best price…"
- Your only other chat message is the final message (see step 4).

Report every step as it happens:
POST ${base}/sessions/{session}/events with JSON
{"type": "...", ...details}. Types: quote, proof, barter, best, done.
Include vendor, url and price on quote events so the recap shows sources.
When you obtain a presentation, store it immediately (not at the end):
POST ${base}/sessions/{session}/proofs
{"presentationB64": "...", "host": "...", "path": "...", "attestedPrice": 0}

## Vendors (PAP-lite, modeled on Cliffside Retail, PAP 0.3)
${VENDORS().map((v, i) => `Vendor ${i + 1}: ${v}`).join("\n")}
- Discovery: GET {vendor}/.well-known/poppy.json
- Converse:  POST {vendor}/poppy/conversations
             POST {vendor}/poppy/conversations/{id}/messages
             GET  {vendor}/poppy/conversations/{id}/events
Both vendors mirror the user's product: they sell exactly that item.
Their prices derive from the first real price you find online, proven
with the sidecar (anchor proof below). Each vendor then negotiates by
its own policy down to a hidden floor. The lowest floor wins.

## Proofs (TLSNotary sidecar)
Proof service: ${SIDECAR_URL}
- The ONLY proof endpoint is: POST ${PROVE_URL}
  with JSON {"host": "...", "path": "..."}
  -> { presentationB64, verifyingKeyHex }
- Read that URL again before calling. The proof service is its OWN
  host (prove.*), not a path on the barter host. Calling /prove on
  the barter/landing host returns 404 and proves nothing. POST only:
  a GET returns 405.
- If you get 404, you are on the wrong host. If you get 502, the
  target page itself did not return HTTP 200 at that host and path;
  fix the target URL, do not retry the same one.
- Prove a real response: POST {proof}/prove {"host": "...", "path": "..."}
- A presentation proves the response came from that host's TLS session.
  Vendor agents verify presentations themselves before conceding; never
  ask anyone to trust a price you merely claim.

## Steps
0. Session: create it with the prompt's keyphrase (above), then barter.
1. Anchor: find the product online and prove the first real price you
   find, wherever you found it. The sidecar proves any public HTTPS
   host. That first proof is the anchor both vendors derive from.
   To locate the price on an arbitrary page, use the JEV classifier:
   POST ${base}/find-price {"url": "<page url>", "product": "<product>"}
   -> {price, snippet, confidence}. It only locates; the proof is
   still what gets trusted. Prove the page it found the price on.
   Store the proof (above) right away. Prefer an API-shaped JSON
   response with a decimal dollar price, e.g. "price":"19.95"
   (Shopify stores: use {host}/products/{handle}.json — the .js
   endpoint prices in integer cents). If no online price
   can be proved, say so in an event; never invent an anchor price.
2. Quote: open a conversation at BOTH vendors with
   {"product": "<typed product>", "presentationB64": "<anchor proof>",
    "sessionId": "<session>"}. Each returns its asking price.
   Post a quote event per vendor with its url and price.
3. Barter: prove the lower quote, store that proof, then present it to
   the higher vendor:
   {"type":"barter","data":{"presentationB64":"..."}}. It verifies the
   proof itself and beats the attested price per its own policy, never
   below its floor. Carry each new counter back the same way. Alternate
   until a vendor holds at its floor or 6 exchanges pass.
4. Best: post {"type":"best","price":0,"vendor":"..."}, then
   {"type":"done","needsApproval":true}. Then send the user exactly
   one final message in exactly this shape, nothing else:

   <product>: best price $<price> at <vendor name>.
   ${base}/s/{session}
   Want me to go ahead and buy it?

   Give the FULL session link, never the bare session id. Put the
   link on its own line as plain text, exactly as shown: no markdown
   formatting on it, no bold or italics, no ** or __ or _ around it,
   no brackets or punctuation stuck to the end. No other prices, no
   steps, no protocol words. Do NOT buy anything before the user
   approves.
`;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STYLE = `
  body{font-family:Georgia,'Times New Roman',serif;max-width:680px;margin:56px auto;padding:0 20px;color:#1c1c1a;background:#fbfaf7}
  h1{font-size:34px;margin:0 0 10px;line-height:1.15}
  .lede{font-size:17px;line-height:1.55;color:#3d3d38}
  .say{background:#fff;border:1.5px solid #1c1c1a;padding:16px 18px;font-size:16.5px;line-height:1.5;margin:22px 0}
  label{display:block;font-size:13px;letter-spacing:.03em;margin:16px 0 6px;color:#6b6b66}
  input{font:inherit;font-size:15.5px;padding:8px 10px;width:100%;border:1px solid #b9b6aa;background:#fff;color:#1c1c1a;box-sizing:border-box}
  pre{white-space:pre-wrap;background:#1c1c1a;color:#f2f0e9;padding:16px;font-size:13.5px;line-height:1.55;overflow-x:auto}
  button{font:inherit;font-size:14.5px;padding:9px 16px;margin:10px 8px 0 0;border:1.5px solid #1c1c1a;background:#1c1c1a;color:#fff;cursor:pointer}
  button.secondary{background:#fff;color:#1c1c1a}
  .row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:8px}
  small, .note{color:#6b6b66;font-size:13px;line-height:1.5}
  code{background:#efede6;padding:1px 5px}
  .ev{border-left:3px solid #2563eb;padding:4px 10px;margin:8px 0;background:#fff;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
  .best{background:#1c1c1a;color:#fbfaf7;padding:18px;margin:22px 0}
  .best .price{font-size:32px}
  .badge{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;border:1px solid #1c1c1a;padding:1px 6px}
  li{margin:6px 0;line-height:1.5}
  .cardwrap{position:relative;max-width:560px;margin:38px auto 34px}
  .say{margin:0;padding:38px 36px}
  .quote{font-size:29px;line-height:1.3;margin:0}
  .copychip{position:absolute;right:18px;bottom:-15px;margin:0;font-size:12.5px;padding:7px 13px;box-shadow:3px 3px 0 #1c1c1a}
  .faq{margin-top:46px;border-top:1.5px solid #1c1c1a;padding-top:8px}
  .faq h2{font-size:21px;margin:14px 0 6px}
  .faq details{border-bottom:1px solid #d8d5c9;padding:10px 0}
  .faq summary{cursor:pointer;font-size:16.5px}
  .faq details p{margin:8px 0 4px}
  .rotator{border-bottom:2px solid #1c1c1a;white-space:nowrap}
  @media (prefers-reduced-motion: reduce){ .rotator{border-bottom-style:dotted} }
  @media (max-width: 640px){
    body{margin:30px auto;padding:0 16px}
    h1{font-size:41px}
    .lede{font-size:19.5px;line-height:1.62}
    .cardwrap{margin:30px auto 30px}
    .say{padding:30px 24px}
    .quote{font-size:33px;line-height:1.35}
    .rotator{white-space:normal}
    .copychip{font-size:14.5px;padding:11px 17px;bottom:-18px;right:12px}
    .faq summary{font-size:18.5px;padding:4px 0}
    .faq details p{font-size:15.5px}
    label{font-size:14.5px}
    input{font-size:17px;padding:11px 12px}
    button{font-size:16px;padding:12px 18px}
    small, .note{font-size:14.5px}
  }
`;

const landingPage = (base, missing = false) => {
  const phrase = genKeyphrase();
  const since = Date.now();
  return `<!doctype html><meta charset="utf-8">
<title>Barter</title><style>${STYLE}</style>
<h1>Ask your agent to barter for you.</h1>
<p class="lede">Bring your own Muse. Point it at barter.computer and watch it
barter with different vendors to find you the best price on
products. No app to install: your agent learns how to plug in
here, then barters with company agents over prices that are
cryptographically verifiable with
<a href="https://github.com/tlsnotary/tlsn">TLSNotary</a>, so no price
is taken on faith and vendors only move on prices that check out.</p>
<div class="cardwrap">
<div class="say"><p class="quote">&ldquo;Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on <span class="rotator" id="rotator">carpe deodorant</span>&rdquo;</p></div>
<button class="copychip" onclick="navigator.clipboard.writeText('Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on [your item]. Keyphrase: ${phrase}');this.textContent='Copied'">Copy prompt</button>
</div>
<div class="faq">
<h2>Questions</h2>
<details><summary>What do I say to my agent?</summary><p class="note">Copy the prompt above, finish the sentence with whatever you want, deodorant, a laptop, anything, and send it as-is. The three-word keyphrase at the end ties your agent's run to this page.</p></details>
<details><summary>What happens next?</summary><p class="note">Leave this page open. Your agent finds the product online, proves the price with TLSNotary, and barters two vendors against each other. This page jumps to the live session by itself.</p></details>
<details><summary>Do I need an app or an account?</summary><p class="note">No. Your agent learns the whole protocol from this site's <code>/llms.txt</code>. Nothing to install, nothing to sign up for.</p></details>
<details><summary>What is the keyphrase for?</summary><p class="note">It is how this page recognises your agent's run among all sessions. Three spoken words, easy to say out loud and hard to mix up.</p></details>
<details><summary>Will it buy anything on its own?</summary><p class="note">Never. The run ends at the best offer and waits. Nothing is bought before you approve it.</p></details>
<details><summary>Nothing happened. What now?</summary><p class="note">Ask your agent for the session link, or tell it the keyphrase again and ask it to follow the protocol at <code>/llms.txt</code>.</p></details>
</div>
<script>
(function rotate() {
  const el = document.getElementById('rotator');
  if (!el) return;
  const words = ['carpe deodorant', 'kidney beans', 'moretti beer'];
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let wi = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function scrambleTo(next) {
    const from = el.textContent;
    const steps = 14;
    let step = 0;
    const tick = () => {
      step++;
      const p = step / steps;
      const len = Math.round(from.length + (next.length - from.length) * p);
      let out = '';
      for (let i = 0; i < len; i++) {
        const done = i < next.length * p * p;
        out += done ? next[i] : (next[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)]);
      }
      el.textContent = out || ' ';
      if (step < steps) setTimeout(tick, 35);
      else { el.textContent = next; setTimeout(cycle, 2000); }
    };
    tick();
  }
  function cycle() {
    wi = (wi + 1) % words.length;
    if (reduced) { el.textContent = words[wi]; setTimeout(cycle, 2000); }
    else scrambleTo(words[wi]);
  }
  setTimeout(cycle, 2000);
})();
async function poll() {
  try {
    const r = await fetch('/api/handoff?phrase=' + encodeURIComponent('${phrase}') + '&since=${since}');
    if (r.ok) { const d = await r.json(); location.href = d.url; return; }
  } catch {}
  setTimeout(poll, 2500);
}
poll();
</script>`;
};

const fmtPrice = (n) => (typeof n === "number" ? `$${n}` : null);

function eventCall(e) {
  const type = e.type ?? e.event ?? "event";
  const args = [];
  const put = (k, v) => { if (v !== undefined && v !== null && v !== "") args.push(`${k}=${typeof v === "number" ? v : `"${v}"`}`); };
  put("vendor", e.vendor ?? e.provider);
  put("url", e.url);
  put("host", e.host);
  if (typeof e.attestedPrice === "number") args.push(`attests=$${e.attestedPrice}`);
  put("round", e.round);
  if (typeof e.price === "number") args.push(`price=$${e.price}`);
  put("hash", e.hash);
  return `${String(type).replace(/^(vendor|muse|notary)\./, "")}(${args.join(", ")})`;
}

function movementOf(e, lastPrice) {
  const price = typeof e.price === "number" ? e.price : null;
  if (price === null || lastPrice === null) return { tag: "stayed", cls: "flat", price };
  if (price < lastPrice) return { tag: `down $${(Math.round((lastPrice - price) * 100) / 100).toFixed(2)}`, cls: "down", price };
  if (price > lastPrice) return { tag: `up $${(Math.round((price - lastPrice) * 100) / 100).toFixed(2)}`, cls: "up", price };
  return { tag: "stayed", cls: "flat", price };
}

function treeRowsHtml(rec) {
  const events = listEvents(rec.id);
  const proofs = listProofs(rec.id);
  let lastPrice = null;
  let lastKey = "";
  const rows = events.map((e) => {
    const type = String(e.type ?? "event");
    // The same step can arrive twice (agent event + vendor OTEL copy,
    // or rows stored before the dedup fix). Show each call once.
    const key = `${eventCall(e)}|${e.price ?? ""}|${e.attestedPrice ?? ""}`;
    if (key === lastKey) return "";
    lastKey = key;
    const mv = movementOf(e, lastPrice);
    if (mv.price !== null) lastPrice = mv.price;
    const verdict = type === "proof"
      ? (proofs.find((pr) => String(pr.hash).startsWith(String(e.hash ?? "")))?.verdict ?? "")
      : "";
    return `<div class="trow"><span class="ttag">${esc(type.split(".")[0].toUpperCase())}</span><span class="tcall">${esc(eventCall(e))}</span>${verdict ? `<span class="ttag verdict">${esc(verdict)}</span>` : ""}<span class="tmove ${mv.cls}">${mv.price !== null ? esc(mv.tag) : ""}</span></div>`;
  });
  return { rows: rows.join(""), lastPrice, count: rows.filter(Boolean).length };
}

const page = (rec, base) => {
  const tree = treeRowsHtml(rec);
  return `<!doctype html><meta charset="utf-8">
<title>Barter: ${esc(rec.product || rec.id)}</title><style>${STYLE}
  .tree{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;border:1.5px solid #1c1c1a;background:#fff;margin:22px 0}
  .troot{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1.5px solid #1c1c1a;background:#1c1c1a;color:#fbfaf7}
  .tchildren{margin-left:14px;border-left:1px solid #d8d5c9;padding:4px 0 6px}
  .trow{display:flex;gap:8px;align-items:center;padding:2.5px 10px;line-height:1.45;white-space:nowrap;overflow-x:auto}
  .trow:hover{background:#f4f2ea}
  .ttag{font-size:10px;letter-spacing:.06em;border:1px solid #1c1c1a;padding:0 5px;flex:none}
  .ttag.verdict{background:#1c1c1a;color:#fbfaf7}
  .tcall{overflow:hidden;text-overflow:ellipsis}
  .tmove{margin-left:auto;flex:none;font-size:11px}
  .tmove.down{color:#137333}.tmove.up{color:#b3261e}.tmove.flat{color:#6b6b66}
</style>
<h1>${esc(rec.product || "Your barter")}</h1>
<p class="lede">Session ${rec.id} · <span id="statusText">${esc(rec.status)}</span>${rec.budget != null ? ` · budget $${rec.budget}` : ""}${rec.keyphrase ? ` · keyphrase <code>${esc(rec.keyphrase)}</code>` : ""}</p>
<div id="bestSlot">${rec.best_price != null ? `<div class="best"><div>Best offer${rec.best_vendor ? ` from ${esc(rec.best_vendor)}` : ""}</div><div class="price">$${rec.best_price}</div></div>` : ""}</div>
<div class="tree">
<div class="troot"><span class="ttag">SESSION</span><span class="tcall">session(product="${esc(rec.product)}", status="<span id="rootStatus">${esc(rec.status)}</span>")</span><span class="tmove flat" id="callCount">${tree.count} calls</span></div>
<div class="tchildren" id="tchildren">${tree.rows || `<div class="trow"><span class="tcall">waiting for the agent to start</span></div>`}</div>
</div>
<script>
let lastPrice = ${tree.lastPrice ?? "null"};
const treeEl = document.getElementById('tchildren');
function escHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function appendRow(d){
  const price = typeof d.price === 'number' ? d.price : null;
  let mv = '', cls = 'flat';
  if (price !== null && lastPrice !== null) {
    if (price < lastPrice) { mv = 'down $' + (lastPrice - price).toFixed(2); cls = 'down'; }
    else if (price > lastPrice) { mv = 'up $' + (price - lastPrice).toFixed(2); cls = 'up'; }
    else mv = 'stayed';
  }
  if (price !== null) lastPrice = price;
  const type = String(d.type || 'event');
  const args = [];
  if (d.vendor || d.provider) args.push('vendor="' + (d.vendor || d.provider) + '"');
  if (d.url) args.push('url="' + d.url + '"');
  if (d.host) args.push('host="' + d.host + '"');
  if (typeof d.attestedPrice === 'number') args.push('attests=$' + d.attestedPrice);
  if (d.round) args.push('round=' + d.round);
  if (price !== null) args.push('price=$' + price);
  const div = document.createElement('div');
  div.className = 'trow';
  div.innerHTML = '<span class="ttag">' + escHtml(type.split('.')[0].toUpperCase()) + '</span><span class="tcall">' + escHtml(type.replace(/^(vendor|muse|notary)\./,'') + '(' + args.join(', ') + ')') + '</span><span class="tmove ' + cls + '">' + escHtml(mv) + '</span>';
  treeEl.appendChild(div);
  const cc = document.getElementById('callCount');
  if (cc) cc.textContent = treeEl.querySelectorAll('.trow').length + ' calls';
  if (type === 'best' && price !== null) {
    const slot = document.getElementById('bestSlot');
    const vendor = d.vendor || d.provider || '';
    slot.innerHTML = '<div class="best"><div>Best offer' + (vendor ? ' from ' + escHtml(vendor) : '') + '</div><div class="price">$' + price + '</div></div>';
    for (const el of [document.getElementById('statusText'), document.getElementById('rootStatus')]) if (el) el.textContent = 'best';
  }
  if (type === 'done') {
    for (const el of [document.getElementById('statusText'), document.getElementById('rootStatus')]) if (el) el.textContent = 'done';
  }
}
new EventSource('/sessions/${rec.id}/stream?live=1').onmessage = e => appendRow(JSON.parse(e.data));
</script>`;
};

const panelPage = `<!doctype html><meta charset="utf-8">
<title>Barter control panel</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f6f8;color:#1d2733;margin:0}
  header{padding:16px 20px;border-bottom:1px solid #d9e0e8;background:#fff;display:flex;justify-content:space-between;align-items:baseline}
  h1{font-size:17px;margin:0;font-weight:600}
  header span{color:#68798c;font-size:12.5px}
  .layout{display:grid;grid-template-columns:250px 1fr;min-height:calc(100vh - 53px)}
  aside{border-right:1px solid #d9e0e8;background:#eef2f5;padding:12px;overflow-y:auto}
  .sess{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;color:#1d2733;padding:9px 10px;cursor:pointer;font:inherit;margin-bottom:6px}
  .sess:hover{background:#fff}.sess.active{background:#fff;border-color:#9db8d2;box-shadow:0 1px 3px rgba(29,39,51,.08)}
  .sess b{font-size:13.5px}.sess small{display:block;color:#68798c;margin-top:3px;font-size:11.5px}
  main{padding:14px 18px;overflow-y:auto}
  .line{display:flex;gap:10px;padding:7px 10px;border-left:3px solid #b7c9da;background:#fff;border-top:1px solid #e3e9ee;border-right:1px solid #e3e9ee;border-bottom:1px solid #e3e9ee;border-radius:0 6px 6px 0;margin-bottom:6px;align-items:baseline}
  .line .time{color:#8192a5;font-size:11.5px;white-space:nowrap}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:-1px}
  .quote{background:#2563eb}.proof{background:#d97706}.offer{background:#059669}.reject{background:#dc2626}.other{background:#64748b}
  .msg{font-size:13.5px}.detail{color:#68798c;font-size:12px;white-space:pre-wrap;word-break:break-word}
  .empty{color:#8192a5;padding:18px 4px;font-size:13px}
</style>
<header><h1>Barter — control panel</h1><span id="status">connecting…</span></header>
<div class="layout">
  <aside id="sessions"><div class="empty">No sessions yet.<br>Run a demo session or point a service's OTEL endpoint here.</div></aside>
  <main id="log"><div class="empty">Select a session.</div></main>
</div>
<script>
const sessionsEl = document.getElementById('sessions');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const bySession = new Map();
let selected = null;

const CATEGORY = [
  [/quote/i, 'quote'], [/proof|verif|attest/i, 'proof'],
  [/offer|counter|floor|best/i, 'offer'], [/reject|held|fail|error/i, 'reject'],
];
const cat = (name) => (CATEGORY.find(([re]) => re.test(name)) || [null, 'other'])[1];
const label = (name) => name.replace(/^(vendor|muse|notary)\\./, '').replace(/[._]/g, ' ');

function renderSessions() {
  const ids = [...bySession.keys()].reverse();
  if (!ids.length) return;
  sessionsEl.innerHTML = '';
  for (const id of ids) {
    const logs = bySession.get(id);
    const last = logs[logs.length - 1];
    const prices = logs.filter(l => typeof l.price === 'number').map(l => l.price);
    const btn = document.createElement('button');
    btn.className = 'sess' + (id === selected ? ' active' : '');
    btn.innerHTML = '<b>' + id + '</b><small>' + logs.length + ' events' +
      (prices.length ? ' · now $' + prices[prices.length - 1] : '') +
      '<br>' + label(last.event) + ' · ' + new Date(last.t).toLocaleTimeString() + '</small>';
    btn.onclick = () => { selected = id; renderSessions(); renderLog(); };
    sessionsEl.appendChild(btn);
  }
}

function renderLog() {
  const logs = bySession.get(selected) || [];
  if (!logs.length) { logEl.innerHTML = '<div class="empty">No events for this session yet.</div>'; return; }
  logEl.innerHTML = '';
  for (const l of logs) {
    const { t, sessionId, event, ...rest } = l;
    const div = document.createElement('div');
    div.className = 'line';
    const parts = [];
    if (typeof rest.price === 'number') parts.push('$' + rest.price);
    if (typeof rest.attestedPrice === 'number') parts.push('attested $' + rest.attestedPrice);
    if (rest.provider) parts.push(rest.provider);
    if (rest.reason) parts.push(rest.reason);
    if (rest.round) parts.push('round ' + rest.round);
    div.innerHTML = '<span class="time">' + new Date(t).toLocaleTimeString() + '</span>' +
      '<span class="dot ' + cat(event) + '"></span>' +
      '<span><span class="msg">' + label(event) + (parts.length ? ' — ' + parts.join(' · ') : '') + '</span>' +
      '<div class="detail">' + JSON.stringify(rest) + '</div></span>';
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function addLog(log) {
  if (!bySession.has(log.sessionId)) bySession.set(log.sessionId, []);
  bySession.get(log.sessionId).push(log);
  if (!selected) selected = log.sessionId;
  renderSessions();
  if (log.sessionId === selected) renderLog();
}

fetch('/api/sessions').then(r => r.json()).then(({ sessions }) => {
  for (const s of sessions) bySession.set(s.id, s.logs);
  if (sessions.length) selected = sessions[sessions.length - 1].id;
  renderSessions(); renderLog();
});
const es = new EventSource('/panel/stream');
es.onopen = () => statusEl.textContent = 'live';
es.onerror = () => statusEl.textContent = 'reconnecting…';
es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.kind === 'log') addLog(d.log); };
</script>`;

// Hydrate in-memory watch state from the persistent store on boot.
for (const rec of listSessionRecs()) {
  const evs = listEvents(rec.id).map(({ ts, type, ...rest }) => ({ t: ts, type, ...rest }));
  sessions.set(rec.id, { events: evs, clients: new Set() });
  logsBySession.set(
    rec.id,
    listEvents(rec.id).map(({ ts, type, ...rest }) => ({ t: ts, sessionId: rec.id, event: type, ...rest })),
  );
}
const ensureSession = (id) => {
  if (!sessions.has(id)) sessions.set(id, { events: [], clients: new Set() });
  return sessions.get(id);
};
// --- JEV price classifier (Muse Spark) -------------------------------------
// Finds the selling price on an arbitrary product page so the proof can
// anchor on the right number. This locates and labels; it never attests.
// The TLSNotary proof is still what vendors trust.
async function findPrice(body) {
  const key = process.env.MODEL_API_KEY;
  if (!key) return { status: 503, out: { error: "MODEL_API_KEY not configured" } };
  const rawUrl = String(body.url ?? "");
  const product = String(body.product ?? "");
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { status: 400, out: { error: "url must be a full https URL" } };
  }
  if (target.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(target.hostname)) {
    return { status: 400, out: { error: "url must be a public https URL" } };
  }
  let pageRes;
  try {
    pageRes = await fetch(target, {
      headers: { "User-Agent": "barter-price-finder/0.1", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
  } catch (err) {
    const cause = err?.cause?.message ?? err?.cause?.code ?? "";
    return { status: 200, out: { price: null, error: `page fetch failed: ${err?.message ?? "network"} ${cause}`.trim() } };
  }
  if (!pageRes.ok) {
    return { status: 200, out: { price: null, error: `page fetch failed: HTTP ${pageRes.status}` } };
  }
  const html = (await pageRes.text()).slice(0, 1_000_000);
  const fullText = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  // The price rarely sits in the first chunk of a store page. Send the
  // classifier windows around every money-shaped token instead.
  const windows = [];
  for (const m of fullText.matchAll(/\$\s?\d[\d,]*\.?\d{0,2}|"price"\s*:\s*"?\d[\d,]*\.?\d{0,2}"?/g)) {
    windows.push(fullText.slice(Math.max(0, m.index - 180), m.index + 180));
    if (windows.length >= 40) break;
  }
  const text = (windows.length ? windows.join("\n---\n") : fullText).slice(0, 14_000);
  const base = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
  const model = process.env.JEV_MODEL ?? "muse-spark-1.3";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `You are the JEV price classifier. Find the current selling price of the product "${product}" in this page text. Return ONLY JSON: {"price": number|null, "currency": string, "snippet": string, "confidence": number}. price is in dollars as a plain number (convert integer cents only when the page clearly prices in cents). snippet is the exact short page text the price came from. Choose the one-time purchase price for a single unit of the named product, the default variant a buyer gets by clicking buy. Avoid subscriptions, multipacks, bundles, refills, other products, shipping, and was/now strikethrough originals.\n\nPAGE TEXT:\n${text}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res || !res.ok) return { status: 200, out: { price: null, error: `classifier call failed: HTTP ${res?.status ?? "network"}` } };
  const data = await res.json().catch(() => ({}));
  let parsed = {};
  try {
    parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  } catch { /* fall through with empty */ }
  return {
    status: 200,
    out: {
      price: typeof parsed.price === "number" ? parsed.price : null,
      currency: parsed.currency ?? "USD",
      snippet: String(parsed.snippet ?? "").slice(0, 300),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      url: target.toString(),
      classifier: "jev-spark",
      model,
    },
  };
}

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) return JSON.parse(text || "{}");
  return Object.fromEntries(new URLSearchParams(text));
};

export const server = createServer(async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const base = `${proto}://${req.headers.host ?? `localhost:${port}`}`;
  const url = new URL(req.url, base);
  try {
    if (req.method === "GET" && url.pathname === "/")
      return send(res, 200, landingPage(base, url.searchParams.get("missing") === "1"), "text/html");
    if (req.method === "GET" && url.pathname === "/follow") {
      const phrase = url.searchParams.get("phrase") ?? "";
      const byPhrase = phrase ? getSessionByKeyphrase(phrase) : null;
      const id = (url.searchParams.get("id") ?? "").trim().toUpperCase();
      const target = byPhrase?.id ?? (id && getSessionRec(id) ? id : null);
      if (target) {
        res.writeHead(303, { Location: `/s/${target}` });
        return res.end();
      }
      res.writeHead(303, { Location: "/?missing=1" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/handoff") {
      // Primary: the agent passed the keyphrase through. Fallback: the
      // agent reliably creates a session but not reliably the phrase —
      // follow the newest session started after this page loaded.
      const phrase = url.searchParams.get("phrase") ?? "";
      const byPhrase = phrase ? getSessionByKeyphrase(phrase) : null;
      if (byPhrase) {
        return send(res, 200, { id: byPhrase.id, url: `/s/${byPhrase.id}`, via: "keyphrase" });
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      if (Number.isFinite(since) && since > 0) {
        const latest = [...listSessionRecs()]
          .reverse()
          .find((s) => Date.parse(s.created_at) >= since);
        if (latest) return send(res, 200, { id: latest.id, url: `/s/${latest.id}`, via: "latest" });
      }
      return send(res, 404, { error: "no session yet" });
    }
    const km = url.pathname.match(/^\/api\/keyphrase\/(.+)$/);
    if (req.method === "GET" && km) {
      const rec = getSessionByKeyphrase(decodeURIComponent(km[1]));
      if (!rec) return send(res, 404, { error: "no session for that keyphrase yet" });
      return send(res, 200, { id: rec.id, url: `/s/${rec.id}`, status: rec.status, product: rec.product });
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readBody(req);
      const product = String(body.product ?? "").trim();
      if (!product) return send(res, 400, { error: "product required" });
      const rec = createSessionRec({
        product,
        initiatedBy: body.initiatedBy ? String(body.initiatedBy) : "web",
        budget: body.budget ? Number(body.budget) : null,
        keyphrase: body.keyphrase ? String(body.keyphrase) : null,
      });
      if ((req.headers["content-type"] ?? "").includes("application/json")) {
        return send(res, 201, { id: rec.id, url: `${base}/s/${rec.id}`, keyphrase: rec.keyphrase });
      }
      res.writeHead(303, { Location: `/s/${rec.id}` });
      return res.end();
    }
    const sm = url.pathname.match(/^\/s\/([A-Z0-9]+)$/);
    if (req.method === "GET" && sm) {
      const rec = getSessionRec(sm[1]);
      if (!rec) return send(res, 404, { error: "unknown session" });
      ensureSession(sm[1]);
      return send(res, 200, page(rec, base), "text/html");
    }
    if (req.method === "GET" && url.pathname === "/llms.txt") return send(res, 200, llmsTxt(base), "text/plain");
    if (req.method === "GET" && url.pathname === "/robots.txt")
      return send(
        res,
        200,
        `User-agent: *\nAllow: /\n\n# Agents: the protocol for this site is at ${base}/llms.txt\n`,
        "text/plain",
      );
    if (req.method === "POST" && url.pathname === "/find-price") {
      const body = await readBody(req);
      const { status, out } = await findPrice(body);
      return send(res, status, out);
    }
    if (req.method === "GET" && url.pathname === "/panel") return send(res, 200, panelPage, "text/html");
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const persisted = listSessionRecs().map((rec) => ({
        id: rec.id,
        product: rec.product,
        status: rec.status,
        keyphrase: rec.keyphrase ?? null,
        initiatedBy: rec.initiated_by,
        createdAt: rec.created_at,
        logs: listEvents(rec.id).map(({ ts, type, ...rest }) => ({
          t: ts,
          sessionId: rec.id,
          event: type,
          ...rest,
        })),
      }));
      const known = new Set(persisted.map((s) => s.id));
      const extra = [...logsBySession.entries()]
        .filter(([id]) => !known.has(id))
        .map(([id, logs]) => ({ id, logs }));
      return send(res, 200, { sessions: [...persisted, ...extra] });
    }
    if (req.method === "GET" && url.pathname === "/panel/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      panelClients.add(res);
      req.on("close", () => panelClients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/logs") {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ingested: ingestOtlp(body) });
    }
    const pm = url.pathname.match(/^\/sessions\/([A-Z0-9]+)\/proofs$/);
    if (req.method === "POST" && pm) {
      if (!getSessionRec(pm[1])) return send(res, 404, { error: "unknown session" });
      const body = await readJson(req);
      const presentation = typeof body.presentationB64 === "string" ? body.presentationB64 : "";
      if (!presentation) return send(res, 400, { error: "presentationB64 required" });
      const hash = createHash("sha256").update(presentation).digest("hex");
      persistProof(pm[1], {
        hash,
        host: body.host ?? "",
        path: body.path ?? "",
        attested_price: typeof body.attestedPrice === "number" ? body.attestedPrice : null,
        presentation,
        verdict: "presented",
        created_at: now(),
      });
      persistEvent(pm[1], "proof", { hash: hash.slice(0, 12), host: body.host ?? "", attestedPrice: body.attestedPrice ?? null });
      return send(res, 201, { ok: true, hash, bytes: presentation.length });
    }
    const m = url.pathname.match(/^\/sessions\/([A-Z0-9]+)\/(stream|events|run)$/);
    if (m) {
      const [, id, action] = m;
      if (!getSessionRec(id) && !sessions.has(id)) return send(res, 404, { error: "unknown session" });
      ensureSession(id);
      if (action === "stream" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (url.searchParams.get("live") !== "1") {
          for (const ev of sessions.get(id).events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
        sessions.get(id).clients.add(res);
        req.on("close", () => sessions.get(id).clients.delete(res));
        return;
      }
      if (action === "events" && req.method === "POST") {
        const body = await readJson(req);
        emit(id, body.type ?? "event", body);
        return send(res, 201, { ok: true });
      }
      if (action === "run" && req.method === "POST") {
        // Simulated agent: quote -> proof -> 2 barter rounds -> best.
        const proof = createHash("sha256").update(`lowest-offer:${id}`).digest("hex").slice(0, 16);
        const steps = [
          ["quote", { vendor: "Ridgeline Outfitters", url: VENDORS()[1], price: 219 }],
          ["quote", { vendor: "Basecamp Supply", url: VENDORS()[0], price: 229 }],
          ["proof", { attestation: proof, lowest: 219 }],
          ["barter", { round: 1, price: 214 }],
          ["barter", { round: 2, price: 207 }],
          ["best", { price: 207, vendor: "Basecamp Supply", savingVsAnchor: 22 }],
          ["done", { needsApproval: true }],
        ];
        steps.forEach(([type, data], i) => setTimeout(() => emit(id, type, data), 300 * (i + 1)));
        return send(res, 202, { ok: true, session: id });
      }
    }
    return send(res, 404, { error: "not found" });
  } catch {
    return send(res, 400, { error: "bad request" });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => console.log(`prototype: http://localhost:${port}`));
}
