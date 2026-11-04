import { createFileRoute } from "@tanstack/react-router";
import { json } from "../server/http";

// Cheap liveness for deploy healthchecks. No DB, no rendering: the
// Railway healthcheck points here instead of /panel so a deploy is
// judged on whether the server is up, not on the control panel.
export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => json(200, { ok: true, service: "barter-protocol" }),
    },
  },
});
