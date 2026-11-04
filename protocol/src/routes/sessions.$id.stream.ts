import { createFileRoute } from "@tanstack/react-router";
import { json, sse } from "../server/http";
import { getSessionRec, hasSessionState, hydrate, subscribeSession } from "../server/store";

export const Route = createFileRoute("/sessions/$id/stream")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        hydrate();
        if (!getSessionRec(params.id) && !hasSessionState(params.id)) {
          return json(404, { error: "unknown session" });
        }
        const live = new URL(request.url).searchParams.get("live") === "1";
        return sse((write) => subscribeSession(params.id, { write }, !live));
      },
    },
  },
});
