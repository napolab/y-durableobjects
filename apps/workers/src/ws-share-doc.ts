import { createEncoder, length, toUint8Array, writeVarUint, writeVarUint8Array } from "lib0/encoding";
import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { Doc } from "yjs";

const messageSync = 0;
const messageAwareness = 1;

type Changes = {
  added: Array<number>;
  updated: Array<number>;
  removed: Array<number>;
};
type Subscriber = (message: Uint8Array) => void;
type Unsubscribe = () => void;
interface Observable {
  subscribe(subscriber: Subscriber): Unsubscribe;
}

export class WSSharedDoc extends Doc implements Observable {
  private subscribers: Set<Subscriber> = new Set();
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

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  onMessage(ws: WebSocket, message: Uint8Array) {
    const encoder = createEncoder();
    const decoder = createDecoder(new Uint8Array(message));
    const messageType = readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        writeVarUint(encoder, messageSync);
        readSyncMessage(decoder, encoder, this, ws);

        if (length(encoder) > 1) {
          this.notify(toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
        applyAwarenessUpdate(this.awareness, readVarUint8Array(decoder), ws);
        break;
      }
    }
  }

  private setup() {
    const encoder = createEncoder();
    writeVarUint(encoder, messageSync);
    this.notify(toUint8Array(encoder));

    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      writeVarUint(encoder, messageAwareness);
      const message = encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()), this.awareness.states);
      writeVarUint8Array(encoder, message);
      this.notify(toUint8Array(encoder));
    }
  }

  private syncMessageHandler(update: Uint8Array) {
    const encoder = createEncoder();
    writeVarUint(encoder, messageSync);
    writeUpdate(encoder, update);
    const message = toUint8Array(encoder);

    this.notify(message);
  }
  private awarenessChangeHandler({ added, updated, removed }: Changes) {
    const changedClients = [...added, ...updated, ...removed];
    const encoder = createEncoder();
    writeVarUint(encoder, messageAwareness);
    writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changedClients, this.awareness.states));
    const buff = toUint8Array(encoder);

    this.notify(buff);
  }

  private notify(message: Uint8Array) {
    for (const subscriber of this.subscribers) {
      subscriber(message);
    }
  }
}
