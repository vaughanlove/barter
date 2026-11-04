import type { Loose } from "./store";

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const text = (status: number, body: string, type = "text/plain"): Response =>
  new Response(body, { status, headers: { "Content-Type": type } });

export const html = (status: number, body: string): Response => text(status, body, "text/html");

export const baseFromRequest = (request: Request): string => {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return `${proto}://${host}`;
};

export const readBody = async (request: Request): Promise<Loose> => {
  const bodyText = await request.text();
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    return JSON.parse(bodyText || "{}") as Loose;
  }
  return Object.fromEntries(new URLSearchParams(bodyText)) as Loose;
};

export const readJsonBody = async (request: Request): Promise<Loose> => {
  const bodyText = await request.text();
  return JSON.parse(bodyText || "{}") as Loose;
};

// Server-sent events response. `subscribe` receives a writer and returns
// an unsubscribe function; an initial payload string may be sent first.
export function sse(subscribe: (write: (s: string) => void) => () => void): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* client already gone */
        }
      };
      unsubscribe = subscribe(write);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
