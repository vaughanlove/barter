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
    source: github(REPO, { rootDirectory: "ideation/prototype" }),
    start: "node server.mjs",
    healthcheck: "/panel",
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
      MODEL_API_KEY: preserve(),
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
      VENDOR_POLICY_TEXT:
        "Cautious margin keeper. Beat a verified rival price by the smallest credible amount. Hold firm as you near your bottom line. Discounts come out of a limited monthly promo pool, so spend it slowly.",
      VENDOR_MONTHLY_POOL_USD: "250",
      MODEL_API_KEY: preserve(),
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
      VENDOR_MARKUP_PCT: "2",
      VENDOR_FLOOR_PCT: "12",
      VENDOR_UNDERCUT_MODE: "percent",
      VENDOR_UNDERCUT_PCT: "5",
      VENDOR_POLICY_TEXT:
        "Volume hunter with deep stock. Move in bold steps to win the deal quickly rather than shaving pennies. You may offer up to 20% off while the monthly promo budget lasts; winning the sale matters more than the last dollar of margin.",
      VENDOR_MONTHLY_POOL_USD: "100000",
      MODEL_API_KEY: preserve(),
      VERIFIER_URL: `${PROVE}/verify`,
      VERIFIER_TIMEOUT_MS: "10000",
      OTEL_EXPORTER_OTLP_ENDPOINT: LANDING,
    },
  });

  return project("barter", {
    resources: [landing, prove, vendorBasecamp, vendorRidgeline],
  });
});
