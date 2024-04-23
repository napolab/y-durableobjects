export type Key =
  | {
      type: "update";
      name?: number;
    }
  | {
      type: "state";
      name: "bytes" | "doc" | "count";
    };

export const storageKey = (key: Key) => {
  return `ydoc:${key.type}:${key.name ?? ""}`;
};
