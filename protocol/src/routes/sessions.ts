import { createFileRoute } from "@tanstack/react-router";
import { baseFromRequest, json, readBody } from "../server/http";
import { createSessionRec, hydrate } from "../server/store";

export const Route = createFileRoute("/sessions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        hydrate();
        try {
          const body = await readBody(request);
          const product = String(body.product ?? "").trim();
          if (!product) return json(400, { error: "product required" });
          const rec = createSessionRec({
            product,
            initiatedBy: body.initiatedBy ? String(body.initiatedBy) : "web",
            budget: body.budget ? Number(body.budget) : null,
            keyphrase: body.keyphrase ? String(body.keyphrase) : null,
          });
          if ((request.headers.get("content-type") ?? "").includes("application/json")) {
            return json(201, {
              id: rec.id,
              url: `${baseFromRequest(request)}/s/${rec.id}`,
              keyphrase: rec.keyphrase,
            });
          }
          return new Response(null, { status: 303, headers: { Location: `/s/${rec.id}` } });
        } catch {
          return json(400, { error: "bad request" });
        }
      },
    },
  },
});
