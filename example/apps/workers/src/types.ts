import type { YDurableObjects } from "y-durableobjects";

type Bindings = {
  Y_DURABLE_OBJECTS: DurableObjectNamespace<YDurableObjects<Env>>;
};

export type Env = {
  Bindings: Bindings;
};
