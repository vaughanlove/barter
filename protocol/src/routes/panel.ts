import { createFileRoute } from "@tanstack/react-router";
import { html } from "../server/http";
import { panelPage } from "../server/pages";

export const Route = createFileRoute("/panel")({
  server: {
    handlers: {
      GET: async () => html(200, panelPage),
    },
  },
});
