import { Hono } from "hono";
import { cors } from "hono/cors";
import { YDurableObjects, yRoute } from "y-durableobjects";
import { Env } from "./types";

const app = new Hono<Env>();
app.use("*", cors());

const route = app.route(
  "/editor",
  yRoute<Env>((env) => env.Y_DURABLE_OBJECTS),
);

export default route;
export type AppType = typeof route;
export { YDurableObjects };
