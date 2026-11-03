import "./style.css";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";

interface Tactics {
  vendor: string;
  policy: string;
  proofGate: string;
  opening: { basis: string; markupPct: number };
  discountCeilingPct: number;
  counterStyle: { mode: string; pct: number };
  decisionProcess: string;
  fallback: string;
  monthlyPromoPoolUsd: number | null;
  business: {
    stockUnits: number;
    monthlyDemandUnits: number;
    stockCoverMonths: number;
    monthlyReloadUnits: number;
    restockCycleWeeks: number;
    stockedDaysAgo: number;
    daysToRestock: number;
    daysLeftInMonth: number;
    salesPacePct: number;
    urgency: string;
    why: string;
  };
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const money = (n: number) => `$${n.toFixed(2)}`;

app.innerHTML = `
<main class="store">
  <p class="vendor-name" id="vendorName">Barter Vendor</p>
  <h1 id="vendorTitle">A vendor that can be bargained with</h1>
  <p class="intro" id="vendorIntro">Loading how this business prices and discounts…</p>

  <section class="business" aria-labelledby="businessTitle">
    <h2 id="businessTitle">This month at this business</h2>
    <p id="businessWhy">Loading the sales picture…</p>
    <dl class="metric-strip" id="businessMetrics"></dl>
    <p class="stock-note">No fixed shelf: ask for any item and this vendor quotes it from the proven price, with a stock picture simulated for that item at quote time.</p>
  </section>

  <section class="example" aria-labelledby="exampleTitle">
    <h2 id="exampleTitle">What a discount looks like here</h2>
    <p class="example-lede">Suppose your agent proves a real online price of <strong>$100</strong>.</p>
    <ol class="price-steps">
      <li><span>Proven online price</span><strong>$100.00</strong></li>
      <li><span>Our opening quote</span><strong id="exampleOpening">…</strong></li>
      <li><span>Lowest we can go</span><strong id="exampleFloor">…</strong></li>
    </ol>
    <p id="exampleWhy">We only move between those numbers when a lower price is proven, never because someone simply claims one.</p>
  </section>

  <section class="context" aria-labelledby="contextTitle">
    <h2 id="contextTitle">Why those are our numbers</h2>
    <blockquote id="tacticPolicy">Loading our policy…</blockquote>
    <dl class="tactic-grid" id="tacticGrid"></dl>
  </section>

  <section class="ask" aria-labelledby="askTitle">
    <h2 id="askTitle">Ask this vendor</h2>
    <p class="ask-lede">Questions about the shop and how bargaining works. Discounts never happen in chat — they only move against a verified price through the agent API.</p>
    <div class="ask-log" id="askLog" aria-live="polite"></div>
    <form class="ask-form" id="askForm">
      <label class="ask-label" for="askInput">Your question</label>
      <div class="ask-row">
        <input id="askInput" name="question" type="text" autocomplete="off" placeholder="How does the discount work?" />
        <button type="submit" id="askButton">Ask</button>
      </div>
      <p class="ask-status" id="askStatus"></p>
    </form>
  </section>

  <section class="agent-box">
    <h2>For agents</h2>
    <p>Discovery: <code>/.well-known/poppy.json</code></p>
    <p>Stock: <code>GET /api/products/{sku}/inventory</code> · Barter: <code>POST /poppy/conversations</code></p>
    <p>Discounts are only offered against a verified TLSNotary proof of a lower offer.</p>
  </section>
</main>`;

fetch("/api/tactics")
  .then((r) => r.json())
  .then((t: Tactics) => {
    document.querySelector("#vendorName")!.textContent = t.vendor;
    document.querySelector("#vendorTitle")!.textContent = t.vendor;
    document.querySelector("#tacticPolicy")!.textContent = `“${t.policy.split(". ")[0]}.”`;

    const opening = 100 * (1 + t.opening.markupPct / 100);
    const floor = 100 * (1 - t.discountCeilingPct / 100);
    document.querySelector("#exampleOpening")!.textContent = money(opening);
    document.querySelector("#exampleFloor")!.textContent = money(floor);

    const b = t.business;
    document.querySelector("#businessWhy")!.textContent = b.why;
    const metrics: [string, string][] = [
      ["Last stocked", `${b.stockedDaysAgo} days ago`],
      ["Restock cycle", `Every ${b.restockCycleWeeks} weeks`],
      ["Next reload", `${b.monthlyReloadUnits} units in ${b.daysToRestock} days`],
      ["Stock cover", `${b.stockCoverMonths} months`],
    ];
    document.querySelector("#businessMetrics")!.innerHTML = metrics
      .map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`)
      .join("");

    const bold = t.counterStyle.mode === "percent";
    document.querySelector("#vendorIntro")!.textContent = bold
      ? "We price to move stock. Show us a proven lower price and our agent can discount hard to win the sale today."
      : "We price to protect margin. Show us a proven lower price and our agent will beat it carefully, a little at a time.";
    document.querySelector("#exampleWhy")!.textContent = bold
      ? "Moving stock matters more to us than the last few dollars. Below that floor, we stop."
      : "Below that floor, the deal stops making sense for us.";

    const rows: [string, string][] = [
      ["What makes us move", "A lower price, proven. A claim changes nothing."],
      [
        "How we move",
        bold
          ? `Bold steps, about ${t.counterStyle.pct}% under the proven price.`
          : "One cent under the proven price at a time.",
      ],
      ["Where we stop", `${t.discountCeilingPct}% below the proven price, checked by code.`],
    ];
    document.querySelector("#tacticGrid")!.innerHTML = rows
      .map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`)
      .join("");
  })
  .catch(() => {
    document.querySelector("#vendorIntro")!.textContent =
      "Show us a proven lower price and we may move. A claim in chat changes nothing.";
    document.querySelector("#tacticPolicy")!.textContent =
      "“Move only on a verified lower price, in measured steps, and never below the discount ceiling.”";
  });

// Storefront chat, powered by TanStack AI (@tanstack/ai-client). The
// server route (POST /api/chat) holds the model key and the system
// prompt; this page only renders the streamed snapshot. When the model
// is not configured the form reports that instead of failing silently.
const askLog = document.querySelector<HTMLDivElement>("#askLog")!;
const askForm = document.querySelector<HTMLFormElement>("#askForm")!;
const askInput = document.querySelector<HTMLInputElement>("#askInput")!;
const askButton = document.querySelector<HTMLButtonElement>("#askButton")!;
const askStatus = document.querySelector<HTMLParagraphElement>("#askStatus")!;

const storefrontChat = new ChatClient({
  connection: fetchServerSentEvents("/api/chat"),
  threadId: "vendor-storefront",
});

function renderAsk(): void {
  const { messages, isLoading, error } = storefrontChat.getSnapshot();
  askLog.innerHTML = messages
    .map((message) => {
      const text = message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
      if (!text) return "";
      const who = message.role === "user" ? "You" : "Vendor";
      const cls = message.role === "user" ? "ask-user" : "ask-vendor";
      return `<div class="ask-msg ${cls}"><span class="ask-who">${who}</span><p>${esc(text)}</p></div>`;
    })
    .join("");
  askButton.disabled = isLoading;
  askStatus.textContent = error
    ? "The vendor agent could not answer just now. The shop details above still stand."
    : isLoading
      ? "Thinking…"
      : "";
}

storefrontChat.subscribeSnapshot(renderAsk);
storefrontChat.attach();
renderAsk();

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (!question) return;
  askInput.value = "";
  void storefrontChat.sendMessage(question).catch(() => {
    // Snapshot error state renders the fallback note in renderAsk.
  });
});
