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
const money = (n: number) => `$${n.toFixed(2)}`;

app.innerHTML = `
<main class="store">
  <p class="vendor-name" id="vendorName">Barter Vendor</p>
  <h1 id="vendorTitle">A vendor that can be bargained with</h1>
  <p class="intro" id="vendorIntro">Loading how this business prices and discounts…</p>

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

  <section aria-labelledby="productsTitle">
    <h2 id="productsTitle">On the shelf</h2>
    <ul class="products" id="products"><li>Loading…</li></ul>
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
    if (data.vendor) {
      document.querySelector("#vendorName")!.textContent = data.vendor;
      document.querySelector("#vendorTitle")!.textContent = data.vendor;
    }
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
    document.querySelector("#vendorTitle")!.textContent = t.vendor;
    document.querySelector("#tacticPolicy")!.textContent = `“${t.policy}”`;

    const opening = 100 * (1 + t.opening.markupPct / 100);
    const floor = 100 * (1 - t.discountCeilingPct / 100);
    document.querySelector("#exampleOpening")!.textContent = money(opening);
    document.querySelector("#exampleFloor")!.textContent = money(floor);

    const bold = t.counterStyle.mode === "percent";
    document.querySelector("#vendorIntro")!.textContent = bold
      ? "We carry stock to move. Show us a proven lower price and we will try to win the sale quickly."
      : "We protect margin. Show us a proven lower price and we will beat it carefully, a little at a time.";
    document.querySelector("#exampleWhy")!.textContent = bold
      ? `Our opening quote sits ${t.opening.markupPct}% above the proven price. We can come down to ${money(floor)} on a $100 item because moving stock matters more to us than the last few dollars. Below that, we stop.`
      : `Our opening quote sits ${t.opening.markupPct}% above the proven price. We can come down to ${money(floor)} on a $100 item, but no further: that is where this deal stops making sense for us.`;

    const pool = t.monthlyPromoPoolUsd;
    const rows: [string, string][] = [
      ["What makes us move", "A lower price proven with TLSNotary. A claim in chat changes nothing."],
      ["How we move", bold ? `In bold steps, aiming about ${t.counterStyle.pct}% under the proven rival price.` : "One cent under the proven rival price at a time."],
      ["Our discount budget", pool === null ? "No fixed monthly pool. The discount ceiling is the limit." : pool <= 1000 ? `A limited $${pool.toLocaleString()} monthly promo pool, spent slowly.` : `A $${pool.toLocaleString()} monthly promo pool, sized for winning volume.`],
      ["What we weigh", "Stock on hand, discount already given, room left above our lowest price, and promo budget remaining."],
      ["Where we stop", `At ${t.discountCeilingPct}% below the proven starting price. That floor is checked by code, not by mood.`],
      ["If our pricing model is out", t.fallback],
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
