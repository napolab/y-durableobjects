import { createMiddleware } from "hono/factory";

import type { Env, Input } from "hono";

export const upgrade = <E extends Env, P extends string, I extends Input>() =>
  createMiddleware<E, P, I>(async (c, next) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.body("Expected websocket", {
        status: 426,
        statusText: "Upgrade Required",
      });
    }

    return next();
  });
