import { createFileRoute } from "@tanstack/react-router";
import { json } from "../server/http";
import { hydrate, listEvents, listSessionRecs, logsBySession } from "../server/store";

export const Route = createFileRoute("/api/sessions")({
  server: {
    handlers: {
      GET: async () => {
        hydrate();
        const persisted = listSessionRecs().map((rec) => ({
          id: rec.id,
          product: rec.product,
          status: rec.status,
          keyphrase: rec.keyphrase ?? null,
          initiatedBy: rec.initiated_by,
          createdAt: rec.created_at,
          logs: listEvents(rec.id).map(({ ts, type, ...rest }) => ({
            t: ts,
            sessionId: rec.id,
            event: type,
            ...rest,
          })),
        }));
        const known = new Set(persisted.map((s) => s.id));
        const extra = [...logsBySession.entries()]
          .filter(([id]) => !known.has(id))
          .map(([id, logs]) => ({ id, logs }));
        return json(200, { sessions: [...persisted, ...extra] });
      },
    },
  },
});
