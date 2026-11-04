import { createHash } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { json, readJsonBody } from "../server/http";
import {
  broadcastToSession,
  getSessionRec,
  hydrate,
  now,
  persistEvent,
  persistProof,
} from "../server/store";

export const Route = createFileRoute("/sessions/$id/proofs")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        hydrate();
        try {
          if (!getSessionRec(params.id)) return json(404, { error: "unknown session" });
          const body = await readJsonBody(request);
          const presentation = typeof body.presentationB64 === "string" ? body.presentationB64 : "";
          if (!presentation) return json(400, { error: "presentationB64 required" });
          const hash = createHash("sha256").update(presentation).digest("hex");
          persistProof(params.id, {
            hash,
            host: (body.host as string) ?? "",
            path: (body.path as string) ?? "",
            attested_price: typeof body.attestedPrice === "number" ? body.attestedPrice : null,
            presentation,
            verdict: "presented",
            created_at: now(),
          });
          const summary = {
            hash: hash.slice(0, 12),
            host: (body.host as string) ?? "",
            attestedPrice: (body.attestedPrice as number) ?? null,
          };
          persistEvent(params.id, "proof", summary);
          broadcastToSession(params.id, { t: now(), type: "proof", ...summary });
          return json(201, { ok: true, hash, bytes: presentation.length });
        } catch {
          return json(400, { error: "bad request" });
        }
      },
    },
  },
});
