# y-durableobjects

[![Yjs on Cloudflare Workers with Durable Objects Demo Movie](https://i.gyazo.com/e94637740dbb11fc5107b0cd0850326d.gif)](https://gyazo.com/e94637740dbb11fc5107b0cd0850326d)

The `y-durableobjects` library is designed to facilitate real-time collaboration in Cloudflare Workers environment using Yjs and Durable Objects. It provides a straightforward way to integrate Yjs for decentralized, scalable real-time editing features.

## Installation

To use `y-durableobjects`, you need to install the package along with `hono`, as it is a peer dependency.

```bash
npm install y-durableobjects hono
```

or using yarn:

```bash
yarn add y-durableobjects hono
```

or pnpm:

```bash
pnpm add y-durableobjects hono
```

Below is an updated section for your README, including the recommended `wrangler.toml` configuration for Durable Objects, followed by the new section providing guidance on configuring Durable Objects:

---

## Configuring Durable Objects

To use Durable Objects with `y-durableobjects`, include the following configuration in your `wrangler.toml` file. This setup is essential for defining the Durable Object bindings that your Cloudflare Worker will use.

```toml
name = "your-worker-name"
main = "index.js"
compatibility_date = "2021-10-01"

account_id = "your-account-id"
workers_dev = true
route = ""
zone_id = ""

# Durable Objects binding
[durable_objects]
bindings = [
  { name = "Y_DURABLE_OBJECTS", class_name = "YDurableObjects" }
]

# Add your KV Namespaces and other bindings here
# [kv_namespaces]
# ...

# Your environment variables
# [vars]
# ...
```

### Configuration for Durable Objects

To properly utilize Durable Objects, you need to configure bindings in your `wrangler.toml` file. This involves specifying the name of the Durable Object binding and the class name that represents your Durable Object. For detailed instructions on how to set up your `wrangler.toml` for Durable Objects, including setting up environment variables and additional resources, refer to [Cloudflare's Durable Objects documentation](https://developers.cloudflare.com/durable-objects/get-started/#5-configure-durable-object-bindings).

This configuration ensures that your Cloudflare Worker can correctly instantiate and interact with Durable Objects, allowing `y-durableobjects` to manage real-time collaboration sessions.

## Extending Hono with Bindings

To integrate `y-durableobjects` with Hono, extend the `Env` interface to include the `Bindings` type for better type safety and IntelliSense support in your editor.

```typescript
export type Bindings = {
  Y_DURABLE_OBJECTS: DurableObjectNamespace;
};

declare module "hono" {
  interface Env {
    Bindings: Bindings;
  }
}
```

This allows you to use `Y_DURABLE_OBJECTS` directly in your Hono application with full type support.

## Usage

### With Hono shorthand

```typescript
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
```

### Without the shorthand

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { YDurableObjects } from "y-durableobjects";

const app = new Hono<Env>();
app.use("*", cors());
app.get("/editor/:id", async (c) => {
  const id = c.env.Y_DURABLE_OBJECTS.idFromName(c.req.param("id"));
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
export { YDurableObjects };
```
