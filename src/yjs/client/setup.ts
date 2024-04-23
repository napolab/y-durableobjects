import { toUint8Array, writeVarUint8Array } from "lib0/encoding";
import { encodeAwarenessUpdate } from "y-protocols/awareness";
import { writeSyncStep1 } from "y-protocols/sync";

import { createTypedEncoder } from "../message-type";

import type { RemoteDoc } from "../remote";

export const setupWSConnection = (ws: WebSocket, doc: RemoteDoc) => {
  {
    const encoder = createTypedEncoder("sync");
    writeSyncStep1(encoder, doc);
    ws.send(toUint8Array(encoder));
  }

  {
    const states = doc.awareness.getStates();
    if (states.size > 0) {
      const encoder = createTypedEncoder("awareness");
      const update = encodeAwarenessUpdate(
        doc.awareness,
        Array.from(states.keys()),
      );
      writeVarUint8Array(encoder, update);

      ws.send(toUint8Array(encoder));
    }
  }
};
