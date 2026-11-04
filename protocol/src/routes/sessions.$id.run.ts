import { createHash } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "../server/http";
import { emit, ensureSession, getSessionRec, hasSessionState, hydrate, VENDORS, type Loose } from "../server/store";

export const Route = createFileRoute("/sessions/$id/run")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        hydrate();
        if (!getSessionRec(params.id) && !hasSessionState(params.id)) {
          return json(404, { error: "unknown session" });
        }
        ensureSession(params.id);
        // Simulated agent: quote -> proof -> 2 barter rounds -> best.
        const proof = createHash("sha256").update(`lowest-offer:${params.id}`).digest("hex").slice(0, 16);
        const steps: Array<[string, Loose]> = [
          ["quote", { vendor: "Ridgeline Outfitters", url: VENDORS()[1], price: 219 }],
          ["quote", { vendor: "Basecamp Supply", url: VENDORS()[0], price: 229 }],
          ["proof", { attestation: proof, lowest: 219 }],
          ["barter", { round: 1, price: 214 }],
          ["barter", { round: 2, price: 207 }],
          ["best", { price: 207, vendor: "Basecamp Supply", savingVsAnchor: 22 }],
          ["done", { needsApproval: true }],
        ];
        steps.forEach(([type, data], i) => setTimeout(() => emit(params.id, type, data), 300 * (i + 1)));
        return json(202, { ok: true, session: params.id });
      },
    },
  },
});
