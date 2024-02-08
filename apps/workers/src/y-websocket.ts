import { Bindings, HonoEnv } from "./types";
import { Hono } from "hono";
import { upgrade } from "./middleware";
import { WSSharedDoc } from "./ws-share-doc";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { fromUint8Array, toUint8Array } from "js-base64";

export class YWebsocket implements DurableObject {
  private app = new Hono<HonoEnv>();
  private doc = new WSSharedDoc();
  private sessions = new Map<WebSocket, () => void>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings,
  ) {
    console.log("initialize YWebsocket");
    this.state.blockConcurrencyWhile(async () => {
      const encoded = await this.state.storage.get<string>("doc");
      if (encoded !== undefined) {
        applyUpdate(this.doc, toUint8Array(encoded));
      }

      for (const ws of this.state.getWebSockets()) {
        const s = this.doc.subscribe((message) => {
          ws.send(message);
        });
        this.sessions.set(ws, s);
      }
    });

    this.app.get("/", upgrade, async (c) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      const s = this.doc.subscribe((message) => {
        server.send(message);
      });
      this.sessions.set(server, s);
      console.log("new connection", this.sessions.size);

      return new Response(null, { webSocket: client, status: 101 });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    try {
      this.doc.onMessage(ws, new Uint8Array(message));
    } catch (e) {
      console.error(e);
      this.doc.emit("error", [e]);
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    console.error("WebSocket error:", error);

    this.closeConnection(ws);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    console.log("WebSocket closed:", code, reason, wasClean);
    this.closeConnection(ws);
  }

  private closeConnection(ws: WebSocket) {
    try {
      const dispose = this.sessions.get(ws);
      dispose?.();
      this.sessions.delete(ws);
      console.log("connection count", this.sessions.size);

      if (this.sessions.size < 1) {
        const state = encodeStateAsUpdate(this.doc);
        const encoded = fromUint8Array(state);
        this.state.storage.put("doc", encoded);

        console.log("cleanup");
      }
    } catch (e) {
      console.error(e);
    }
  }
}
