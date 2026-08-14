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

/**
 * Narrows `_checkInterval` to the numeric interval-id shape that
 * `setInterval` / `clearInterval` use in the Workers runtime (see
 * `worker-configuration.d.ts`). y-protocols' own `.d.ts` types the field as
 * `any`; funneling it through `unknown` here means we never trust that
 * `any` directly -- we check its actual runtime shape before touching it.
 */
function isIntervalHandle(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * y-protocols' `Awareness` constructor installs a repeating `setInterval`
 * that fires every `floor(outdatedTimeout / 10)` ms (3s with the library
 * default) -- see the installed y-protocols package's `awareness.js`
 * (`node_modules/y-protocols/awareness.js`).
 * Any pending `setInterval`/`setTimeout` prevents a Durable Object from
 * hibernating, so leaving this running keeps every `YDurableObjects`
 * instance awake -- and billed for duration -- for its entire lifetime.
 *
 * The timer does two things: (1) renew the local client's own clock, gated
 * on `getLocalState() !== null`. `WSSharedDoc`'s constructor immediately
 * calls `awareness.setLocalState(null)`, so that branch never fires here.
 * (2) evict remote clients whose state hasn't been refreshed within
 * `outdatedTimeout` (30s). Only (2) does anything on the server, and we
 * accept losing it: each connection's awareness ids are torn down on
 * disconnect (`unregisterWebSocket`), the Durable Objects runtime delivers
 * `webSocketClose`/`webSocketError` for abnormal disconnects too, and
 * awareness only ever lives in memory, so it's rebuilt from nothing on
 * every restart regardless. The GC's remaining value is small; the
 * hibernation cost of keeping the timer alive is not.
 *
 * `_checkInterval` is underscore-prefixed and not part of y-protocols'
 * public API -- a future release could rename or drop it. If that happens
 * this must fail loudly instead of silently leaving the interval running:
 * a silent regression here goes back to costing real money, continuously
 * and invisibly, on every running instance.
 */
function clearAwarenessCheckInterval(awareness: Awareness): void {
  const handle: unknown = awareness._checkInterval;

  if (!isIntervalHandle(handle)) {
    throw new Error(
      "y-protocols Awareness no longer exposes its repeating check timer " +
        `as a numeric \`_checkInterval\` handle (got ${typeof handle}). ` +
        "Without clearing it, that interval keeps every YDurableObjects " +
        "instance from ever hibernating, which is billed as continuous " +
        "Durable Object duration. Update clearAwarenessCheckInterval() in " +
        "ws-shared-doc.ts for the new y-protocols internals before " +
        "releasing this.",
    );
  }

  clearInterval(handle);
}

export class WSSharedDoc extends Doc implements Notification {
  /** origin（通常は WebSocket）をキーにした配信先 */
  private listeners = new Map<object, Listener>();
  readonly awareness = new Awareness(this);

  constructor(gc = true) {
    super({ gc });

    // Awareness のコンストラクタが張る repeating setInterval を即座に破棄する。
    // これが生き続ける限り Durable Object は絶対にハイバネートしない。
    // 詳細は clearAwarenessCheckInterval() のコメントを参照。
    clearAwarenessCheckInterval(this.awareness);
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
      // A later notify() for the same origin overwrites this entry; only
      // remove it if it's still the listener *this* call registered, so an
      // earlier unsubscribe can't delete a newer listener for the same origin.
      if (this.listeners.get(origin) === listener) {
        this.listeners.delete(origin);
      }
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
    try {
      this.listeners.get(origin)?.(message);
    } catch (e) {
      // A dead socket's send() throwing here would otherwise escape
      // update() and be misreported by callers (e.g. webSocketMessage's
      // exception boundary) as an "invalid message", when the real cause
      // was a disconnected recipient. Same shape as broadcast()'s guard.
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  private broadcast(message: Uint8Array, exclude: unknown) {
    for (const [origin, listener] of this.listeners) {
      if (origin === exclude) continue;

      try {
        listener(message);
      } catch (e) {
        // 1 つの接続が切断済み・エラー状態で listener(=ws.send) が例外を
        // 投げても、それ以降の健全な接続への配信を止めてはいけない。
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
  }
}
