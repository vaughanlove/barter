import { createFileRoute } from "@tanstack/react-router";
import { json, readJsonBody } from "../server/http";
import { hydrate, ingestOtlp } from "../server/store";

export const Route = createFileRoute("/v1/logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        hydrate();
        try {
          const body = await readJsonBody(request);
          return json(200, { ok: true, ingested: ingestOtlp(body) });
        } catch {
          return json(400, { error: "bad request" });
        }
      },
    },
  },
});
