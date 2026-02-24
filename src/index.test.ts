/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createStructuredLoggerPlugin, type StructuredLogEvent } from "./index";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createStructuredLoggerPlugin", () => {
  it("emits one structured event for successful requests", async () => {
    const events: StructuredLogEvent[] = [];

    const app = new Elysia()
      .use(
        createStructuredLoggerPlugin({
          service: "orders-api",
          logger: (event) => {
            events.push(event);
          },
        }),
      )
      .get("/health", ({ wideEvent }) => {
        wideEvent.route_group = "system";
        return { ok: true };
      });

    const res = await app.handle(new Request("http://localhost/health"));
    await flush();

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].service).toBe("orders-api");
    expect(events[0].method).toBe("GET");
    expect(events[0].path).toBe("/health");
    expect(events[0].outcome).toBe("success");
    expect(events[0].route_group).toBe("system");
  });

  it("captures request errors in the event payload", async () => {
    const events: StructuredLogEvent[] = [];

    class BoomError extends Error {
      status = 418;
    }

    const app = new Elysia()
      .error({ BoomError })
      .use(
        createStructuredLoggerPlugin({
          logger: (event) => {
            events.push(event);
          },
        }),
      )
      .get("/boom", () => {
        throw new BoomError("teapot");
      });

    await app.handle(new Request("http://localhost/boom"));
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("error");
    expect(events[0].error).toBeTruthy();
    expect(events[0].error).toEqual({
      type: "BoomError",
      message: "teapot",
      status: 418,
    });
  });
});
