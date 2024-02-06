import { Hono } from "hono";
import { HonoEnv } from "./types";
import { cors } from "hono/cors";

const app = new Hono<HonoEnv>();
app.use("*", cors())

app.get("/", async (c) => {
  console.log(c.req.url)
  // id には room ごとの id を入れるようにする
  const id = c.env.YJS_PROVIDER.idFromName("id");
  const obj = c.env.YJS_PROVIDER.get(id);
  // get websocket connection
  const url = new URL("/", c.req.url)
  const res = await obj.fetch(url.href, {
    headers: c.req.raw.headers,
  });
  if (res.webSocket === null) return c.body(null, 500)

  return new Response(null, { webSocket: res.webSocket, status: res.status })
});

export default app;
export * from "./durable-object";
