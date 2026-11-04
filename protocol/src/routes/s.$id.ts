import { createFileRoute } from "@tanstack/react-router";
import { baseFromRequest, html, json } from "../server/http";
import { sessionPage } from "../server/pages";
import { ensureSession, getSessionRec, hydrate } from "../server/store";

export const Route = createFileRoute("/s/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        hydrate();
        const rec = getSessionRec(params.id);
        if (!rec) return json(404, { error: "unknown session" });
        ensureSession(params.id);
        return html(200, sessionPage(rec, baseFromRequest(request)));
      },
    },
  },
});
