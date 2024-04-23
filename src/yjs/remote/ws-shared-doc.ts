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

import type { RemoteDoc } from ".";

type Changes = {
  added: number[];
  updated: number[];
  removed: number[];
};
type Listener<T> = (message: T) => void;
type Unsubscribe = () => void;
interface Notification<T> extends RemoteDoc {
  notify(cb: Listener<T>): Unsubscribe;
}

export class WSSharedDoc extends Doc implements Notification<Uint8Array> {
  private listeners = new Set<Listener<Uint8Array>>();
  readonly awareness = new Awareness(this);

  constructor(gc = true) {
    super({ gc });
    this.awareness.setLocalState(null);

    // カーソルなどの付加情報の更新通知
    this.awareness.on("update", (changes: Changes) => {
      this.awarenessChangeHandler(changes);
    });
    // yDoc の更新通知
    this.on("update", (update: Uint8Array) => {
      this.syncMessageHandler(update);
    });
  }

  update(message: Uint8Array) {
    const encoder = createEncoder();
    const decoder = createDecoder(message);
    const type = readVarUint(decoder);

    switch (type) {
      case messageType.sync: {
        writeVarUint(encoder, messageType.sync);
        readSyncMessage(decoder, encoder, this, null);

        // changed remote doc
        if (length(encoder) > 1) {
          this._notify(toUint8Array(encoder));
        }
        break;
      }
      case messageType.awareness: {
        applyAwarenessUpdate(this.awareness, readVarUint8Array(decoder), null);
        break;
      }
    }
  }

  notify(listener: Listener<Uint8Array>) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private syncMessageHandler(update: Uint8Array) {
    const encoder = createTypedEncoder("sync");
    writeUpdate(encoder, update);

    this._notify(toUint8Array(encoder));
  }
  private awarenessChangeHandler({ added, updated, removed }: Changes) {
    const changed = [...added, ...updated, ...removed];
    const encoder = createTypedEncoder("awareness");
    const update = encodeAwarenessUpdate(
      this.awareness,
      changed,
      this.awareness.states,
    );
    writeVarUint8Array(encoder, update);

    this._notify(toUint8Array(encoder));
  }

  private _notify(message: Uint8Array) {
    for (const subscriber of this.listeners) {
      subscriber(message);
    }
  }
}
