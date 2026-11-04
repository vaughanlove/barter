import { createFileRoute } from "@tanstack/react-router";
import { json, readJsonBody } from "../server/http";
import { emit, ensureSession, getSessionRec, hasSessionState, hydrate } from "../server/store";

export const Route = createFileRoute("/sessions/$id/events")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        hydrate();
        try {
          if (!getSessionRec(params.id) && !hasSessionState(params.id)) {
            return json(404, { error: "unknown session" });
          }
          ensureSession(params.id);
          const body = await readJsonBody(request);
          emit(params.id, (body.type as string) ?? "event", body);
          return json(201, { ok: true });
        } catch {
          return json(400, { error: "bad request" });
        }
      },
    },
  },
});
