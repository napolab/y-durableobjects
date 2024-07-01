import { Hono } from "hono";

import { upgrade } from "./middleware";

import type { Env } from "hono";

export { YDurableObjects } from "./yjs";

const app = new Hono();

type Selector<E extends Env> = (c: E["Bindings"]) => DurableObjectNamespace;

export const yRoute = <E extends Env>(selector: Selector<E>) => {
  const route = app.get("/:id", upgrade(), async (c) => {
    const obj = selector(c.env as E["Bindings"]);
    const stab = obj.get(obj.idFromName(c.req.param("id")));

    // get websocket connection
    const url = new URL("/", c.req.url);
    const res = await stab.fetch(url.href, {
      headers: c.req.raw.headers,
    });
    if (res.webSocket === null) return c.body(null, 500);

    return new Response(null, {
      webSocket: res.webSocket,
      status: res.status,
      statusText: res.statusText,
    });
  });

  return route;
};
export type YRoute = ReturnType<typeof yRoute>;
export type { YTransactionStorage } from "./yjs/storage";
export { type RemoteDoc, WSSharedDoc } from "./yjs/remote";
