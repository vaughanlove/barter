// Barter demo — Railway Infrastructure as Code.
// One file for the whole project. Apply with:
//   railway login && railway link
//   railway config plan     (preview)
//   railway config apply    (apply after confirmation)
// Docs: https://docs.railway.com/infrastructure-as-code
//
// Topology:
//   barter.vaughan.love     -> landing  (landing page, /llms.txt, control panel)
//   prove.vaughan.love      -> prove    (TLSNotary sidecar)
//   basecamp.vaughan.love   -> vendor-basecamp   (dummy vendor, barter target)
//   ridgeline.vaughan.love  -> vendor-ridgeline  (dummy vendor, lowest quote)
// The Muse agent (on-device) is the orchestrator and is not deployed here.

import { defineRailway, github, preserve, project, service } from "railway/iac";

const REPO = "vaughanlove/barter";
const LANDING = "https://barter.vaughan.love";
const PROVE = "https://prove.vaughan.love";
const VENDOR_A = "https://basecamp.vaughan.love";
const VENDOR_B = "https://ridgeline.vaughan.love";

export default defineRailway(() => {
  const landing = service("landing", {
    source: github(REPO, { rootDirectory: "ideation/prototype" }),
    start: "node server.mjs",
    healthcheck: "/panel",
    domains: ["barter.vaughan.love"],
    env: {
      LANDING_VENDOR_URL: VENDOR_A,
      LANDING_SIDECAR_URL: PROVE,
    },
  });

  const prove = service("prove", {
    source: github(REPO, { rootDirectory: "tlsn-sidecar" }),
    healthcheck: "/health",
    domains: ["prove.vaughan.love"],
    env: {
      // Set the real value in Railway once (or before first apply):
      //   openssl rand -hex 32
      // preserve() keeps whatever is already set on the service.
      NOTARY_SIGNING_KEY_HEX: preserve(),
      TLSN_ALLOWED_HOSTS: "basecamp.vaughan.love,ridgeline.vaughan.love,example.com",
      TLSN_MAX_RECV_DATA: "16384",
    },
  });

  const vendorBasecamp = service("vendor-basecamp", {
    source: github(REPO, { rootDirectory: "vendor" }),
    build: "pnpm build",
    start: "pnpm preview --host 0.0.0.0 --port $PORT",
    healthcheck: "/health",
    domains: ["basecamp.vaughan.love"],
    env: {
      VENDOR_NAME: "Basecamp Supply",
      VENDOR_PRICE: "84",
      VENDOR_FLOOR: "68",
      VENDOR_UNDERCUT: "3",
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
    domains: ["ridgeline.vaughan.love"],
    env: {
      VENDOR_NAME: "Ridgeline Outfitters",
      VENDOR_PRICE: "72",
      VENDOR_FLOOR: "64",
      VENDOR_UNDERCUT: "3",
      VERIFIER_URL: `${PROVE}/verify`,
      VERIFIER_TIMEOUT_MS: "10000",
      OTEL_EXPORTER_OTLP_ENDPOINT: LANDING,
    },
  });

  return project("barter", {
    resources: [landing, prove, vendorBasecamp, vendorRidgeline],
  });
});
