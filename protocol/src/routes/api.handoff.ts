import { createFileRoute } from "@tanstack/react-router";
import { json } from "../server/http";
import { getSessionByKeyphrase, hydrate, listSessionRecs } from "../server/store";

export const Route = createFileRoute("/api/handoff")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        hydrate();
        // Primary: the agent passed the keyphrase through. Fallback: the
        // agent reliably creates a session but not reliably the phrase —
        // follow the newest session started after this page loaded.
        const url = new URL(request.url);
        const phrase = url.searchParams.get("phrase") ?? "";
        const byPhrase = phrase ? getSessionByKeyphrase(phrase) : null;
        if (byPhrase) {
          return json(200, { id: byPhrase.id, url: `/s/${byPhrase.id}`, via: "keyphrase" });
        }
        const since = Number(url.searchParams.get("since") ?? 0);
        if (Number.isFinite(since) && since > 0) {
          const latest = [...listSessionRecs()]
            .reverse()
            .find((s) => Date.parse(s.created_at) >= since);
          if (latest) return json(200, { id: latest.id, url: `/s/${latest.id}`, via: "latest" });
        }
        return json(404, { error: "no session yet" });
      },
    },
  },
});
