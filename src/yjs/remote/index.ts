import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";
export { WSSharedDoc } from "./ws-shared-doc";

export type AwarenessChanges = {
  added: number[];
  updated: number[];
  removed: number[];
};

export interface RemoteDoc extends Doc {
  readonly awareness: Awareness;
}
