import { createFileRoute } from "@tanstack/react-router";
import { baseFromRequest, html } from "../server/http";
import { howItWorksPage } from "../server/pages";

export const Route = createFileRoute("/how-it-works")({
  server: {
    handlers: {
      GET: async ({ request }) => html(200, howItWorksPage(baseFromRequest(request))),
    },
  },
});
