import { createMiddleware } from "hono/factory";

import type { Env } from "hono";

type Input = {
  outputFormat: "ws";
};

export const upgrade = <E extends Env, P extends string>() =>
  createMiddleware<E, P, Input>(async (c, next) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.body("Expected websocket", {
        status: 426,
        statusText: "Upgrade Required",
      });
    }

    return next();
  });
