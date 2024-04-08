import { Hono } from "hono";

import { upgrade } from "./middleware";

import type { YDurableObjects } from "./yjs";
import type { Env } from "hono";

export { YDurableObjects } from "./yjs";

const app = new Hono();

type Selector<E extends Env> = (
  c: E["Bindings"],
) => DurableObjectNamespace<YDurableObjects>;

export const yRoute = <E extends Env>(selector: Selector<E>) => {
  const route = app.get("/:id", upgrade(), async (c) => {
    const obj = selector(c.env as Env["Bindings"]);
    const id = obj.idFromName(c.req.param("id"));

    const stab = obj.get(id);
    using res = await stab.socket();

    if (res.webSocket === null) return c.body(null, 500);

    return new Response(null, { webSocket: res.webSocket, status: 101 });
  });

  return route;
};
export type YRoute = typeof yRoute;
