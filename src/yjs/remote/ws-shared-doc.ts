import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  length,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import { Doc } from "yjs";

import { createTypedEncoder, messageType } from "../message-type";

import type { AwarenessChanges, RemoteDoc } from ".";

type Listener = (message: Uint8Array) => void;
type Unsubscribe = () => void;

interface Notification extends RemoteDoc {
  notify(origin: object, listener: Listener): Unsubscribe;
}

export class WSSharedDoc extends Doc implements Notification {
  /** origin（通常は WebSocket）をキーにした配信先 */
  private listeners = new Map<object, Listener>();
  readonly awareness = new Awareness(this);

  constructor(gc = true) {
    super({ gc });
    this.awareness.setLocalState(null);

    // カーソルなどの付加情報の更新通知
    this.awareness.on(
      "update",
      (changes: AwarenessChanges, origin: unknown) => {
        this.awarenessChangeHandler(changes, origin);
      },
    );
    // yDoc の更新通知
    this.on("update", (update: Uint8Array, origin: unknown) => {
      this.syncMessageHandler(update, origin);
    });
  }

  update(message: Uint8Array, origin: object) {
    const encoder = createEncoder();
    const decoder = createDecoder(message);
    const type = readVarUint(decoder);

    switch (type) {
      case messageType.sync: {
        writeVarUint(encoder, messageType.sync);
        readSyncMessage(decoder, encoder, this, origin);

        // sync step 1 への応答は要求元にだけ返す
        if (length(encoder) > 1) {
          this.send(origin, toUint8Array(encoder));
        }
        break;
      }
      case messageType.awareness: {
        applyAwarenessUpdate(
          this.awareness,
          readVarUint8Array(decoder),
          origin,
        );
        break;
      }
      case messageType.queryAwareness: {
        const states = this.awareness.getStates();
        if (states.size > 0) {
          const reply = createTypedEncoder("awareness");
          writeVarUint8Array(
            reply,
            encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
          );
          this.send(origin, toUint8Array(reply));
        }
        break;
      }
      case messageType.auth: {
        // auth はサーバからクライアントへの一方向のメッセージなので受信しても何もしない
        break;
      }
      default: {
        throw new Error(`Unsupported message type: ${type}`);
      }
    }
  }

  notify(origin: object, listener: Listener) {
    this.listeners.set(origin, listener);

    return () => {
      this.listeners.delete(origin);
    };
  }

  private syncMessageHandler(update: Uint8Array, origin: unknown) {
    const encoder = createTypedEncoder("sync");
    writeUpdate(encoder, update);

    this.broadcast(toUint8Array(encoder), origin);
  }

  private awarenessChangeHandler(
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) {
    const changed = [...added, ...updated, ...removed];
    const encoder = createTypedEncoder("awareness");
    const update = encodeAwarenessUpdate(
      this.awareness,
      changed,
      this.awareness.states,
    );
    writeVarUint8Array(encoder, update);

    this.broadcast(toUint8Array(encoder), origin);
  }

  private send(origin: object, message: Uint8Array) {
    this.listeners.get(origin)?.(message);
  }

  private broadcast(message: Uint8Array, exclude: unknown) {
    for (const [origin, listener] of this.listeners) {
      if (origin === exclude) continue;
      listener(message);
    }
  }
}
