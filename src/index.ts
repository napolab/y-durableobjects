import { Hono } from "hono";
import { hc } from "hono/client";

import { upgrade } from "./middleware";

import type { YDurableObjectsAppType } from "./yjs";
import type { Env } from "hono";

const app = new Hono();

type Selector<E extends Env> = (c: E["Bindings"]) => DurableObjectNamespace;

export const yRoute = <E extends Env>(selector: Selector<E>) => {
  const route = app.get("/:id", upgrade(), async (c) => {
    const obj = selector(c.env as E["Bindings"]);
    const stub = obj.get(obj.idFromName(c.req.param("id")));

    // get websocket connection
    const url = new URL("/", c.req.url);
    const client = hc<YDurableObjectsAppType>(url.toString(), {
      fetch: stub.fetch.bind(stub),
    });
    const res = await client.rooms[":roomId"].$get(
      {
        param: { roomId: c.req.param("id") },
      },
      {
        init: { headers: c.req.raw.headers },
      },
    );

    return new Response(null, {
      webSocket: res.webSocket,
      status: res.status,
      statusText: res.statusText,
    });
  });

  return route;
};

export { YDurableObjects, type YDurableObjectsAppType } from "./yjs";
export type YRoute = ReturnType<typeof yRoute>;
export type { YTransactionStorage } from "./yjs/storage";
export { type RemoteDoc, WSSharedDoc } from "./yjs/remote";
