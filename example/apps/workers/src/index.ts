import { Hono } from "hono";
import { cors } from "hono/cors";
import { YDurableObjects, yRoute } from "y-durableobjects";

const app = new Hono();
app.use("*", cors());

const route = app.route(
  "/editor",
  yRoute((env) => env.Y_DURABLE_OBJECTS),
);

export default route;
export { YDurableObjects };
