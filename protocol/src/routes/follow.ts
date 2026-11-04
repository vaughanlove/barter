import { createFileRoute } from "@tanstack/react-router";
import { getSessionByKeyphrase, getSessionRec, hydrate } from "../server/store";

export const Route = createFileRoute("/follow")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        hydrate();
        const url = new URL(request.url);
        const phrase = url.searchParams.get("phrase") ?? "";
        const byPhrase = phrase ? getSessionByKeyphrase(phrase) : null;
        const id = (url.searchParams.get("id") ?? "").trim().toUpperCase();
        const target = byPhrase?.id ?? (id && getSessionRec(id) ? id : null);
        return new Response(null, {
          status: 303,
          headers: { Location: target ? `/s/${target}` : "/?missing=1" },
        });
      },
    },
  },
});
