# elysia-structured-logger

Structured, request-lifecycle logging for Elysia.

This package emits **one JSON event per request** (a "wide event") instead of spraying many ad-hoc log lines. It is inspired by the logging model promoted by [loggingsucks.com](https://loggingsucks.com/).

## Why this approach

Traditional logging usually produces many fragmented lines:
- Start request
- Hit service A
- Hit DB
- Maybe error
- Finish request

That format makes production debugging slower because correlation is manual and context is split.

`elysia-structured-logger` flips this:
- Collect context during the request lifecycle
- Emit exactly one final event in `onAfterResponse`
- Include success/error outcome, latency, status code, ids, and custom fields

Result: easier filtering, aggregation, alerting, and SLO/SLA reporting.

## Core behavior

Every event includes:
- `timestamp`
- `service`
- `request_id`
- `method`
- `path`
- `status_code`
- `duration_ms`
- `outcome`
- `error` (if request failed)

Any route can enrich the same event object by mutating `wideEvent`.

## Install

```bash
bun add elysia-structured-logger
```

## Quick Start

```ts
import { Elysia } from "elysia";
import { createStructuredLoggerPlugin } from "elysia-structured-logger";

const app = new Elysia()
  .use(createStructuredLoggerPlugin({ service: "trip-loom-api" }))
  .get("/health", () => ({ ok: true }));
```

Output example:

```json
{
  "timestamp": "2026-02-24T19:00:00.000Z",
  "service": "trip-loom-api",
  "request_id": "f8f7d9f7-513f-46f0-a67b-8a7677a47eb0",
  "method": "GET",
  "path": "/health",
  "status_code": 200,
  "duration_ms": 4,
  "outcome": "success"
}
```

## API

### `createStructuredLoggerPlugin(options?)`

Options:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `logger` | `(event) => void` | `console.log(JSON.stringify(event))` | Output transport |
| `service` | `string` | `"api"` | Service name in every event |
| `extraFields` | `Record<string, unknown>` | `{}` | Static metadata merged into all events |
| `requestIdHeader` | `string` | `"x-request-id"` | Header used as request id if present |
| `createRequestId` | `(request) => string` | `crypto.randomUUID()` | Request id generator fallback |
| `getTraceContext` | `({ request }) => { traceId?, spanId? }` | `undefined` | Optional trace correlation hook |
| `transformEvent` | `(event, context) => event` | `undefined` | Final mutation hook before output |
| `onEvent` | `(event, context) => void \| Promise<void>` | `undefined` | Async sink hook (queue, OTLP, HTTP) |
| `now` | `() => Date` | `new Date()` | Clock override for deterministic tests |
| `nowMs` | `() => number` | `performance.now()` | Timer override for deterministic tests |

## Examples

### 1. Attach domain fields from route handlers

```ts
import { Elysia } from "elysia";
import { createStructuredLoggerPlugin } from "elysia-structured-logger";

const app = new Elysia()
  .use(createStructuredLoggerPlugin({ service: "billing-api" }))
  .post("/api/payments/:paymentId/refund", async ({ params, wideEvent }) => {
    wideEvent.payment_id = params.paymentId;
    wideEvent.action = "refund";

    // business logic
    return { ok: true };
  });
```

### 2. Correlate with OpenTelemetry without coupling the plugin to OTEL

```ts
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { createStructuredLoggerPlugin } from "elysia-structured-logger";

const otelLogger = logs.getLogger("structured-requests");

app.use(
  createStructuredLoggerPlugin({
    service: "trip-loom-api",
    getTraceContext: () => {
      const span = trace.getActiveSpan();
      if (!span) return undefined;

      const ctx = span.spanContext();
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    },
    onEvent: (event) => {
      otelLogger.emit({
        severityNumber:
          event.outcome === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: event.outcome === "error" ? "ERROR" : "INFO",
        body: `${event.method} ${event.path} ${event.status_code}`,
        attributes: event as Record<string, string | number | boolean>,
      });
    },
  }),
);
```

### 3. Redact sensitive values before output

```ts
app.use(
  createStructuredLoggerPlugin({
    transformEvent: (event) => {
      const next = { ...event };
      if ("authorization" in next) {
        next.authorization = "[REDACTED]";
      }
      return next;
    },
  }),
);
```

### 4. Send to multiple sinks

```ts
app.use(
  createStructuredLoggerPlugin({
    logger: (event) => console.log(JSON.stringify(event)),
    onEvent: async (event) => {
      await fetch("https://logs.example.com/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    },
  }),
);
```

### 5. Use upstream request ids when available

```ts
app.use(
  createStructuredLoggerPlugin({
    requestIdHeader: "x-correlation-id",
  }),
);
```

## Why this is better than "traditional logging"

With request-scope structured events, you can:
- Build dashboards by `service`, `path`, `outcome`, and `duration_ms`
- Alert on error rates without brittle regex
- Correlate by `request_id` and optional `trace_id`
- Ship fewer, richer log records instead of many noisy fragments

This is not about logging less. It is about logging in a shape that matches how systems fail and how teams investigate production behavior.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```
