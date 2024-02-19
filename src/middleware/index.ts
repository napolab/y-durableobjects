import { createMiddleware } from "hono/factory";

export const upgrade = createMiddleware(async (c, next) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.body("Expected websocket", {
      status: 426,
      statusText: "Upgrade Required",
    });
  }

  return next();
});
