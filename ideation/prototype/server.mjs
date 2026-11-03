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
import { setDefaultResultOrder } from "node:dns";

// Railway egress can prefer IPv6, which some upstreams answer
// differently (Meta API returned model_not_found over it). IPv4 first.
setDefaultResultOrder("ipv4first");
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

// Steps that persist without going through emit (stored proofs, vendor
// OTEL verdicts) still belong on the live session page. Push them to
// any connected /s/{id} stream so live matches a refresh.
function broadcastToSession(id, ev) {
  const s = sessions.get(id);
  if (!s) return;
  s.events.push(ev);
  for (const res of s.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

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
    if (!alreadyPersisted) broadcastToSession(id, { t: log.t, type: event, ...attrs });
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
    const resourceAttrs = {};
    for (const a of rl.resource?.attributes ?? []) resourceAttrs[a.key] = otelValue(a.value);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = {};
        for (const a of rec.attributes ?? []) attrs[a.key] = otelValue(a.value);
        if (!attrs.vendor && resourceAttrs["service.name"]) attrs.vendor = resourceAttrs["service.name"];
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

const llmsTxt = (base) => `# Barter protocol (specification)

This document describes a protocol in which a personal shopping agent
barters with vendor agents, using TLSNotary proofs as negotiation
leverage. It is a technical reference for agents that implement the
protocol. All work is signed-out; no account exists on any service
named here.

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

Sessions are created by the agent; there is no web form. Creation:

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
   holds at its floor or 6 exchanges have passed.
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

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STYLE = `
  body{font-family:Gelasio,Georgia,'Times New Roman',serif;max-width:680px;margin:56px auto;padding:0 20px;color:#1c1c1a;background:#ffffff}
  h1{font-size:40px;margin:0 0 10px;line-height:1.15;font-weight:700}
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
  .cardwrap{position:relative;margin:38px 0 34px}
  .grules{display:flex;flex-direction:column;gap:3px}
  .grules i{display:block;height:1px;background:#1c1c1a}
  .kicker{color:#C70000;font-weight:700;font-size:17px;padding-top:12px}
  .pullquote{position:relative;padding:16px 0 28px;font-size:36px;font-style:italic;line-height:45px}
  .pullquote::before{content:"\\201C";position:absolute;left:-34px;top:14px;font-size:64px;line-height:64px;color:#C70000;font-weight:700;font-style:normal}
  .pullquote .roman{font-style:normal}
  .pullquote #rotator{border-bottom:1.5px solid #1c1c1a}
  .qrule{height:1px;background:#1c1c1a}
  .underquote{display:flex;gap:24px;align-items:center;padding-top:16px}
  .underquote .note{flex:1;font-size:15px;line-height:23px}
  .copybtn{flex:none;margin:0;background:#1c1c1a;color:#ffffff;border:1px solid #1c1c1a;box-shadow:3px 3px 0 #1c1c1a;font-size:14px;padding:9px 16px;cursor:pointer}
  .howbtn{display:inline-block;margin-top:14px;background:#1c1c1a;color:#ffffff;border:1px solid #1c1c1a;box-shadow:3px 3px 0 #1c1c1a;font-size:14px;line-height:16px;padding:9px 16px;text-decoration:none}
  .howbtn:hover{background:#C70000;border-color:#C70000}
  .ladder{margin:42px 0 0;border-top:1.5px solid #1c1c1a;padding-top:14px}
  .ladder h2{font-size:21px;margin:0 0 6px}
  .ladder .lcap{font-size:14.5px;color:#6b6b66;line-height:1.5;margin:10px 0 0}
  .lsteps{list-style:none;margin:14px 0 0;padding:0}
  .lstep{display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid #e3e1d8;font-size:15px}
  .lstep .lname{flex:1}
  .licon{vertical-align:-3px;margin-right:7px}
  .lbar{height:9px;background:#1c1c1a;flex:none}
  .lstep .lprice{font-weight:700;white-space:nowrap}
  .lstep .lnote{font-size:12.5px;color:#6b6b66;white-space:nowrap}
  .lstep .lsub{display:block;font-size:12.5px;line-height:1.45;color:#6b6b66;margin-top:2px}
  .lstep.loopstep{position:relative;padding-right:34px}
  .looparrow{position:absolute;right:8px;top:58%;font-size:24px;line-height:1;color:#C70000}
  .lstep.best .lprice{color:#C70000;margin-left:auto;margin-right:6px}
  .lstep.best .lbar{background:#C70000}
  .lstep.best .licon{margin-left:4px}
  .pflow{display:flex;align-items:stretch;gap:10px;margin:16px 0 0}
  .pnode{flex:1;border:1px solid #1c1c1a;padding:12px 14px;display:flex;flex-direction:column;gap:4px;justify-content:center}
  .pnode .ptag{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b6b66}
  .pnode strong{font-size:16px}
  .pnode .pprice{font-size:20px;font-weight:700}
  .pnode .psub, .plock .psub{display:block;font-size:13px;line-height:1.45;color:#6b6b66}
  .pnode.proof{align-items:flex-start}
  .parrow{align-self:center;font-size:22px;color:#C70000;flex:none}
  .pvendors{flex:1.2;display:flex;flex-direction:column;gap:6px;justify-content:center}
  .pvrow{display:flex;justify-content:space-between;border:1px solid #d8d5c9;padding:8px 12px;font-size:14.5px}
  .plock{display:flex;gap:14px;align-items:center;margin-top:14px;border:1.5px solid #1c1c1a;padding:12px 14px}
  .plock strong{font-size:17px;color:#C70000}
  @media (max-width: 640px){ .pflow{flex-direction:column} .parrow{transform:rotate(90deg)} }
  .faq{margin-top:46px;border-top:1.5px solid #1c1c1a;padding-top:8px}
  .vendors{margin-top:34px;padding-top:14px;border-top:1px solid #d8d5c9;font-size:12.5px;color:#8a877c}
  .vendors a{color:#6b6b66;text-underline-offset:3px}
  .vendors a:hover{color:#1c1c1a}
  .faq h2{font-size:21px;margin:14px 0 6px}
  .faq details{border-bottom:1px solid #d8d5c9;padding:10px 0}
  .faq summary{cursor:pointer;font-size:16.5px}
  .faq details p{margin:8px 0 4px}
  .rotator{border-bottom:2px solid #1c1c1a;white-space:nowrap}
  @media (prefers-reduced-motion: reduce){ .rotator{border-bottom-style:dotted} }
  @media (max-width: 640px){
    body{margin:30px auto;padding:0 16px}
    h1{font-size:36px}
    .lede{font-size:18px;line-height:1.6}
    .cardwrap{margin:30px 0}
    .pullquote{font-size:29px;line-height:38px;padding-left:26px}
    .pullquote::before{left:-4px;font-size:48px;line-height:48px}
    .underquote{flex-direction:column;align-items:flex-start;gap:12px}
    .lbar{display:none}
    .rotator{white-space:normal}
    .faq summary{font-size:18.5px;padding:4px 0}
    .faq details p{font-size:15.5px}
    label{font-size:14.5px}
    input{font-size:17px;padding:11px 12px}
    button{font-size:16px;padding:12px 18px}
    small, .note{font-size:14.5px}
  }
  @media (prefers-color-scheme: dark){
    body{background:#131313;color:#ecece7}
    .lede{color:#c9c9c1}
    small, .note, .underquote .note{color:#a9a9a1}
    a{color:#ecece7}
    code{background:#2a2a26;color:#ecece7}
    .grules i, .qrule{background:#ecece7}
    .pullquote #rotator{border-bottom-color:#ecece7}
    .kicker{color:#ff5147}
    .pullquote::before{color:#ff5147}
    .ladder{border-top-color:#ecece7}
    .ladder .lcap{color:#a9a9a1}
    .lstep{border-bottom-color:#2c2c28}
    .lstep .lnote{color:#a9a9a1}
    .lstep .lsub{color:#a9a9a1}
    .looparrow{color:#ff5147}
    .lbar{background:#ecece7}
    .lstep.best .lprice{color:#ff5147}
    .lstep.best .lbar{background:#ff5147}
    .pnode{border-color:#ecece7}
    .pnode .ptag, .pnode .psub, .plock .psub{color:#a9a9a1}
    .pvrow{border-color:#3a3a34}
    .plock{border-color:#ecece7}
    .plock strong{color:#ff5147}
    .pnode svg, .plock svg{stroke:#ff5147}
    .faq{border-top-color:#ecece7}
    .faq details{border-bottom-color:#3a3a34}
    .vendors{border-top-color:#3a3a34;color:#8f8f89}
    .vendors a{color:#b9b9b1}
    .vendors a:hover{color:#ffffff}
    .copybtn{background:#ecece7;color:#131313;border-color:#ecece7;box-shadow:3px 3px 0 #ecece7}
    .howbtn{background:#ecece7;color:#131313;border-color:#ecece7;box-shadow:3px 3px 0 #ecece7}
    .howbtn:hover{background:#ff5147;border-color:#ff5147;color:#131313}
    input{background:#1c1c1a;color:#ecece7;border-color:#4a4a44}
  }
`;

const landingPage = (base, missing = false) => {
  const phrase = genKeyphrase();
  const since = Date.now();
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gelasio:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<title>Barter</title><style>${STYLE}</style>
<h1>Ask your agent to barter for you.</h1>
<p class="lede">Bring your own agent. Point it at barter.computer and it learns
a protocol for turning a price it finds anywhere online into a
verifiable proof, then uses that proof to barter with vendors.
No app to install and no price taken on faith: vendors only move
on prices they can verify themselves with
<a href="https://github.com/tlsnotary/tlsn">TLSNotary</a>. In this
demo the companies are simulated. The real product search, the
proofs, the verification, and the negotiation are real.</p>
<div class="cardwrap">
<div class="grules"><i></i><i></i><i></i><i></i></div>
<div class="kicker">Say this to your agent</div>
<div class="pullquote">
<div>Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me</div>
<div>the best price on <span class="rotator" id="rotator">carpe deodorant</span>.</div>
<div>Keyphrase: <span class="roman">${phrase}&rdquo;</span></div>
</div>
<div class="qrule"></div>
<div class="underquote">
<p class="note">Leave this page open after you send it. It jumps to your agent&rsquo;s session by itself.</p>
<button class="copybtn" onclick="navigator.clipboard.writeText('Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on [your item]. Keyphrase: ${phrase}');this.textContent='Copied'">Copy prompt</button>
</div>
</div>
<div class="ladder">
<h2>What the protocol makes possible</h2>
<ol class="lsteps">
<li class="lstep"><span class="lname">Your agent finds a price online<span class="lsub">A true search for the real product. The proof it generates is real, and anyone can validate it.</span></span><span class="lbar" style="width:142px"></span><span class="lprice">$17.19</span></li>
<li class="lstep"><span class="lname"><svg class="licon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#C70000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>Proof generated: a provable presentation of that price</span><span class="lnote">TLSNotary presentation</span></li>
<li class="lstep loopstep"><span class="lname">Vendors stocking the product verify the proof</span><span class="lnote">TLSNotary verification</span><span class="looparrow" aria-hidden="true">&#8597;</span></li>
<li class="lstep loopstep"><span class="lname">Multiple rounds of counter-offers, each backed by its own proof</span><span class="lprice">&darr; lower each round</span></li>
<li class="lstep best"><span class="lname"><svg class="licon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#C70000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Best price locked, awaiting your approval</span><span class="lbar" style="width:130px"></span><span class="lprice">$15.67</span></li>
</ol>
<p class="lcap">Prices from a real run. The vendors are any company agents; the proof is what lets strangers negotiate without trusting each other&rsquo;s claims. <a href="/s/${REFERENCE_SESSION}">See this run</a></p>
<a class="howbtn" href="/how-it-works">How it works</a>
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
<footer class="vendors">Simulated vendors: <a href="https://basecamp.barter.computer">Basecamp Supply</a> · <a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a></footer>
<script>
(function rotate() {
  const el = document.getElementById('rotator');
  if (!el) return;
  const words = ['carpe deodorant', 'a box of white cheddar annies', 'a case of Moretti'];
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

// Reference run linked as public evidence (Dr. Bronner soap).
const REFERENCE_SESSION = "0E71CF";

const howItWorksPage = (base) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gelasio:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<title>How Barter works</title><style>${STYLE}
  .flow{display:flex;gap:8px;align-items:stretch;margin:18px 0}
  .fbox{flex:1;border:1.5px solid #1c1c1a;padding:10px 12px;font-size:14px;line-height:1.45}
  .fbox b{display:block;font-size:15px;margin-bottom:4px}
  .farrow{align-self:center;color:#C70000;font-size:20px;flex:none}
  .steps{margin:12px 0;padding-left:22px;line-height:1.6;font-size:15.5px}
  .steps li{margin:7px 0}
  .trust{border:1.5px solid #1c1c1a;padding:14px 16px;margin:18px 0;font-size:15px;line-height:1.6}
  .back{font-size:14px}
  h2{font-size:22px;margin:30px 0 8px}
  p, li{line-height:1.6}
  @keyframes flowpulse{ 0%,18%{border-color:#C70000;box-shadow:3px 3px 0 #C70000} 30%,100%{border-color:#1c1c1a;box-shadow:none} }
  .flow .fbox{animation:flowpulse 6s ease-in-out infinite}
  .flow .fbox:nth-child(3){animation-delay:1.2s}
  .flow .fbox:nth-child(5){animation-delay:2.4s}
  .flow .fbox:nth-child(7){animation-delay:3.6s}
  @media (max-width:640px){ .flow{flex-direction:column} .farrow{transform:rotate(90deg)} }
  @media (prefers-color-scheme: dark){ .fbox,.trust{border-color:#ecece7} .flow .fbox{animation-name:flowpulse-dark} @keyframes flowpulse-dark{ 0%,18%{border-color:#ff5147;box-shadow:3px 3px 0 #ff5147} 30%,100%{border-color:#ecece7;box-shadow:none} } }
  @media (prefers-reduced-motion: reduce){ .flow .fbox{animation:none} }
</style>
<p class="back"><a href="/">&larr; Barter</a></p>
<h1>How Barter works</h1>
<p class="lede">Barter is a protocol, not a store. Your own agent learns it from
<a href="/llms.txt">one text file</a>, proves a real price, and barters with
company agents who only move on prices they can verify themselves. The result
is a negotiated price your agent could not simply claim into existence.</p>

<h2>The flow</h2>
<div class="flow">
<div class="fbox"><b>Your personal agent</b>Finds one real price online and proves it.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Proof</b>A TLSNotary presentation: these bytes came from that host.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Company agents</b>Verify the proof themselves, then quote and counter.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Session record</b>Every step written down as it happens. Best offer waits for you.</div>
</div>

<h2>One barter round</h2>
<ol class="steps">
<li>The personal agent proves the lower current quote and stores that proof in the session record.</li>
<li>It presents the proof to the other vendor.</li>
<li>That vendor verifies the presentation itself and reads the price from the verified transcript, never from a claim.</li>
<li>Its policy decides the counter, subject to a hard floor. The new quote is proved and carried back the same way.</li>
<li>Rounds alternate until a vendor holds at its floor or six exchanges pass. The record closes with the best price and an approval request.</li>
</ol>

<h2>How the personal agent follows the protocol</h2>
<p>The agent is the entrypoint. There is no product form on this site. A run
adheres to the published specification: create a session first, prove one
reference price (one is enough), open conversations with both vendors using
that proof, store every proof when it is presented, report each quote and
counter to the session record, and finish with the best price, the full
session link, and a question asking approval. Chat stays minimal because the
session record is the detailed account. A three-word keyphrase in the prompt
lets the open landing page follow the same run.</p>
<p>No compatible agent handy? The reference client <code>pap</code> in the
public repository runs the same protocol end to end.</p>

<h2>How the vendors are set up</h2>
<p>Today the two companies are simulated, on purpose: the protocol is the
product being demonstrated, not their stock. Each vendor is the same agent
build on its own domain, with its own discovery document, written negotiation
policy, opening markup, and discount ceiling.</p>
<ol class="steps">
<li><a href="https://basecamp.barter.computer">Basecamp Supply</a>: lean stock on a two-week restock cycle. Opens at the proven price plus 5%, can discount up to 8%, moves a cent at a time, and spends a small promo pool slowly.</li>
<li><a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a>: deep stock on a four-week restock cycle. Opens at plus 2%, can discount up to 12%, and moves in bold steps to win the sale before the next reload lands.</li>
</ol>
<p>For each counter, Muse Spark may propose a price in the company's written
style, weighing stock cover, restock timing, discount already used, and promo
budget remaining. Deterministic code disposes: no verified proof means no
movement, nothing goes below the floor, pool limits hold, and a hard-coded
fallback takes over if the model is unavailable. Any requested item is quoted
from the proven price; there is no fixed catalogue behind the demo.</p>

<div class="trust">
<b>What a proof does and does not say.</b> A presentation proves a response
came from a named host over TLS. It does not prove the item is in stock, that
the price is wise, or what checkout will finally charge. In this demo the
prover and notary run in one service; in production the notary would be an
independent operator. The protocol does not change.
</div>

<h2>Limitations</h2>
<ol class="steps">
<li>The companies, their stock pictures, and the purchase step are simulated. The proving, verification, negotiation, and session record are real.</li>
<li>Prover and notary currently run in one service. A production deployment separates the notary operator from the prover.</li>
<li>Proofs are generated serially and take seconds each. TLSNotary works over TLS 1.2 with small, uncompressed responses, so API-shaped pages prove far better than full HTML.</li>
<li>The starting price comes from a page your agent chooses. Product variants and pack sizes can change what that price means, so check the anchor in the session record.</li>
<li>Agent behaviour varies. Some agents follow the specification end to end, some improvise, and some stop early. The session record shows what actually happened either way.</li>
<li>When Muse Spark is unavailable, vendor counters come from a deterministic fallback, and the decision trace in the record says which path decided.</li>
<li>Session links are public to anyone who has them, and the demo endpoints are unauthenticated. That is demo scope, not a production posture.</li>
<li>Nothing is bought through Barter. A run ends at a best offer, outside checkout, waiting for a person to approve it.</li>
</ol>

<h2>See it</h2>
<p><a href="/s/${REFERENCE_SESSION}">A completed run, with proofs and counters in the record</a> ·
<a href="/llms.txt">The protocol specification agents read</a> ·
<a href="https://github.com/vaughanlove/barter">Code and architecture diagrams</a></p>
<footer class="vendors">Simulated vendors: <a href="https://basecamp.barter.computer">Basecamp Supply</a> · <a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a></footer>`;

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
  put("conversation", e.conversationId);
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

function describeEvent(e) {
  const type = String(e.type ?? "event");
  const who = e.vendor ?? e.provider ?? "The vendor";
  const price = typeof e.price === "number" ? `$${e.price}` : "its price";
  const attested = typeof e.attestedPrice === "number" ? `$${e.attestedPrice}` : "a lower price";
  if (type === "quote") return `${who} quoted ${price}.`;
  if (type === "proof") return `A TLSNotary proof was stored when it was presented, attesting ${attested}${e.host ? ` from ${e.host}` : ""}.`;
  if (type === "barter") return `The personal agent presented a verified proof to ${who}${typeof e.price === "number" ? `, and the recorded result was ${price}` : ""}.`;
  if (type === "vendor.quote.issued") return `${who} issued a quote at ${price}.`;
  if (type === "vendor.offer.countered") return `${who} countered at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.offer.floor") return `${who} reached its bottom line at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.offer.held") return `${who} held at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.proof.rejected") return `${who} rejected the proof and kept its price at ${price}.`;
  if (type === "best") return `${who} had the best recorded offer at ${price}.`;
  if (type === "done") return "The run ended and waited for approval. Nothing was bought.";
  return `${type} was recorded.`;
}

function eventDetailLines(e, proofs = []) {
  const type = String(e.type ?? "event");
  const lines = [];
  if (e.ts || e.t) lines.push(`When: ${e.ts ?? e.t}`);
  lines.push(`Actor: ${type.startsWith("vendor.") ? (e.vendor ?? e.provider ?? "Vendor agent") : "Personal agent or session record"}`);
  lines.push(`What happened: ${describeEvent(e)}`);
  if (e.reason) lines.push(`Decision note: ${e.reason}`);
  if (e.note) lines.push(`Vendor note: ${e.note}`);
  if (e.style) lines.push(`Move style: ${e.style}`);
  if (e.source) lines.push(`Decision source: ${e.source}`);
  if (e.model) lines.push(`Model behind the decision: Muse Spark (${e.model})${e.modelProvider ? ` by ${e.modelProvider}` : ""}`);
  if (e.runtime) lines.push(`Vendor agent runtime: ${e.runtime}`);
  if (typeof e.stockUnits === "number") lines.push(`Stock picture: about ${e.stockUnits} units${e.stockPosture ? ` (${e.stockPosture})` : ""}. Simulated for this demo company.`);
  if (typeof e.discountUsedPct === "number") lines.push(`Discount picture: ${e.discountUsedPct}% of the opening ask used${typeof e.headroomToCeilingPct === "number" ? `, ${e.headroomToCeilingPct}% of headroom left above the bottom line` : ""}.`);
  if (typeof e.promoPoolRemainingPct === "number") lines.push(`Promo pool: ${e.promoPoolRemainingPct}% remaining this month.`);
  if (type === "proof") {
    const proof = proofs.find((pr) => String(pr.hash).startsWith(String(e.hash ?? "")))
      ?? proofs.find((pr) => pr.attested_price === e.attestedPrice && (!e.host || pr.host === e.host));
    if (proof) {
      lines.push(`Stored proof verdict: ${proof.verdict ?? "presented"}`);
      if (proof.host) lines.push(`Proof source: https://${proof.host}${proof.path ?? ""}`);
      if (proof.hash) lines.push(`Proof hash: ${String(proof.hash).slice(0, 16)}...`);
    }
  }
  if (!e.reason && !e.note && !e.message) {
    lines.push("Conversation trace: no natural-language message is recorded for this step. The agents exchanged structured protocol data, and the fields below are the trace.");
  }
  const hidden = new Set(["type", "ts", "t", "presentationB64"]);
  const fields = Object.entries(e)
    .filter(([k, v]) => !hidden.has(k) && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  if (fields.length) lines.push(`Recorded fields: ${fields.join(" · ")}`);
  return lines;
}

function decisionSummaryHtml(rec) {
  const decisions = listEvents(rec.id).filter((e) =>
    ["vendor.offer.countered", "vendor.offer.floor", "vendor.offer.held"].includes(String(e.type)),
  );
  if (!decisions.length) return "";
  const spark = decisions.filter((e) => e.model || String(e.source ?? "").startsWith("Muse Spark"));
  const fallback = decisions.length - spark.length;
  const models = [...new Set(spark.map((e) => e.model).filter(Boolean))];
  const sparkText = spark.length
    ? `<strong>${spark.length} proposed by Muse Spark</strong>${models.length ? ` (${esc(models.join(", "))})` : ""}`
    : "none proposed by Muse Spark";
  const fallbackText = fallback ? ` · ${fallback} by deterministic fallback` : "";
  return `<p class="receipt-note">Vendor decisions in this receipt: ${sparkText}${fallbackText}</p>`;
}

function treeRowsHtml(rec) {
  const events = listEvents(rec.id);
  const proofs = listProofs(rec.id);
  let lastPrice = null;
  let lastKey = "";
  const agentQuotePrices = new Set(
    events.filter((e) => e.type === "quote" && typeof e.price === "number").map((e) => e.price),
  );
  const rows = events.map((e) => {
    const type = String(e.type ?? "event");
    // One row per fact. The vendor lifecycle chatters: creation and
    // its quote are the same quote the agent also posts (the agent
    // version carries vendor and url, so it wins), a received proof
    // is already announced by the stored proof row, and a verified
    // proof is that same row's verdict badge (its price field is the
    // vendor's old price, which would read as a spurious increase).
    if (type === "vendor.conversation.created") return "";
    if (type === "vendor.proof.received") return "";
    if (type === "vendor.proof.verified") return "";
    if (type === "vendor.quote.issued" && agentQuotePrices.has(e.price)) return "";
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
    const detail = eventDetailLines(e, proofs).map((line) => esc(line)).join("<br>");
    const sparkTag = e.model || String(e.source ?? "").startsWith("Muse Spark") ? `<span class="ttag spark">SPARK</span>` : "";
    return `<div class="trow" data-type="${esc(type)}" data-price="${e.price ?? ""}" tabindex="0" role="button" aria-expanded="false" title="Inspect this action"><span class="ttag">${esc(type.split(".")[0].toUpperCase())}</span><span class="tcall">${esc(eventCall(e))}</span>${sparkTag}${verdict ? `<span class="ttag verdict">${esc(verdict)}</span>` : ""}<span class="tmove ${mv.cls}">${mv.price !== null ? esc(mv.tag) : ""}</span></div><div class="tdetail" hidden>${detail}</div>`;
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
  .ttag.spark{color:#C70000;border-color:#C70000;font-weight:700}
  .receipt-note{font-size:13.5px;line-height:1.55;color:#55534c;border:1px solid #d8d5c9;padding:9px 12px;margin:14px 0}
  .tcall{overflow:hidden;text-overflow:ellipsis}
  .tmove{margin-left:auto;flex:none;font-size:11px}
  .tmove.down{color:#137333}.tmove.up{color:#b3261e}.tmove.flat{color:#6b6b66}
  .trow[role="button"]{cursor:pointer}
  .trow.active{background:#efede6;box-shadow:inset 3px 0 #1c1c1a}
  .tdetail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;background:#f4f2ea;border-bottom:1px solid #d8d5c9;padding:8px 12px 9px 42px;white-space:normal}
  @media (prefers-color-scheme: dark){
    .tree{background:#161614;border-color:#ecece7}
    .tchildren{border-left-color:#3a3a34}
    .trow:hover{background:#24241f}
    .trow.active{background:#24241f;box-shadow:inset 3px 0 #ecece7}
    .tdetail{background:#1d1d1a;border-bottom-color:#3a3a34}
    .ttag{border-color:#ecece7}
    .ttag.verdict{background:#ecece7;color:#131313}
    .receipt-note{color:#a9a9a1;border-color:#3a3a34}
  }
</style>
<h1>${esc(rec.product || "Your barter")}</h1>
<p class="lede">Session ${rec.id} · <span id="statusText">${esc(rec.status)}</span>${rec.budget != null ? ` · budget $${rec.budget}` : ""}${rec.keyphrase ? ` · keyphrase <code>${esc(rec.keyphrase)}</code>` : ""}</p>
<div id="bestSlot">${rec.best_price != null ? `<div class="best"><div>Best offer${rec.best_vendor ? ` from ${esc(rec.best_vendor)}` : ""}</div><div class="price">$${rec.best_price}</div></div>` : ""}</div>
${decisionSummaryHtml(rec)}
<div class="tree">
<div class="troot"><span class="ttag">SESSION</span><span class="tcall">session(product="${esc(rec.product)}", status="<span id="rootStatus">${esc(rec.status)}</span>")</span><span class="tmove flat" id="callCount">${tree.count} calls</span></div>
<div class="tchildren" id="tchildren">${tree.rows || `<div class="trow"><span class="tcall">waiting for the agent to start</span></div>`}</div>
</div>
<script>
let lastPrice = ${tree.lastPrice ?? "null"};
const treeEl = document.getElementById('tchildren');
function escHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function detailLines(d){
  const type = String(d.type || 'event');
  const who = d.vendor || d.provider || 'The vendor';
  const lines = [];
  if (d.t) lines.push('When: ' + d.t);
  lines.push('Actor: ' + (type.startsWith('vendor.') ? who : 'Personal agent or session record'));
  if (type === 'vendor.offer.countered') lines.push('What happened: ' + who + ' countered at $' + d.price + ' after checking a verified $' + d.attestedPrice + ' offer.');
  else if (type === 'proof') lines.push('What happened: A TLSNotary proof was stored when it was presented' + (d.host ? ' from ' + d.host : '') + '.');
  else lines.push('What happened: ' + type + ' was recorded.');
  if (d.reason) lines.push('Decision note: ' + d.reason);
  if (d.note) lines.push('Vendor note: ' + d.note);
  if (d.style) lines.push('Move style: ' + d.style);
  if (d.source) lines.push('Decision source: ' + d.source);
  if (d.model) lines.push('Model behind the decision: Muse Spark (' + d.model + ')' + (d.modelProvider ? ' by ' + d.modelProvider : ''));
  if (d.runtime) lines.push('Vendor agent runtime: ' + d.runtime);
  if (typeof d.stockUnits === 'number') lines.push('Stock picture: about ' + d.stockUnits + ' units' + (d.stockPosture ? ' (' + d.stockPosture + ')' : '') + '. Simulated for this demo company.');
  if (typeof d.discountUsedPct === 'number') lines.push('Discount picture: ' + d.discountUsedPct + '% of the opening ask used' + (typeof d.headroomToCeilingPct === 'number' ? ', ' + d.headroomToCeilingPct + '% of headroom left above the bottom line' : '') + '.');
  if (typeof d.promoPoolRemainingPct === 'number') lines.push('Promo pool: ' + d.promoPoolRemainingPct + '% remaining this month.');
  if (!d.reason && !d.note && !d.message) lines.push('Conversation trace: no natural-language message is recorded for this step. The agents exchanged structured protocol data, and the fields below are the trace.');
  const fields = Object.entries(d).filter(([k,v]) => !['type','t','presentationB64'].includes(k) && v !== undefined && v !== null && v !== '').map(([k,v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v));
  if (fields.length) lines.push('Recorded fields: ' + fields.join(' · '));
  return lines;
}
function detailElement(d){
  const detail = document.createElement('div');
  detail.className = 'tdetail';
  detail.hidden = true;
  detail.textContent = detailLines(d).join('\\n');
  detail.style.whiteSpace = 'pre-wrap';
  return detail;
}
function setRowOpen(row, open){
  const detail = row.nextElementSibling;
  row.classList.toggle('active', open);
  row.setAttribute('aria-expanded', String(open));
  if (detail && detail.classList.contains('tdetail')) detail.hidden = !open;
}
function toggleRow(row){ setRowOpen(row, row.getAttribute('aria-expanded') !== 'true'); }
treeEl.addEventListener('click', e => {
  const row = e.target.closest('.trow[data-type]');
  if (row) toggleRow(row);
});
treeEl.addEventListener('keydown', e => {
  const row = e.target.closest('.trow[data-type]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(row); }
});
function appendRow(d){
  const rawType = String(d.type || 'event');
  if (rawType === 'vendor.proof.received' || rawType === 'vendor.conversation.created' || rawType === 'vendor.proof.verified') return;
  const price = typeof d.price === 'number' ? d.price : null;
  if (rawType === 'vendor.quote.issued' && price !== null) {
    for (const old of treeEl.querySelectorAll('[data-type="quote"]')) {
      if (Number(old.dataset.price) === price) return;
    }
  }
  if (rawType === 'quote' && price !== null) {
    for (const old of treeEl.querySelectorAll('[data-type="vendor.quote.issued"]')) {
      if (Number(old.dataset.price) === price) old.remove();
    }
  }
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
  div.dataset.type = rawType;
  div.dataset.price = price ?? '';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  div.setAttribute('aria-expanded', 'false');
  div.title = 'Inspect this action';
  const sparkTag = (d.model || String(d.source || '').startsWith('Muse Spark')) ? '<span class="ttag spark">SPARK</span>' : '';
  div.innerHTML = '<span class="ttag">' + escHtml(type.split('.')[0].toUpperCase()) + '</span><span class="tcall">' + escHtml(type.replace(/^(vendor|muse|notary)\./,'') + '(' + args.join(', ') + ')') + '</span>' + sparkTag + '<span class="tmove ' + cls + '">' + escHtml(mv) + '</span>';
  treeEl.appendChild(div);
  treeEl.appendChild(detailElement(d));
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
  const prompt = `You are the JEV price classifier. Find the current selling price of the product "${product}" in this page text. Return ONLY JSON: {"price": number|null, "currency": string, "snippet": string, "confidence": number}. price is in dollars as a plain number (convert integer cents only when the page clearly prices in cents). snippet is the exact short page text the price came from. Choose the one-time purchase price for a single unit of the named product, the default variant a buyer gets by clicking buy. Avoid subscriptions, multipacks, bundles, refills, other products, shipping, and was/now strikethrough originals.\n\nPAGE TEXT:\n${text}`;
  const useResponses = (process.env.META_PROTOCOL ?? "") === "responses";
  const res = await fetch(useResponses ? `${base}/responses` : `${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(
      useResponses
        ? { model, input: prompt, max_output_tokens: 3000, text: { format: { type: "json_object" } } }
        : {
            model,
            max_tokens: 3000,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
          },
    ),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res || !res.ok) {
    const detail = res ? (await res.text().catch(() => "")).slice(0, 240) : "";
    return { status: 200, out: { price: null, error: `classifier call failed: HTTP ${res?.status ?? "network"} ${detail}`.trim() } };
  }
  const data = await res.json().catch(() => ({}));
  let parsed = {};
  try {
    const content =
      data.choices?.[0]?.message?.content ??
      data.output_text ??
      (Array.isArray(data.output)
        ? data.output.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text
        : undefined) ??
      "{}";
    parsed = JSON.parse(content);
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
    if (req.method === "GET" && url.pathname === "/how-it-works")
      return send(res, 200, howItWorksPage(base), "text/html");
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
    if (req.method === "GET" && url.pathname === "/.well-known/poppy.json") {
      const domain = (req.headers.host ?? "").split(":")[0].toLowerCase().replace(/^www\./, "");
      return send(res, 200, {
        protocol_version: "0.1",
        organization: { name: "Barter", domain },
        web: {},
      });
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
      broadcastToSession(pm[1], { t: now(), type: "proof", hash: hash.slice(0, 12), host: body.host ?? "", attestedPrice: body.attestedPrice ?? null });
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
