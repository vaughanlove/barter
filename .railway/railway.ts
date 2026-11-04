// Barter demo — Railway Infrastructure as Code.
// One file for the whole project. Apply with:
//   railway login && railway link
//   railway config plan     (preview)
//   railway config apply    (apply after confirmation)
// Docs: https://docs.railway.com/infrastructure-as-code
//
// Topology:
//   barter.computer              -> landing  (landing page, /llms.txt, control panel)
//   prove.barter.computer        -> prove    (TLSNotary sidecar)
//   basecamp.barter.computer     -> vendor-basecamp   (dummy vendor, barter target)
//   ridgeline.barter.computer    -> vendor-ridgeline  (dummy vendor, lowest quote)
// The Muse agent (on-device) is the orchestrator and is not deployed here.

import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

const REPO = "vaughanlove/barter";
const LANDING = "https://barter.computer";
const PROVE = "https://prove.barter.computer";
const VENDOR_A = "https://basecamp.barter.computer";
const VENDOR_B = "https://ridgeline.barter.computer";

export default defineRailway(() => {
  const landing = service("landing", {
    // TanStack Start app (was ideation/prototype/server.mjs; parity
    // port lives in protocol/, same SQLite volume and routes).
    source: github(REPO, { rootDirectory: "protocol" }),
    build: "pnpm build",
    start: "pnpm start",
    healthcheck: "/health",
    domains: ["barter.computer"],
    volumeMounts: {
      "/data": volume("landing-data", { sizeMB: 1024, region: "us-west2" }),
    },
    env: {
      LANDING_VENDOR_URL: VENDOR_A,
      LANDING_VENDOR_URL_B: VENDOR_B,
      LANDING_SIDECAR_URL: PROVE,
      BARTER_DB_PATH: "/data/barter.db",
      // JEV price classifier key. Set once in Railway; IaC keeps it.
      // Via the Cloudflare egress proxy like the vendors: the value is
      // the proxy token, not the real Meta key (see egress-proxy/).
      MODEL_API_KEY: preserve(),
      META_API_BASE_URL: "https://barter-meta-egress.vaughanelove.workers.dev/v1",
    },
  });

  const prove = service("prove", {
    source: github(REPO, { rootDirectory: "tlsn-sidecar" }),
    healthcheck: "/health",
    domains: ["prove.barter.computer"],
    env: {
      // Set the real value in Railway once (or before first apply):
      //   openssl rand -hex 32
      // preserve() keeps whatever is already set on the service.
      NOTARY_SIGNING_KEY_HEX: preserve(),
      // No TLSN_ALLOWED_HOSTS: the sidecar proves any public HTTPS host
      // (SSRF guards in the sidecar still refuse non-public addresses).
      // The vendors anchor to the first proof the agent generates.
      TLSN_MAX_RECV_DATA: "65536",
    },
  });

  const vendorBasecamp = service("vendor-basecamp", {
    source: github(REPO, { rootDirectory: "vendor" }),
    build: "pnpm build",
    start: "pnpm preview --host 0.0.0.0 --port $PORT",
    healthcheck: "/health",
    domains: ["basecamp.barter.computer"],
    env: {
      VENDOR_NAME: "Basecamp Supply",
      VENDOR_PRICE: "84",
      VENDOR_FLOOR: "68",
      VENDOR_UNDERCUT: "3",
      VENDOR_MARKUP_PCT: "5",
      VENDOR_FLOOR_PCT: "8",
      VENDOR_UNDERCUT_MODE: "penny",
      VENDOR_RESTOCK_WEEKS: "2",
      VENDOR_POLICY_TEXT:
        "Margin keeper with lean stock and no pressure to clear. Beat a verified rival price by the smallest credible amount and hold firm near the bottom line. Selling one unit at full margin beats discounting ten. Discounts come out of a limited monthly promo pool, so spend it slowly.",
      VENDOR_MONTHLY_POOL_USD: "250",
      MODEL_API_KEY: preserve(),
      VENDOR_AGENT_RUNTIME: "TanStack AI",
      // Meta API via the Cloudflare egress proxy (Railway egress is
      // blocked by Meta). MODEL_API_KEY holds the proxy token, not the
      // real Meta key; see egress-proxy/README.md.
      META_API_BASE_URL: "https://barter-meta-egress.vaughanelove.workers.dev/v1",
      VERIFIER_URL: `${PROVE}/verify`,
      VERIFIER_TIMEOUT_MS: "10000",
      OTEL_EXPORTER_OTLP_ENDPOINT: LANDING,
    },
  });

  const vendorRidgeline = service("vendor-ridgeline", {
    source: github(REPO, { rootDirectory: "vendor" }),
    build: "pnpm build",
    start: "pnpm preview --host 0.0.0.0 --port $PORT",
    healthcheck: "/health",
    domains: ["ridgeline.barter.computer"],
    env: {
      VENDOR_NAME: "Ridgeline Outfitters",
      VENDOR_PRICE: "72",
      VENDOR_FLOOR: "64",
      VENDOR_UNDERCUT: "3",
      // Opens under the found price, so the first proved rival quote
      // (and the first counter against it) lands below the found price
      // instead of a cent under a quote that is still above it.
      VENDOR_MARKUP_PCT: "-3",
      VENDOR_FLOOR_PCT: "12",
      VENDOR_UNDERCUT_MODE: "percent",
      VENDOR_UNDERCUT_PCT: "5",
      VENDOR_RESTOCK_WEEKS: "4",
      VENDOR_POLICY_TEXT:
        "Volume seller carrying months of stock with a full reload landing next month. Near month end, turning inventory into revenue beats holding it for a better margin. Move in bold steps to win the sale today rather than shaving pennies. You may offer up to 20% off while the monthly promo budget lasts.",
      VENDOR_MONTHLY_POOL_USD: "100000",
      MODEL_API_KEY: preserve(),
      VENDOR_AGENT_RUNTIME: "TanStack AI",
      // Meta API via the Cloudflare egress proxy (Railway egress is
      // blocked by Meta). MODEL_API_KEY holds the proxy token, not the
      // real Meta key; see egress-proxy/README.md.
      META_API_BASE_URL: "https://barter-meta-egress.vaughanelove.workers.dev/v1",
      VERIFIER_URL: `${PROVE}/verify`,
      VERIFIER_TIMEOUT_MS: "10000",
      OTEL_EXPORTER_OTLP_ENDPOINT: LANDING,
    },
  });

  return project("barter", {
    resources: [landing, prove, vendorBasecamp, vendorRidgeline],
  });
});
