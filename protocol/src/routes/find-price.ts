import { createFileRoute } from "@tanstack/react-router";
import { findPrice } from "../server/findPrice";
import { json, readBody } from "../server/http";

export const Route = createFileRoute("/find-price")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readBody(request);
          const { status, out } = await findPrice(body);
          return json(status, out);
        } catch {
          return json(400, { error: "bad request" });
        }
      },
    },
  },
});
