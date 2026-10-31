import "./style.css";

interface Product {
  sku: string;
  name: string;
  price: number;
  currency: string;
  blurb: string;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<main class="store">
  <p class="vendor-name">Barter Dummy Vendor</p>
  <h1>Clearance</h1>
  <ul class="products" id="products"><li>Loading…</li></ul>
  <section class="agent-box">
    <h2>For agents</h2>
    <p>Discovery: <code>/.well-known/poppy.json</code></p>
    <p>Stock: <code>GET /api/products/{sku}/inventory</code> · Barter: <code>POST /poppy/conversations</code></p>
    <p>Discounts are only offered against a verified TLSNotary proof of a lower offer.</p>
  </section>
</main>`;

fetch("/api/catalog")
  .then((r) => r.json())
  .then((data: { products: Product[] }) => {
    document.querySelector("#products")!.innerHTML = data.products
      .map(
        (p) => `<li class="product">
          <div><strong>${p.name}</strong><br><span class="blurb">${p.blurb}</span><br>
          <span class="sku">SKU ${p.sku}</span></div>
          <span class="price">$${p.price}</span>
        </li>`,
      )
      .join("");
  })
  .catch(() => {
    document.querySelector("#products")!.innerHTML = "<li>Catalog unavailable</li>";
  });
