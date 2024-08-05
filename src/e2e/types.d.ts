/* eslint-disable import/no-unresolved */
import "cloudflare:test";
import { YDurableObjects } from "../yjs";

interface CloudflareEnv {
  Y_DURABLE_OBJECTS: DurableObjectNamespace<YDurableObjects>;
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends CloudflareEnv {}
}
