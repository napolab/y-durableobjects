import { Hono } from "hono";
import { HonoEnv } from "./types";
import { Awareness } from "y-protocols/awareness";

const app = new Hono<HonoEnv>();

app.get("/", async (c) => {
  // id には room ごとの id を入れるようにする
  const id = c.env.YJS_PROVIDER.idFromName("id");
  const obj = c.env.YJS_PROVIDER.get(id);
  // get websocket connection
  const res = await obj.fetch(new URL("/", c.req.url).href);
  if (!res.ok) return res;

  const ws = res.webSocket;
  if (ws === null) return c.body(null, 500);

  return res;
});

export default app;
export * from "./durable-object";
