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

const messageSync = 0;
const messageAwareness = 1;

type Changes = {
  added: number[];
  updated: number[];
  removed: number[];
};
type Listener<T> = (message: T) => void;
type Unsubscribe = () => void;
interface Notification<T> {
  notify(cb: Listener<T>): Unsubscribe;
}

export class WSSharedDoc extends Doc implements Notification<Uint8Array> {
  private listeners = new Set<Listener<Uint8Array>>();
  readonly awareness = new Awareness(this);

  constructor(gc = true) {
    super({ gc });
    this.awareness.setLocalState(null);
    this.setup();

    this.awareness.on("update", (changes: Changes) => {
      this.awarenessChangeHandler(changes);
    });
    this.on("update", (update: Uint8Array) => {
      this.syncMessageHandler(update);
    });
  }

  update(message: Uint8Array) {
    const encoder = createEncoder();
    const decoder = createDecoder(new Uint8Array(message));
    const messageType = readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        writeVarUint(encoder, messageSync);
        readSyncMessage(decoder, encoder, this, null);

        if (length(encoder) > 1) {
          this._notify(toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
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

  private setup() {
    const encoder = createEncoder();
    writeVarUint(encoder, messageSync);
    this._notify(toUint8Array(encoder));

    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      writeVarUint(encoder, messageAwareness);
      const message = encodeAwarenessUpdate(
        this.awareness,
        Array.from(awarenessStates.keys()),
        this.awareness.states,
      );
      writeVarUint8Array(encoder, message);

      this._notify(toUint8Array(encoder));
    }
  }

  private syncMessageHandler(update: Uint8Array) {
    const encoder = createEncoder();
    writeVarUint(encoder, messageSync);
    writeUpdate(encoder, update);

    this._notify(toUint8Array(encoder));
  }
  private awarenessChangeHandler({ added, updated, removed }: Changes) {
    const changedClients = [...added, ...updated, ...removed];
    const encoder = createEncoder();
    writeVarUint(encoder, messageAwareness);
    writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(
        this.awareness,
        changedClients,
        this.awareness.states,
      ),
    );

    this._notify(toUint8Array(encoder));
  }

  private _notify(message: Uint8Array) {
    for (const subscriber of this.listeners) {
      subscriber(message);
    }
  }
}
