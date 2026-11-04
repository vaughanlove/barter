import { createFileRoute } from "@tanstack/react-router";
import { baseFromRequest, html } from "../server/http";
import { landingPage } from "../server/pages";
import { hydrate } from "../server/store";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        hydrate();
        const missing = new URL(request.url).searchParams.get("missing") === "1";
        return html(200, landingPage(baseFromRequest(request), missing));
      },
    },
  },
});
