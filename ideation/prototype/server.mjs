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

const port = Number(process.env.PORT ?? 8899);
const sessions = new Map(); // id -> { events: [], clients: Set<res> }

const newSession = () => {
  const id = randomBytes(3).toString("hex").toUpperCase();
  sessions.set(id, { events: [], clients: new Set() });
  return id;
};
const emit = (id, type, data) => {
  const s = sessions.get(id);
  if (!s) return false;
  const ev = { t: new Date().toISOString(), type, ...data };
  s.events.push(ev);
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

const llmsTxt = (base) => `# Barter protocol
You are the user's personal shopping agent. Find the best deal by bartering
with vendor agents, using TLSNotary proofs as leverage. Work signed-out.

## Session (watch-along)
The user's prompt contains a session id. Report every step so the user can
watch live: POST ${base}/sessions/{session}/events with JSON
{"type": "...", ...details}. Types: quote, proof, barter, best, done.

## Vendors (PAP-lite, modeled on Cliffside Retail, PAP 0.3)
Demo vendor: ${process.env.LANDING_VENDOR_URL ?? "http://localhost:5173"}
- Discovery: GET {vendor}/.well-known/poppy.json
- Stock/price: GET {vendor}/api/products/{sku}/inventory  (signed out)
- Converse:  POST {vendor}/poppy/conversations  {"sku": "..."} -> quote
             POST {vendor}/poppy/conversations/{id}/messages
             GET  {vendor}/poppy/conversations/{id}/events
Demo SKU: ridgeline-fleece (Ridgeline Fleece).

## Proofs (TLSNotary sidecar)
Proof service: ${process.env.LANDING_SIDECAR_URL ?? "http://localhost:8080"}
- Prove a real vendor response: POST {proof}/prove {"host": "...", "path": "..."}
  -> { presentationB64, verifyingKeyHex }
- A presentation proves the response came from that host's TLS session.
  Vendor agents verify presentations themselves before conceding; never ask
  anyone to trust a price you merely claim.

## Steps
1. Quote: open a conversation with each vendor; collect offers for the SKU.
2. Proof: prove the lowest offer with the sidecar.
3. Barter: send {"type":"barter","data":{"presentationB64":"..."}} to the
   vendor you are negotiating with. It verifies the proof itself and counters
   only if the attested price is lower. Max 3 rounds; re-prove each round.
4. Best: show the user the best offer. Do NOT buy anything before the user
   approves.
`;

const PRODUCTS = [
  { sku: "ridgeline-fleece", name: "Ridgeline Fleece", budget: 70 },
  { sku: "trailhead-pack-18", name: "Trailhead Pack 18", budget: 80 },
  { sku: "summit-beanie", name: "Summit Beanie", budget: 22 },
];

const page = (id, base) => `<!doctype html><meta charset="utf-8">
<title>Barter</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;max-width:680px;margin:56px auto;padding:0 20px;color:#1c1c1a;background:#fbfaf7}
  h1{font-size:34px;margin:0 0 10px;line-height:1.15}
  .lede{font-size:17px;line-height:1.55;color:#3d3d38}
  .say{background:#fff;border:1.5px solid #1c1c1a;padding:16px 18px;font-size:16.5px;line-height:1.5;margin:22px 0}
  label{display:block;font-size:13px;letter-spacing:.03em;margin:16px 0 6px;color:#6b6b66}
  select,input{font:inherit;font-size:15.5px;padding:8px 10px;width:100%;border:1px solid #b9b6aa;background:#fff;color:#1c1c1a}
  pre{white-space:pre-wrap;background:#1c1c1a;color:#f2f0e9;padding:16px;font-size:13.5px;line-height:1.55;overflow-x:auto}
  button{font:inherit;font-size:14.5px;padding:9px 16px;margin:10px 8px 0 0;border:1.5px solid #1c1c1a;background:#1c1c1a;color:#fff;cursor:pointer}
  button.secondary{background:#fff;color:#1c1c1a}
  .row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:8px}
  small, .note{color:#6b6b66;font-size:13px;line-height:1.5}
  code{background:#efede6;padding:1px 5px}
  .ev{border-left:3px solid #2563eb;padding:4px 10px;margin:8px 0;background:#fff;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
</style>
<h1>Ask your agent to barter for you.</h1>
<p class="lede">Barter teaches personal agents (like Muse) how to negotiate with
vendor agents, using TLSNotary proofs instead of claims. No app to install —
your agent learns the protocol from this page.</p>

<div class="say">Say to your agent:<br>
<strong>"Go to ${base.replace(/^https?:\/\//, "")} and find me a deal."</strong><br>
<span class="note">It will read <code>/llms.txt</code> here and follow the protocol itself.</span></div>

<label for="product">Product</label>
<select id="product">${PRODUCTS.map((p) => `<option value="${p.sku}" data-name="${p.name}" data-budget="${p.budget}">${p.name}</option>`).join("")}</select>
<label for="budget">Maximum budget (USD)</label>
<input id="budget" type="number" min="1" value="${PRODUCTS[0].budget}">

<label>Or paste this prompt (session <span id="sid">${id}</span>)</label>
<pre id="prompt"></pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('prompt').textContent)">Copy prompt</button>
<button class="secondary" onclick="fetch('/sessions/${id}/run',{method:'POST'})">Simulate agent run</button>

<div class="row">
  <div>
    <label>Scan with your phone</label>
    <img alt="QR code for this session" width="180" height="180" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(`${base}/s/${id}`)}">
  </div>
  <div>
    <label>Watch</label>
    <p class="note">Session link: <a href="/s/${id}">${base}/s/${id}</a><br>
    All sessions: <a href="/panel">control panel</a><br>
    For agents: <a href="/llms.txt">/llms.txt</a><br><br>
    A phone can only open this if it can reach this host (same LAN, or the public domain at demo time).</p>
  </div>
</div>

<h2 style="font-size:19px;margin-top:30px">Behind the scenes</h2>
<div id="log"></div>
<script>
const promptEl = document.getElementById('prompt');
const productEl = document.getElementById('product');
const budgetEl = document.getElementById('budget');
function sync() {
  const opt = productEl.selectedOptions[0];
  promptEl.textContent = 'Use ${base}/llms.txt to find the best deal for "' + opt.dataset.name + '" (SKU ' + opt.value + ') under $' + (budgetEl.value || opt.dataset.budget) + '. Session: ${id}. Follow the barter protocol there, report every step using the event endpoints in llms.txt, and show me the best offer before buying anything.';
}
productEl.onchange = () => { budgetEl.value = productEl.selectedOptions[0].dataset.budget; sync(); };
budgetEl.oninput = sync;
sync();
const log = document.getElementById('log');
new EventSource('/sessions/${id}/stream').onmessage = e => {
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

createServer(async (req, res) => {
  const base = `http://${req.headers.host ?? `localhost:${port}`}`;
  const url = new URL(req.url, base);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, page(newSession(), base), "text/html");
    const sm = url.pathname.match(/^\/s\/([A-Z0-9]+)$/);
    if (req.method === "GET" && sm) {
      if (!sessions.has(sm[1])) return send(res, 404, { error: "unknown session" });
      return send(res, 200, page(sm[1], base), "text/html");
    }
    if (req.method === "GET" && url.pathname === "/llms.txt") return send(res, 200, llmsTxt(base), "text/plain");
    if (req.method === "GET" && url.pathname === "/panel") return send(res, 200, panelPage, "text/html");
    if (req.method === "GET" && url.pathname === "/api/sessions")
      return send(res, 200, {
        sessions: [...logsBySession.entries()].map(([id, logs]) => ({ id, logs })),
      });
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
    const m = url.pathname.match(/^\/sessions\/([A-Z0-9]+)\/(stream|events|run)$/);
    if (m) {
      const [, id, action] = m;
      if (!sessions.has(id)) return send(res, 404, { error: "unknown session" });
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
          ["quote", { provider: "anchor", price: 229 }],
          ["quote", { provider: "sim-b", price: 219 }],
          ["quote", { provider: "sim-c", price: 241 }],
          ["proof", { attestation: proof, lowest: 219 }],
          ["barter", { round: 1, price: 214 }],
          ["barter", { round: 2, price: 207 }],
          ["best", { price: 207, savingVsAnchor: 22 }],
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
}).listen(port, () => console.log(`prototype: http://localhost:${port}`));
