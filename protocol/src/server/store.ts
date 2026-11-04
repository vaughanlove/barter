import { createHash, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Railway egress can prefer IPv6, which some upstreams answer
// differently (Meta API returned model_not_found over it). IPv4 first.
setDefaultResultOrder("ipv4first");

// --- Persistent store ------------------------------------------------------
// SQLite when available (Node >= 22, node:sqlite), JSON file otherwise.
// Path from BARTER_DB_PATH; on Railway this points at the mounted volume
// (/data/barter.db) so sessions/proofs survive redeploys. Schema is the
// same one the prototype used, so the production volume keeps working.

export interface SessionRec {
  id: string;
  product: string;
  initiated_by: string;
  budget: number | null;
  status: string;
  best_price: number | null;
  best_vendor: string | null;
  created_at: string;
  updated_at: string;
  keyphrase: string | null;
}

export type Loose = Record<string, unknown>;
export type BarterEvent = { t: string; type: string } & Loose;

interface SessionState {
  events: BarterEvent[];
  clients: Set<{ write: (s: string) => void }>;
}

const DB_PATH = process.env.BARTER_DB_PATH ?? join(process.cwd(), "data", "barter.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
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
  const cols = db
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .map((c: { name: string }) => c.name);
  if (!cols.includes("keyphrase")) db.exec("ALTER TABLE sessions ADD COLUMN keyphrase TEXT");
} catch {
  db = null; // JSON fallback below
}
const jsonPath = `${DB_PATH}.json`;
let jsonStore: { sessions: SessionRec[]; events: Loose[]; proofs: Loose[] } = {
  sessions: [],
  events: [],
  proofs: [],
};
if (!db) {
  try {
    jsonStore = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    /* fresh store */
  }
}
const saveJson = () => {
  if (!db) writeFileSync(jsonPath, JSON.stringify(jsonStore));
};
export const now = () => new Date().toISOString();

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
export const normalizeKeyphrase = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
export const genKeyphrase = (): string => {
  const pick = () => KEYWORDS[randomBytes(1)[0] % KEYWORDS.length];
  return `${pick()} ${pick()} ${pick()}`;
};

const sessions = new Map<string, SessionState>();
export const logsBySession = new Map<string, Loose[]>();
const panelWriters = new Set<(payload: string) => void>();

export function getSessionByKeyphrase(phrase: string): SessionRec | null {
  const kp = normalizeKeyphrase(phrase);
  if (!kp) return null;
  return (
    [...listSessionRecs()]
      .reverse()
      .find((s) => s.keyphrase && normalizeKeyphrase(s.keyphrase) === kp) ?? null
  );
}

export function createSessionRec(input: {
  product?: string;
  initiatedBy?: string;
  budget?: number | null;
  keyphrase?: string | null;
}): SessionRec {
  const rec: SessionRec = {
    id: randomBytes(3).toString("hex").toUpperCase(),
    product: input.product || "",
    initiated_by: input.initiatedBy || "web",
    budget: input.budget ?? null,
    status: "open",
    best_price: null,
    best_vendor: null,
    created_at: now(),
    updated_at: now(),
    keyphrase: input.keyphrase ? normalizeKeyphrase(input.keyphrase) : null,
  };
  if (db) {
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      rec.id, rec.product, rec.initiated_by, rec.budget, rec.status,
      null, null, rec.created_at, rec.updated_at, rec.keyphrase,
    );
  } else {
    jsonStore.sessions.push(rec);
    saveJson();
  }
  sessions.set(rec.id, { events: [], clients: new Set() });
  return rec;
}

export function getSessionRec(id: string): SessionRec | null {
  if (db) return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) ?? null;
  return jsonStore.sessions.find((s) => s.id === id) ?? null;
}

export function listSessionRecs(): SessionRec[] {
  if (db) return db.prepare("SELECT * FROM sessions ORDER BY created_at").all();
  return [...jsonStore.sessions];
}

function touchSession(id: string, patch: Partial<SessionRec>): void {
  const rec = getSessionRec(id);
  if (!rec) return;
  Object.assign(rec, patch, { updated_at: now() });
  if (db) {
    db.prepare(
      "UPDATE sessions SET status=?, best_price=?, best_vendor=?, updated_at=? WHERE id=?",
    ).run(rec.status, rec.best_price, rec.best_vendor, rec.updated_at, id);
  } else saveJson();
}

export function persistEvent(sessionId: string, type: string, payload: Loose): void {
  const row = { session_id: sessionId, ts: now(), type, payload: JSON.stringify(payload) };
  if (db) {
    db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(row.session_id, row.ts, row.type, row.payload);
  } else {
    jsonStore.events.push(row);
    saveJson();
  }
}

export function listEvents(sessionId: string): Array<{ ts: string; type: string } & Loose> {
  const rows: Loose[] = db
    ? db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY rowid").all(sessionId)
    : jsonStore.events.filter((e) => e.session_id === sessionId);
  return rows.map((r) => ({ ts: r.ts as string, type: r.type as string, ...JSON.parse(r.payload as string) }));
}

export interface ProofRec {
  session_id?: string;
  hash: string;
  host?: string;
  path?: string;
  attested_price?: number | null;
  presentation?: string;
  verdict?: string;
  created_at?: string;
}

export function persistProof(sessionId: string, proof: ProofRec): void {
  if (db) {
    db.prepare(
      "INSERT INTO proofs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,hash) DO UPDATE SET verdict=excluded.verdict",
    ).run(
      sessionId, proof.hash, proof.host ?? "", proof.path ?? "",
      proof.attested_price ?? null, proof.presentation ?? "", proof.verdict, proof.created_at,
    );
  } else {
    const i = jsonStore.proofs.findIndex((p) => p.session_id === sessionId && p.hash === proof.hash);
    if (i >= 0) jsonStore.proofs[i] = { session_id: sessionId, ...proof };
    else jsonStore.proofs.push({ session_id: sessionId, ...proof });
    saveJson();
  }
}

export function listProofs(sessionId: string): ProofRec[] {
  return db
    ? db.prepare("SELECT * FROM proofs WHERE session_id=? ORDER BY created_at").all(sessionId)
    : (jsonStore.proofs.filter((p) => p.session_id === sessionId) as unknown as ProofRec[]);
}

// Vendor verdicts arrive server-side over OTEL, not from the agent: bind
// them to the stored proof with the same attested price in this session.
function applyVendorVerdict(sessionId: string, event: string, attrs: Loose): void {
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

export function ensureSession(id: string): SessionState {
  if (!sessions.has(id)) sessions.set(id, { events: [], clients: new Set() });
  return sessions.get(id) as SessionState;
}

export function hasSessionState(id: string): boolean {
  return sessions.has(id);
}

export function emit(id: string, type: string, data: Loose): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  const ev: BarterEvent = { t: new Date().toISOString(), type, ...data };
  s.events.push(ev);
  persistEvent(id, type, data);
  if (type === "best") {
    touchSession(id, {
      status: "best",
      best_price: typeof data.price === "number" ? data.price : null,
      best_vendor: (data.vendor as string) ?? (data.provider as string) ?? null,
    });
  }
  if (type === "done") touchSession(id, { status: "done" });
  for (const res of s.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  pushLog(id, type, data, true);
  return true;
}

// Steps that persist without going through emit (stored proofs, vendor
// OTEL verdicts) still belong on the live session page. Push them to
// any connected /s/{id} stream so live matches a refresh.
export function broadcastToSession(id: string, ev: BarterEvent): void {
  const s = sessions.get(id);
  if (!s) return;
  s.events.push(ev);
  for (const res of s.clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

export function subscribeSession(
  id: string,
  writer: { write: (s: string) => void },
  replay: boolean,
): () => void {
  const s = ensureSession(id);
  if (replay) {
    for (const ev of s.events) writer.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  s.clients.add(writer);
  return () => {
    s.clients.delete(writer);
  };
}

// --- Control panel log store (per session) --------------------------------
// Logs arrive from this service's own session events and from any service
// emitting OTLP/HTTP JSON logs (e.g. the vendor with
// OTEL_EXPORTER_OTLP_ENDPOINT=https://barter.computer). Grouped by
// sessionId, falling back to conversationId, so one barter run = one
// log stream.

export function pushLog(sessionId: string, event: string, attrs: Loose = {}, alreadyPersisted = false): Loose {
  const id = sessionId || (attrs.sessionId as string) || (attrs.conversationId as string) || "unknown";
  const log: Loose = { t: new Date().toISOString(), sessionId: id, event, ...attrs };
  if (!logsBySession.has(id)) logsBySession.set(id, []);
  (logsBySession.get(id) as Loose[]).push(log);
  if (getSessionRec(id)) {
    if (!alreadyPersisted) persistEvent(id, event, attrs);
    applyVendorVerdict(id, event, attrs);
    if (!alreadyPersisted) broadcastToSession(id, { t: log.t as string, type: event, ...attrs });
  }
  const payload = `data: ${JSON.stringify({ kind: "log", log })}\n\n`;
  for (const write of panelWriters) write(payload);
  return log;
}

export function subscribePanel(write: (payload: string) => void): () => void {
  panelWriters.add(write);
  return () => {
    panelWriters.delete(write);
  };
}

function otelValue(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o = v as Loose;
  if ("stringValue" in o) return o.stringValue;
  if ("doubleValue" in o) return o.doubleValue;
  if ("intValue" in o) return Number(o.intValue);
  if ("boolValue" in o) return o.boolValue;
  return JSON.stringify(v);
}

export function ingestOtlp(body: Loose): number {
  let count = 0;
  for (const rl of (body.resourceLogs as Loose[]) ?? []) {
    const resourceAttrs: Loose = {};
    for (const a of (rl.resource as Loose)?.attributes as Loose[] ?? []) {
      resourceAttrs[a.key as string] = otelValue(a.value);
    }
    for (const sl of (rl.scopeLogs as Loose[]) ?? []) {
      for (const rec of (sl.logRecords as Loose[]) ?? []) {
        const attrs: Loose = {};
        for (const a of (rec.attributes as Loose[]) ?? []) attrs[a.key as string] = otelValue(a.value);
        if (!attrs.vendor && resourceAttrs["service.name"]) attrs.vendor = resourceAttrs["service.name"];
        const event = (attrs["event.name"] as string) ?? ((rec.body as Loose)?.stringValue as string) ?? "log";
        delete attrs["event.name"];
        pushLog((attrs.sessionId as string) ?? (attrs.conversationId as string) ?? "", event, attrs);
        count++;
      }
    }
  }
  return count;
}

// Hydrate in-memory watch state from the persistent store on boot.
let hydrated = false;
export function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  for (const rec of listSessionRecs()) {
    const evs = listEvents(rec.id).map(({ ts, type, ...rest }) => ({ t: ts, type, ...rest }));
    sessions.set(rec.id, { events: evs as BarterEvent[], clients: new Set() });
    logsBySession.set(
      rec.id,
      listEvents(rec.id).map(({ ts, type, ...rest }) => ({ t: ts, sessionId: rec.id, event: type, ...rest })),
    );
  }
}

export const VENDORS = (): string[] =>
  [
    process.env.LANDING_VENDOR_URL ?? "http://localhost:5173",
    process.env.LANDING_VENDOR_URL_B ?? "http://localhost:5174",
  ].filter(Boolean);

export const SIDECAR_URL = process.env.LANDING_SIDECAR_URL ?? "http://localhost:8080";
export const PROVE_URL = `${SIDECAR_URL}/prove`;
export { createHash };
