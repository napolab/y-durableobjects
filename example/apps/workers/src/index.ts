import { Hono } from "hono";
import { HonoEnv } from "./types";
import { cors } from "hono/cors";

const app = new Hono<HonoEnv>();
app.use("*", cors());

app.get("/editor/:eid", async (c) => {
  const id = c.env.Y_DURABLE_OBJECTS.idFromName(c.req.param("eid"));
  const obj = c.env.Y_DURABLE_OBJECTS.get(id);

  // get websocket connection
  const url = new URL("/", c.req.url);
  const res = await obj.fetch(url.href, {
    headers: c.req.raw.headers,
  });
  if (res.webSocket === null) return c.body(null, 500);

  return new Response(null, { webSocket: res.webSocket, status: res.status });
});

export default app;
export * from "y-durableobjects"



