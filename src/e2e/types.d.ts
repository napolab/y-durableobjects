/* eslint-disable import/no-unresolved */
import "cloudflare:test";
import { InternalYDurableObject } from "../yjs/internal";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    Y_DURABLE_OBJECTS: DurableObjectNamespace<InternalYDurableObject>;
  }
}
