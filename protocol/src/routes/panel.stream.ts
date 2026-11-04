import { createFileRoute } from "@tanstack/react-router";
import { sse } from "../server/http";
import { hydrate, subscribePanel } from "../server/store";

export const Route = createFileRoute("/panel/stream")({
  server: {
    handlers: {
      GET: async () => {
        hydrate();
        return sse((write) => subscribePanel(write));
      },
    },
  },
});
