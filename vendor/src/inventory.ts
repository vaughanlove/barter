// Vendor inventory, modeled on Cliffside Retail's demo catalog
// (https://www.cliffside-retail.com/developers): outdoor gear, slug SKUs,
// prices in USD, stock by size. One demo SKU is used for bartering;
// copy this app per vendor and change prices via env (see README).

export interface ProductSize {
  size: string;
  in_stock: boolean;
  quantity: number;
}

export interface Product {
  sku: string;
  name: string;
  price: number; // current asking price, USD
  currency: "USD";
  blurb: string;
  sizes: ProductSize[];
}

const demoPrice = Number(process.env.VENDOR_PRICE ?? 76);
const sizes = (quantity: number): ProductSize[] =>
  ["S", "M", "L", "XL"].map((size) => ({ size, in_stock: quantity > 0, quantity }));

export const PRODUCTS: Product[] = [
  {
    sku: "ridgeline-fleece",
    name: "Ridgeline Fleece",
    price: demoPrice,
    currency: "USD",
    blurb: "A midweight fleece for cold mornings.",
    sizes: sizes(12),
  },
  {
    sku: "trailhead-pack-18",
    name: "Trailhead Pack 18",
    price: 88,
    currency: "USD",
    blurb: "An 18-liter daypack with a rain cover.",
    sizes: [{ size: "One size", in_stock: true, quantity: 7 }],
  },
  {
    sku: "summit-beanie",
    name: "Summit Beanie",
    price: 24,
    currency: "USD",
    blurb: "A ribbed merino wool beanie that folds into a pocket.",
    sizes: [{ size: "One size", in_stock: true, quantity: 30 }],
  },
];

// The SKU the barter demo runs on.
export const DEMO_SKU = "ridgeline-fleece";

export function listProducts(): Product[] {
  return PRODUCTS;
}

export function getProduct(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku);
}
