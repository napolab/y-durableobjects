import { createMiddleware } from "hono/factory";
import { Bindings, HonoEnv } from "../types";
import { Hono } from "hono";
import { createEncoder, length, toUint8Array, writeVarUint } from "lib0/encoding";
import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import { readSyncMessage } from "y-protocols/sync";
import { applyAwarenessUpdate } from "y-protocols/awareness";
import { upgrade } from "../middleware";

const messageSync = 0;
const messageAwareness = 1;

export class YjsProvider implements DurableObject {
  private sessions: Set<WebSocket>;
  private app = new Hono<HonoEnv>();

  constructor(private readonly state: DurableObjectState, private readonly env: Bindings) {
    this.sessions = new Set(this.state.getWebSockets());

    this.app.get("/", upgrade, async (c) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      this.sessions.add(server);

      return c.body(null, { webSocket: client, status: 101 });
    });
  }
  fetch(request: Request): Response | Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    const buf = new Uint8Array(message);
  }

  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    this.sessions.delete(ws);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    this.sessions.delete(ws);
  }

  private messageListener(ws: WebSocket, message: Uint8Array) {
    try {
      const encoder = createEncoder();
      const decoder = createDecoder(message);
      const messageType = readVarUint(decoder);
      switch (messageType) {
        case messageSync:
          writeVarUint(encoder, messageSync);
          readSyncMessage(decoder, encoder, doc, conn);

          if (length(encoder) > 1) {
            send(doc, conn, toUint8Array(encoder));
          }
          break;
        case messageAwareness: {
          applyAwarenessUpdate(doc.awareness, readVarUint8Array(decoder), conn);
          break;
        }
      }
    } catch (e) {
      //
    }
  }
}
