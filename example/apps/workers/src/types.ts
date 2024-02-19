export type Bindings = {
  Y_DURABLE_OBJECTS: DurableObjectNamespace;
};

declare module "hono" {
  interface Env {
    Bindings: Bindings;
  }
}
