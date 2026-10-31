// OpenTelemetry-shaped log emission, dependency-free.
//
// Every vendor event is logged twice:
//  1. stdout as one JSON line per record (easy local control-panel input).
//  2. If OTEL_EXPORTER_OTLP_ENDPOINT is set, POSTed as OTLP/HTTP JSON
//     (resourceLogs) to {endpoint}/v1/logs, fire-and-forget.
//
// A future control panel can consume either stream; attribute names are
// stable: event names are `vendor.*`, ids are conversationId/sessionId/sku.

type Attrs = Record<string, string | number | boolean>;

const serviceName = process.env.VENDOR_NAME ?? "barter-vendor";
const otlpEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/$/, "");

function otelValue(v: string | number | boolean) {
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: v };
}

export function log(event: string, attrs: Attrs = {}): void {
  const timeUnixNano = String(Date.now() * 1_000_000);
  const attributes = Object.entries({ "event.name": event, ...attrs }).map(([key, value]) => ({
    key,
    value: otelValue(value),
  }));
  const record = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "vendor-agent", version: "0.1.0" },
            logRecords: [
              {
                timeUnixNano,
                observedTimeUnixNano: timeUnixNano,
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: event },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...attrs }));
  if (otlpEndpoint) {
    fetch(`${otlpEndpoint}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }).catch(() => {
      // Telemetry must never break the request path.
    });
  }
}
