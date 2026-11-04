import { createFileRoute } from "@tanstack/react-router";
import { json } from "../server/http";
import { getSessionByKeyphrase, hydrate } from "../server/store";

export const Route = createFileRoute("/api/keyphrase/$phrase")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        hydrate();
        const rec = getSessionByKeyphrase(decodeURIComponent(params.phrase));
        if (!rec) return json(404, { error: "no session for that keyphrase yet" });
        return json(200, { id: rec.id, url: `/s/${rec.id}`, status: rec.status, product: rec.product });
      },
    },
  },
});
