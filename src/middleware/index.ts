import { createMiddleware } from "hono/factory";

import type { Env } from "hono";
import type { UpgradedWebSocketResponseInputJSONType } from "hono/ws";

type Input = {
  in: {
    json: UpgradedWebSocketResponseInputJSONType;
  };
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
