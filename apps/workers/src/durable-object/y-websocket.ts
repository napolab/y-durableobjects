import { Bindings, HonoEnv } from "../types";
import { Hono } from "hono";
import { createEncoder, length, toUint8Array, writeVarUint, writeVarUint8Array } from "lib0/encoding";
import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { upgrade } from "../middleware";
import { Doc } from "yjs";
import { setIfUndefined } from "lib0/map";

const messageSync = 0;
const messageAwareness = 1;

type Changes = {
  added: Array<number>
  updated: Array<number>
  removed: Array<number>
}

class WSSharedDoc extends Doc {
  readonly conns = new Map<WebSocket, Set<unknown>>()
  readonly awareness = new Awareness(this)

  constructor(private readonly name: string, gc = true) {
    super({ gc })
    this.awareness.setLocalState(null)
    this.awareness.on("update", (changes: Changes) => {
      this.awarenessChangeHandler(changes)
    })
    this.on("update", (update: Uint8Array) => {
      const encoder = createEncoder()
      writeVarUint(encoder, messageSync)
      writeUpdate(encoder, update)
      const message = toUint8Array(encoder)
      this.sendMessage(message)
    })
  }

  private awarenessChangeHandler({ added, updated, removed }: Changes) {
    const changedClients = [...added, ...updated, ...removed]
    const encoder = createEncoder()
    writeVarUint(encoder, messageAwareness)
    writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(this.awareness, changedClients, this.awareness.states)
    )
    const buff = toUint8Array(encoder)
    this.sendMessage(buff)

  }

  private sendMessage(message: Uint8Array) {
    for (const [ws, _] of this.conns) {
      ws.send(message)
    }
  }
}

export class YjsProvider implements DurableObject {
  private sessions: Set<WebSocket>;
  private app = new Hono<HonoEnv>();
  private docs = new Map()
  private doc: WSSharedDoc

  constructor(private readonly state: DurableObjectState, private readonly env: Bindings) {
    this.sessions = new Set(this.state.getWebSockets());
    this.doc = this.getYDoc(state.id.toString(), true)

    for (const ws of this.sessions) {
      this.doc.conns.set(ws, new Set())
    }

    this.setup()

    this.app.get("/", upgrade, async (c) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      this.sessions.add(server);
      this.doc.conns.set(server, new Set())

      return new Response(null, { webSocket: client, status: 101 });
    });
  }
  fetch(request: Request): Response | Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  private getYDoc(docname: string, gc = true) {
    return setIfUndefined(this.docs, docname, () => {
      const ydoc = new WSSharedDoc(docname, gc)
      this.docs.set(docname, ydoc)
      return ydoc
    })
  }

  private setup() {
    const encoder = createEncoder()
    writeVarUint(encoder, messageSync)
    this.send(toUint8Array(encoder))

    const awarenessStates = this.doc.awareness.getStates()
    if (awarenessStates.size > 0) {
      writeVarUint(encoder, messageAwareness)
      writeVarUint8Array(
        encoder,
        encodeAwarenessUpdate(
          this.doc.awareness,
          Array.from(awarenessStates.keys()),
          this.doc.awareness.states
        )
      )
      this.send(toUint8Array(encoder))
    }
  }

  private send(message: Uint8Array) {
    for (const ws of this.sessions) {
      ws.send(message)
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    try {
      const encoder = createEncoder()
      const decoder = createDecoder(new Uint8Array(message))
      const messageType = readVarUint(decoder)

      switch (messageType) {
        case messageSync: {
          writeVarUint(encoder, messageSync)
          readSyncMessage(decoder, encoder, this.doc, ws)

          if (length(encoder) > 1) {
            this.send(toUint8Array(encoder))
          }
          break
        }
        case messageAwareness: {
          applyAwarenessUpdate(this.doc.awareness, readVarUint8Array(decoder), ws)
          break
        }
      }
    } catch (e) {
      console.error(e)
      this.doc.emit("error", [e])
    }

  }

  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    this.sessions.delete(ws);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    this.sessions.delete(ws);
  }
}
