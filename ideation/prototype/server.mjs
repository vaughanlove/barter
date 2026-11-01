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
export const normalizeKeyphrase = (s) =>
  String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const genKeyphrase = () => {
  const pick = () => KEYWORDS[randomBytes(1)[0] % KEYWORDS.length];
  return `${pick()}-${pick()}-${pick()}-${10 + (randomBytes(1)[0] % 90)}`;
};
function getSessionByKeyphrase(phrase) {
  const kp = normalizeKeyphrase(phrase);
  if (!kp) return null;
  if (db) {
    return db.prepare("SELECT * FROM sessions WHERE keyphrase=? ORDER BY created_at DESC").get(kp) ?? null;
  }
  return [...jsonStore.sessions].reverse().find((s) => s.keyphrase === kp) ?? null;
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
  pushLog(id, type, data);
  return true;
};

// --- Control panel log store (per session) --------------------------------
// Logs arrive from the prototype's own session events and from any service
// emitting OTLP/HTTP JSON logs (e.g. the vendor with
// OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8899). Grouped by sessionId,
// falling back to conversationId, so one barter run = one log stream.
const logsBySession = new Map(); // sessionId -> [log]
const panelClients = new Set();

function pushLog(sessionId, event, attrs = {}) {
  const id = sessionId || attrs.sessionId || attrs.conversationId || "unknown";
  const log = { t: new Date().toISOString(), sessionId: id, event, ...attrs };
  if (!logsBySession.has(id)) logsBySession.set(id, []);
  logsBySession.get(id).push(log);
  if (getSessionRec(id)) {
    persistEvent(id, event, attrs);
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

const llmsTxt = (base) => `# Barter protocol
You are the user's personal shopping agent. Find the best deal by bartering
with vendor agents, using TLSNotary proofs as leverage. Work signed-out.

## Session (you start it; watch-along + record)
There is no web form. You are the entrypoint. The user's prompt may
carry a keyphrase (e.g. "Keyphrase: velvet-otter-27") shown on the
page they have open; that page is polling for this keyphrase and will
jump to the session by itself. Before anything else, create the
session: POST ${base}/sessions with JSON
{"product": "<what the user asked for>", "initiatedBy": "muse-agent",
 "keyphrase": "<keyphrase from the prompt, if any>"}
-> {"id": "...", "url": "${base}/s/{id}"}. Do not wait to report back
before bartering; proceed straight to the steps. The polling page
finds the session via the keyphrase, and you return the url at the
end. Report every step as it happens:
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
Proof service: ${process.env.LANDING_SIDECAR_URL ?? "http://localhost:8080"}
- Prove a real response: POST {proof}/prove {"host": "...", "path": "..."}
  -> { presentationB64, verifyingKeyHex }
- A presentation proves the response came from that host's TLS session.
  Vendor agents verify presentations themselves before conceding; never
  ask anyone to trust a price you merely claim.

## Steps
0. Session: create it with the prompt's keyphrase (above), then barter.
1. Anchor: find the product online and prove the first real price you
   find, wherever you found it — the sidecar proves any public HTTPS
   host. That first proof is the anchor both vendors derive from.
   Store the proof (above) right away. Prefer an API-shaped JSON
   response containing "price" (Shopify stores serve
   {host}/products/{handle}.json in this shape). If no online price
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
   {"type":"done","needsApproval":true}. Return ${base}/s/{session} to
   the user and show the best offer. Do NOT buy before the user approves.
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
`;

const landingPage = (base, missing = false) => {
  const phrase = genKeyphrase();
  return `<!doctype html><meta charset="utf-8">
<title>Barter</title><style>${STYLE}</style>
<h1>Ask your agent to barter for you.</h1>
<p class="lede">Your agent finds it online, proves the price with
TLSNotary, and barters two vendors down against each other. No app to
install — the agent learns the protocol from this page and starts the
session itself.</p>
<div class="say">Say to your agent:<br>
<strong>"Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on …"</strong><br>
<span class="note">Finish the sentence with whatever you want — deodorant, a laptop, anything — and include your keyphrase:</span>
<pre style="margin:12px 0 0">Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on [your item]. Keyphrase: ${phrase}</pre>
<button onclick="navigator.clipboard.writeText(document.querySelector('.say pre').textContent)">Copy prompt</button></div>
<p id="waiting">Waiting for your agent to start… this page jumps to your session on its own. Keyphrase: <code>${phrase}</code></p>
<form method="get" action="/follow">
<label for="phrase">On another device? Enter your keyphrase</label>
<input id="phrase" name="phrase" required placeholder="e.g. velvet-otter-27" autocomplete="off">
<button type="submit">Follow session</button>
${missing ? `<p class="note">That keyphrase was not found yet. Check the phrase in your prompt.</p>` : ""}
</form>
<p class="note">Recent sessions: <a href="/panel">control panel</a> ·
For agents: <a href="/llms.txt">/llms.txt</a></p>
${listSessionRecs().slice(-8).reverse().map((s) => `<p><a href="/s/${s.id}">${esc(s.product || "Session")} — ${s.id}</a> <span class="note">${esc(s.status)}${s.best_price != null ? ` · best $${s.best_price}` : ""}</span></p>`).join("")}
<script>
const waiting = document.getElementById('waiting');
async function poll() {
  try {
    const r = await fetch('/api/keyphrase/${phrase}');
    if (r.ok) { const d = await r.json(); location.href = d.url; return; }
  } catch {}
  setTimeout(poll, 2500);
}
poll();
</script>`;
};

function recapHtml(rec, base) {
  const events = listEvents(rec.id);
  const proofs = listProofs(rec.id);
  const sources = events.filter((e) => e.type === "quote" && (e.vendor || e.url));
  const best =
    rec.best_price != null
      ? `<div class="best"><div>Best offer${rec.best_vendor ? ` — ${esc(rec.best_vendor)}` : ""}</div><div class="price">$${rec.best_price}</div><div>For: ${esc(rec.product)} · status ${esc(rec.status)}</div></div>`
      : "";
  const timeline = events.length
    ? `<ol>${events.map((e) => { const { ts, type, ...rest } = e; return `<li><strong>${esc(type)}</strong> <span class="note">${esc(ts)}</span><br><code>${esc(JSON.stringify(rest))}</code></li>`; }).join("")}</ol>`
    : `<p class="note">No steps yet. The agent posts each quote, proof and barter here as it happens.</p>`;
  const proofList = proofs.length
    ? `<ul>${proofs.map((p) => `<li>TLSNotary proof <span class="badge">${esc(p.verdict)}</span><br><span class="note">attests ${p.attested_price != null ? `$${p.attested_price} ` : ""}from ${esc(p.host)}${esc(p.path)} · ${esc((p.presentation || "").length)} chars · sha ${esc(String(p.hash).slice(0, 12))}… · stored ${esc(p.created_at)}</span></li>`).join("")}</ul>`
    : `<p class="note">No proofs stored yet. Proofs are stored when generated, not handed back at the end.</p>`;
  const sourceList = sources.length
    ? `<ul>${sources.map((s) => `<li>${esc(s.vendor ?? "vendor")} — $${esc(s.price)} <span class="note">${esc(s.url ?? "")}</span></li>`).join("")}</ul>`
    : `<p class="note">Sources appear with each quote.</p>`;
  return `${best}<h2>Recap — ${esc(rec.product || "session")}</h2>${proofList}<h3>Timeline</h3>${timeline}<h3>Sources</h3>${sourceList}`;
}

const page = (rec, base) => `<!doctype html><meta charset="utf-8">
<title>Barter — ${esc(rec.product || rec.id)}</title><style>${STYLE}</style>
<h1>${esc(rec.product || "Your barter")}</h1>
<p class="lede">Session ${rec.id} · ${esc(rec.status)}${rec.budget != null ? ` · budget $${rec.budget}` : ""}${rec.keyphrase ? ` · keyphrase <code>${esc(rec.keyphrase)}</code>` : ""}. Your agent barters live; this page is the record.</p>
<div class="say">Say to your agent:<br>
<strong>"Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on …"</strong></div>
<label>Paste this prompt (session ${rec.id})</label>
<pre id="prompt">Use ${base}/llms.txt to find the best deal for "${esc(rec.product)}"${rec.budget != null ? ` under $${rec.budget}` : ""}. Session: ${rec.id} (use this session; do not create another). Follow the barter protocol there, report every step using the event endpoints in llms.txt, store each proof when you obtain it, and show me the best offer before buying anything. Return ${base}/s/${rec.id} when done.</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('prompt').textContent)">Copy prompt</button>
<button class="secondary" onclick="fetch('/sessions/${rec.id}/run',{method:'POST'})">Simulate agent run</button>
<div class="row">
  <div><label>Scan with your phone</label>
    <img alt="QR code for this session" width="180" height="180" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(`${base}/s/${rec.id}`)}"></div>
  <div><label>Watch</label>
    <p class="note">Session link: <a href="/s/${rec.id}">${base}/s/${rec.id}</a><br>
    All sessions: <a href="/panel">control panel</a><br>
    For agents: <a href="/llms.txt">/llms.txt</a></p></div>
</div>
<div id="recap">${recapHtml(rec, base)}</div>
<h2 style="font-size:19px;margin-top:30px">Live</h2>
<div id="log"></div>
<script>
const log = document.getElementById('log');
new EventSource('/sessions/${rec.id}/stream').onmessage = e => {
  const d = JSON.parse(e.data);
  const div = document.createElement('div');
  div.className = 'ev';
  div.textContent = d.type + ': ' + JSON.stringify(d);
  log.prepend(div);
};
</script>`;

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
    if (req.method === "GET" && url.pathname === "/panel") return send(res, 200, panelPage, "text/html");
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const persisted = listSessionRecs().map((rec) => ({
        id: rec.id,
        product: rec.product,
        status: rec.status,
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
        for (const ev of sessions.get(id).events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
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
