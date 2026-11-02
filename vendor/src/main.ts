import "./style.css";

interface Product {
  sku: string;
  name: string;
  price: number;
  currency: string;
  blurb: string;
}

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
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

app.innerHTML = `
<main class="store">
  <p class="vendor-name" id="vendorName">Barter Vendor</p>
  <h1>Clearance</h1>
  <ul class="products" id="products"><li>Loading…</li></ul>
  <section class="tactics" aria-labelledby="tacticsTitle">
    <h2 id="tacticsTitle">How this vendor barters</h2>
    <p id="tacticPolicy">Loading the live policy for this vendor…</p>
    <dl class="tactic-grid" id="tacticGrid"></dl>
    <p class="tactic-note">The exact bottom line for a live conversation is not published. The maximum discount and decision rules are.</p>
  </section>
  <section class="agent-box">
    <h2>For agents</h2>
    <p>Discovery: <code>/.well-known/poppy.json</code></p>
    <p>Stock: <code>GET /api/products/{sku}/inventory</code> · Barter: <code>POST /poppy/conversations</code></p>
    <p>Discounts are only offered against a verified TLSNotary proof of a lower offer.</p>
  </section>
</main>`;

fetch("/api/catalog")
  .then((r) => r.json())
  .then((data: { vendor?: string; products: Product[] }) => {
    if (data.vendor) document.querySelector("#vendorName")!.textContent = data.vendor;
    document.querySelector("#products")!.innerHTML = data.products
      .map(
        (p) => `<li class="product">
          <div><strong>${esc(p.name)}</strong><br><span class="blurb">${esc(p.blurb)}</span><br>
          <span class="sku">SKU ${esc(p.sku)}</span></div>
          <span class="price">$${p.price}</span>
        </li>`,
      )
      .join("");
  })
  .catch(() => {
    document.querySelector("#products")!.innerHTML = "<li>Catalog unavailable</li>";
  });

fetch("/api/tactics")
  .then((r) => r.json())
  .then((t: Tactics) => {
    document.querySelector("#vendorName")!.textContent = t.vendor;
    document.querySelector("#tacticPolicy")!.textContent = t.policy;
    const counter = t.counterStyle.mode === "percent"
      ? `Prefers a bold step, aiming about ${t.counterStyle.pct}% under a verified rival price.`
      : "Prefers to land just one cent under a verified rival price.";
    const rows: [string, string][] = [
      ["Proof gate", t.proofGate],
      ["Opening quote", `The ${t.opening.basis}, plus ${t.opening.markupPct}%.`],
      ["Maximum discount", `${t.discountCeilingPct}% below that verified starting price.`],
      ["Counter style", counter],
      ["Decision process", t.decisionProcess],
      ["If the model is unavailable", t.fallback],
      ["Monthly promo pool", t.monthlyPromoPoolUsd === null ? "No fixed pool is declared." : `$${t.monthlyPromoPoolUsd.toLocaleString()} across discounted sales.`],
    ];
    document.querySelector("#tacticGrid")!.innerHTML = rows
      .map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`)
      .join("");
  })
  .catch(() => {
    document.querySelector("#tacticPolicy")!.textContent =
      "This vendor only moves on a verified TLSNotary proof of a lower price, in measured steps, and never below its discount ceiling.";
  });
