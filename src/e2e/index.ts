import { Hono } from "hono";
import { hc } from "hono/client";
import { fromUint8Array } from "js-base64";

import { yRoute } from "..";
import { upgrade } from "../middleware";
import { YDurableObjects } from "../yjs";

import type { CloudflareEnv } from "./types";
import type { YDurableObjectsAppType } from "../yjs";

type Env = {
  Bindings: { [K in keyof CloudflareEnv]: CloudflareEnv[K] };
};

const app = new Hono<Env>();

const route = app
  .route(
    "/shorthand",
    yRoute<Env>((env) => env.Y_DURABLE_OBJECTS),
  )
  .get("/rooms/:id", upgrade(), async (c) => {
    const roomId = c.req.param("id");
    const id = c.env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = c.env.Y_DURABLE_OBJECTS.get(id);

    const url = new URL("/", c.req.url);
    const client = hc<YDurableObjectsAppType>(url.toString(), {
      fetch: stub.fetch.bind(stub),
    });
    const res = await client.rooms[":roomId"].$get(
      { param: { roomId } },
      { init: { headers: c.req.raw.headers } },
    );

    return new Response(null, {
      webSocket: res.webSocket,
      status: res.status,
      statusText: res.statusText,
    });
  })
  .get("/rooms/:id/state", async (c) => {
    const roomId = c.req.param("id");
    const id = c.env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = c.env.Y_DURABLE_OBJECTS.get(id);

    const doc = await stub.getYDoc();
    const base64 = fromUint8Array(doc);

    return c.json({ doc: base64 }, 200);
  })
  .post("/rooms/:id/update", async (c) => {
    const roomId = c.req.param("id");
    const id = c.env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = c.env.Y_DURABLE_OBJECTS.get(id);

    const buffer = await c.req.arrayBuffer();
    const update = new Uint8Array(buffer);

    await stub.updateYDoc(update);

    return c.json(null, 200);
  });

export default app;
export type AppType = typeof route;
export { YDurableObjects };
