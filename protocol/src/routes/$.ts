import { createFileRoute } from "@tanstack/react-router";
import { baseFromRequest, json, text } from "../server/http";
import { llmsTxt } from "../server/llms";
import { hydrate } from "../server/store";

// Static-ish text surfaces and the JSON 404 fallback, matching the
// prototype's route table.
export const Route = createFileRoute("/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        hydrate();
        const url = new URL(request.url);
        if (url.pathname === "/llms.txt") return text(200, llmsTxt(baseFromRequest(request)));
        if (url.pathname === "/robots.txt") {
          return text(
            200,
            `User-agent: *\nAllow: /\n\n# Agents: the protocol for this site is at ${baseFromRequest(request)}/llms.txt\n`,
          );
        }
        if (url.pathname === "/.well-known/poppy.json") {
          const domain = (request.headers.get("host") ?? "").split(":")[0].toLowerCase().replace(/^www\./, "");
          return json(200, {
            protocol_version: "0.1",
            organization: { name: "Barter", domain },
            web: {},
          });
        }
        return json(404, { error: "not found" });
      },
    },
  },
});
