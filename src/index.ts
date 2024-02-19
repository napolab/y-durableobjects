import { Hono } from "hono";

import type { Env } from "hono";

export { YDurableObjects } from "./yjs";

const app = new Hono();

type Selector<E extends Env> = (c: E["Bindings"]) => DurableObjectNamespace;

export const yRoute = <E extends Env>(selector: Selector<E>) => {
  const route = app.get("/:id", async (c) => {
    const id = selector(c.env).idFromName(c.req.param("id"));
    const obj = selector(c.env).get(id);

    // get websocket connection
    const url = new URL("/", c.req.url);
    const res = await obj.fetch(url.href, {
      headers: c.req.raw.headers,
    });
    if (res.webSocket === null) return c.body(null, 500);

    return new Response(null, { webSocket: res.webSocket, status: res.status });
  });

  return route;
};
export type YRoute = typeof yRoute;
