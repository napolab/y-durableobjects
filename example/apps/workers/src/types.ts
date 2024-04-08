import type { YDurableObjects } from "y-durableobjects";

export type Bindings = {
  Y_DURABLE_OBJECTS: DurableObjectNamespace<YDurableObjects>;
};

declare module "hono" {
  interface Env {
    Bindings: Bindings;
  }
}
