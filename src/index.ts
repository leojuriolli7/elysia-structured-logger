import { Elysia } from "elysia";

export interface StructuredLoggerError {
  type: string;
  message: string;
  status: number;
}

export interface StructuredLogEvent {
  timestamp: string;
  service: string;
  request_id: string;
  method: string;
  path: string;
  status_code?: number;
  duration_ms?: number;
  outcome?: "success" | "error";
  error?: StructuredLoggerError;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

export interface TraceContext {
  traceId?: string;
  spanId?: string;
}

type ElysiaSet = {
  status?: number | string;
};

export interface EventHookContext {
  request: Request;
  set: ElysiaSet;
}

export interface StructuredLoggerPluginOptions {
  /**
   * Output transport.
   * Defaults to `console.log(JSON.stringify(event))`.
   */
  logger?: (event: StructuredLogEvent) => void;

  /**
   * Service name written to every event.
   * @default "api"
   */
  service?: string;

  /**
   * Static metadata merged into every event.
   */
  extraFields?: Record<string, unknown>;

  /**
   * Header to reuse as request id when provided by an upstream proxy/gateway.
   * @default "x-request-id"
   */
  requestIdHeader?: string;

  /**
   * Factory used when the configured request id header is not present.
   * @default () => crypto.randomUUID()
   */
  createRequestId?: (request: Request) => string;

  /**
   * Trace correlation hook.
   * Return trace/span identifiers from your tracing system, if available.
   * Values are copied into `trace_id` and `span_id` on the emitted event.
   */
  getTraceContext?: (
    context: { request: Request },
  ) => TraceContext | null | undefined;

  /**
   * Final synchronous event transform before `logger` and `onEvent`.
   */
  transformEvent?: (
    event: StructuredLogEvent,
    context: EventHookContext,
  ) => StructuredLogEvent;

  /**
   * Optional async sink invoked after `logger`.
   * Useful for forwarding events to collectors, queues, or telemetry backends.
   */
  onEvent?: (
    event: StructuredLogEvent,
    context: EventHookContext,
  ) => void | Promise<void>;

  /**
   * Date provider used for `timestamp`.
   * @default () => new Date()
   */
  now?: () => Date;

  /**
   * High-resolution timer used for duration calculation.
   * @default () => performance.now()
   */
  nowMs?: () => number;
}

const DEFAULT_SERVICE = "api";
const DEFAULT_REQUEST_ID_HEADER = "x-request-id";

const defaultLogger = (event: StructuredLogEvent) => {
  console.log(JSON.stringify(event));
};

const defaultRequestIdFactory = () => crypto.randomUUID();

const defaultNow = () => new Date();

const defaultNowMs = () => performance.now();

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
};

const asStatusCode = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
};

/**
 * Emits one structured request event in `onAfterResponse`.
 *
 * Lifecycle:
 * 1. `derive`: initialize the event and request metadata.
 * 2. `onError`: attach normalized error info when failures happen.
 * 3. `onAfterResponse`: finalize status/duration/outcome and emit.
 */
export const createStructuredLoggerPlugin = (
  options?: StructuredLoggerPluginOptions,
) => {
  const logger = options?.logger ?? defaultLogger;
  const service = options?.service ?? DEFAULT_SERVICE;
  const extraFields = options?.extraFields ?? {};
  const requestIdHeader = options?.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER;
  const createRequestId = options?.createRequestId ?? defaultRequestIdFactory;
  const now = options?.now ?? defaultNow;
  const nowMs = options?.nowMs ?? defaultNowMs;

  return new Elysia({ name: "elysia-structured-logger" })
    .derive({ as: "global" }, ({ request }) => {
      const startTime = nowMs();
      const url = new URL(request.url);

      const requestId =
        request.headers.get(requestIdHeader) ?? createRequestId(request);

      const wideEvent: StructuredLogEvent = {
        timestamp: now().toISOString(),
        service,
        request_id: requestId,
        method: request.method,
        path: url.pathname,
        ...extraFields,
      };

      const traceContext = options?.getTraceContext?.({ request });
      if (traceContext?.traceId) {
        wideEvent.trace_id = traceContext.traceId;
      }
      if (traceContext?.spanId) {
        wideEvent.span_id = traceContext.spanId;
      }

      return {
        wideEvent,
        requestId,
        _startTime: startTime,
      };
    })
    .onError({ as: "global" }, (ctx) => {
      if (!ctx.wideEvent) {
        return;
      }

      const code = String(ctx.code);
      const errorObject = asObject(ctx.error);
      const message =
        typeof errorObject?.message === "string" ? errorObject.message : code;
      const status = asStatusCode(errorObject?.status, 500);

      ctx.wideEvent.error = {
        type: code,
        message,
        status,
      };
    })
    .onAfterResponse({ as: "global" }, async (ctx) => {
      if (!ctx.wideEvent) {
        return;
      }

      ctx.wideEvent.status_code = asStatusCode(ctx.set.status, 200);
      ctx.wideEvent.duration_ms = Math.round(
        nowMs() - asStatusCode(ctx._startTime, nowMs()),
      );
      ctx.wideEvent.outcome = ctx.wideEvent.error ? "error" : "success";

      const hookContext: EventHookContext = {
        request: ctx.request,
        set: ctx.set as ElysiaSet,
      };

      const finalEvent = options?.transformEvent
        ? options.transformEvent(ctx.wideEvent, hookContext)
        : ctx.wideEvent;

      logger(finalEvent);
      await options?.onEvent?.(finalEvent, hookContext);
    });
};
