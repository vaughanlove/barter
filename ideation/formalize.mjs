#!/usr/bin/env node
/**
 * Formalize a hand-drawn diagram into a polished Mermaid sequence diagram.
 *
 * Agent pipeline (Meta AI API, OpenAI-compatible, key from .env MODEL_API_KEY):
 *   1. Transcribe — vision model reads the sketch -> structured JSON
 *      (participants left->right, messages top->bottom).
 *   2. Synthesize — text model turns the transcript + repo context into
 *      Mermaid `sequenceDiagram` source and a Markdown spec.
 *   3. Critic — model re-checks the Mermaid against the transcript and the
 *      image, returns a corrected final version.
 *
 * Usage:
 *   node ideation/formalize.mjs [input.png] [--model muse-spark-1.3]
 * Defaults: input ideation/handdrawn/v0.png, out dir ideation/formalized/,
 * version tag derived from the input stem (v0 -> v1).
 *
 * Outputs (in ideation/formalized/):
 *   <tag>.mmd   Mermaid source (primary, diffable artifact)
 *   <tag>.html  standalone polished viewer (Mermaid via CDN)
 *   <tag>.md    spec: transcript table, loop semantics, code mapping
 *   <tag>.transcript.json  raw agent transcript (provenance)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- config ---------------------------------------------------------------
function loadEnv() {
  const p = resolve(root, ".env");
  if (!p) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const MODEL = modelFlag >= 0 ? args[modelFlag + 1] : "muse-spark-1.3";
const inputArg = args.find((a) => !a.startsWith("--") && a !== MODEL) ?? "ideation/handdrawn/v0.png";
const inputPath = resolve(root, inputArg);
const stem = basename(inputPath).replace(/\.\w+$/, ""); // v0
const tag = stem.replace(/^v(\d+)$/, (_, n) => `v${Number(n) + 1}`); // v0 -> v1
const outDir = resolve(root, "ideation/formalized");
const BASE = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
const KEY = process.env.MODEL_API_KEY;
if (!KEY) { console.error("Missing MODEL_API_KEY (set it in .env)"); process.exit(1); }

// --- API helper -------------------------------------------------------------
async function chat(messages, { maxTokens = 6000, json = false } = {}) {
  const body = { model: MODEL, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  const content = data.choices?.[0]?.message?.content ?? "";
  console.log(`  · ${MODEL} ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${data.usage?.total_tokens ?? "?"} tokens`);
  return content;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`No JSON in model output:\n${text.slice(0, 800)}`);
  return JSON.parse(raw.slice(start, end + 1));
}
function extractMermaid(text) {
  const fenced = text.match(/```mermaid\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  if (!raw.includes("sequenceDiagram")) throw new Error(`No sequenceDiagram in output:\n${text.slice(0, 800)}`);
  return raw;
}

// Repo context so diagram labels map to real code, not just handwriting.
const REPO_CONTEXT = `
Repo context (barter): a buyer agent ("MUSE") negotiates with a vendor.
- tlsn-sidecar/: TLSNotary proof service (Railway). POST /prove {host, path}
  -> selectively disclosed MPC-TLS presentation; POST /verify {presentationB64};
  GET /pubkey. The old Void dev notary (notary/) is deprecated fallback only.
- vendor/: vendor storefront site (Vite app).
So "gen. proof" ~= asking the notary to attest the lowest-offer transcript,
and "lowest?" ~= re-verifying / re-attesting during barter rounds.`;

// --- step 1: transcribe -------------------------------------------------------
async function transcribe(imageB64) {
  console.log("Step 1/3 — transcribing sketch (vision)…");
  const out = await chat([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Transcribe this hand-drawn sequence diagram exactly. Return ONLY JSON:
{"title": string,
 "participants": [{"id": string, "label": string, "kind": "actor"|"participant"}],
 "messages": [{"n": number, "from": string, "to": string, "label": string, "style": "solid"|"dashed", "note": string}]}
Rules: participants in left-to-right order — include the stick figure on the
far left even though it has no text label (label it "User"). Messages in
top-to-bottom order. Transcribe labels verbatim (expand abbreviations in
"note" only). A long horizontal line with an arrowhead is a return/response
message even if unlabeled — include it with label "" and explain in "note".`,
        },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
      ],
    },
  ], { maxTokens: 8000 });
  return extractJson(out);
}

// --- step 2: synthesize -------------------------------------------------------
async function synthesize(transcript) {
  console.log("Step 2/3 — synthesizing Mermaid + spec…");
  const out = await chat([
    {
      role: "user",
      content: `Turn this diagram transcript into a formal Mermaid sequence diagram.
${REPO_CONTEXT}

Transcript JSON:
${JSON.stringify(transcript, null, 2)}

Return ONLY JSON: {"mermaid": string, "specMarkdown": string}
Mermaid requirements:
- Start with "sequenceDiagram", use "actor" for the human, "participant" otherwise.
- Number every message (1., 2., …) in flow order. Use ->> for requests, -->> for responses/proofs.
- Wrap the repeating barter exchange in a "loop Barter rounds" block.
- Keep labels short; expand abbreviations (req. -> Request, lev. -> leverage).
- Add one "Note over" only where it clarifies the proof/leverage idea.
specMarkdown: a concise spec with (a) one-paragraph summary, (b) a table of the
numbered messages (n, from, to, meaning), (c) loop semantics, (d) how steps map
to the notary/vendor code above, (e) open questions the sketch leaves unanswered.`,
    },
  ], { maxTokens: 10000 });
  const parsed = extractJson(out);
  return { mermaid: extractMermaid(parsed.mermaid ?? out), spec: parsed.specMarkdown ?? "" };
}

// --- step 3: critic -------------------------------------------------------------
async function critique(transcript, draft) {
  console.log("Step 3/3 — critic pass (fixing against transcript)…");
  const out = await chat([
    {
      role: "user",
      content: `You are a strict diagram critic. Compare the Mermaid draft against
the transcript. Fix any: missing/extra/reordered messages, wrong direction,
missing loop, unlabeled participant, unnumbered message, invalid Mermaid syntax.
Return ONLY the corrected Mermaid inside a \`\`\`mermaid fence. No prose.

Transcript:
${JSON.stringify(transcript, null, 2)}

Draft:
\`\`\`mermaid
${draft.mermaid}
\`\`\``,
    },
  ], { maxTokens: 12000 });
  if (!out.includes("sequenceDiagram")) {
    console.warn("  ! critic returned no diagram — keeping the step-2 draft");
    return draft.mermaid;
  }
  return extractMermaid(out);
}

// --- render: standalone HTML ------------------------------------------------------
function renderHtml(mermaid, title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-system, system-ui, "Segoe UI", Roboto, sans-serif; background: #f4f6fb; color: #16233f; }
  header { padding: 28px 32px 8px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p.sub { margin: 0; color: #5a6b8c; font-size: 14px; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 32px 40px; }
  .card { background: #fff; border: 1px solid #dde4f2; border-radius: 14px; padding: 28px; box-shadow: 0 8px 30px rgba(22,35,63,.06); overflow-x: auto; }
  .mermaid { display: flex; justify-content: center; }
  footer { max-width: 1200px; margin: 0 auto; padding: 0 32px 28px; color: #8494b3; font-size: 12.5px; }
  code { background: #eef2fa; padding: 1px 5px; border-radius: 5px; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p class="sub">Formalized from <code>ideation/handdrawn/${stem}.png</code> by <code>ideation/formalize.mjs</code> (Meta AI agent pipeline). Source: <code>${tag}.mmd</code> · Spec: <code>${tag}.md</code></p>
</header>
<main><div class="card"><pre class="mermaid">
${mermaid.replace(/</g, "&lt;")}
</pre></div></main>
<footer>Regenerate: <code>node ideation/formalize.mjs</code> — requires MODEL_API_KEY in .env. Renders with Mermaid.js from CDN; the .mmd source also renders natively on GitHub.</footer>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: "base", themeVariables: {
    primaryColor: "#eaf0ff", primaryBorderColor: "#3b5bdb", primaryTextColor: "#16233f",
    lineColor: "#3b5bdb", secondaryColor: "#fff4e0", actorBkg: "#eaf0ff", actorBorder: "#3b5bdb",
    noteBkgColor: "#fff4e0", noteBorderColor: "#e8a33d", fontFamily: "ui-sans-system, system-ui, sans-serif"
  }, sequence: { mirrorActors: false, messageAlign: "center" } });
</script>
</body>
</html>
`;
}

// --- main ---------------------------------------------------------------------------
const imageB64 = readFileSync(inputPath).toString("base64");
console.log(`Formalizing ${inputArg} -> ideation/formalized/${tag}.*  (model: ${MODEL})`);
const transcript = await transcribe(imageB64);
console.log(`  participants: ${transcript.participants.map((p) => p.label).join(" | ")}`);
console.log(`  messages: ${transcript.messages.length}`);
const draft = await synthesize(transcript);
const mermaid = await critique(transcript, draft);

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, `${tag}.transcript.json`), JSON.stringify(transcript, null, 2) + "\n");
writeFileSync(resolve(outDir, `${tag}.mmd`), mermaid + "\n");
writeFileSync(resolve(outDir, `${tag}.md`),
  `# Barter protocol — sequence diagram (${tag})\n\n` +
  `> Formalized from [\`../handdrawn/${stem}.png\`](../handdrawn/${stem}.png) by \`node ideation/formalize.mjs\` ` +
  `(agent: ${MODEL}). Diagram source: [\`${tag}.mmd\`](${tag}.mmd) · Viewer: [\`${tag}.html\`](${tag}.html)\n\n` +
  draft.spec + "\n");
writeFileSync(resolve(outDir, `${tag}.html`), renderHtml(mermaid, `Barter protocol — ${tag}`));
console.log(`Done:\n  ideation/formalized/${tag}.mmd\n  ideation/formalized/${tag}.html\n  ideation/formalized/${tag}.md\n  ideation/formalized/${tag}.transcript.json`);
