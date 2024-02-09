import { Env, Hono } from "hono";
import { upgrade } from "../middleware";
import { WSSharedDoc } from "./ws-share-doc";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { fromUint8Array, toUint8Array } from "js-base64";

export class YWebsocket<T extends Env> implements DurableObject {
  private app = new Hono<T>();
  private doc = new WSSharedDoc();
  private sessions = new Map<WebSocket, () => void>();
  private readonly yDocKey = "doc";

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: T["Bindings"],
  ) {
    console.log("initialize YWebsocket");
    this.state.blockConcurrencyWhile(async () => {
      await this.restoreYDoc();

      for (const ws of this.state.getWebSockets()) {
        this.connect(ws);
      }
    });

    this.app.get("/", upgrade, async (c) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      this.connect(server);
      console.log("new connection", this.sessions.size);

      return new Response(null, { webSocket: client, status: 101 });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    try {
      this.doc.update(new Uint8Array(message));
    } catch (e) {
      console.error(e);
      this.doc.emit("error", [e]);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);

    await this.disconnect(ws);
    await this.cleanup();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log("WebSocket closed:", code, reason, wasClean);

    await this.disconnect(ws);
    await this.cleanup();
  }

  private connect(ws: WebSocket) {
    const s = this.doc.notify((message) => {
      ws.send(message);
    });
    this.sessions.set(ws, s);
  }

  private async disconnect(ws: WebSocket) {
    try {
      const dispose = this.sessions.get(ws);
      dispose?.();
      this.sessions.delete(ws);
      console.log("connection count", this.sessions.size);
    } catch (e) {
      console.error(e);
    }
  }

  private async cleanup() {
    if (this.sessions.size < 2) {
      await this.storeYDoc();
      console.log("cleanup");
    }
  }

  private async storeYDoc() {
    const state = encodeStateAsUpdate(this.doc);
    const encoded = fromUint8Array(state);
    await this.state.storage.put(this.yDocKey, encoded);
  }
  private async restoreYDoc() {
    const encoded = await this.state.storage.get<string>(this.yDocKey);
    if (encoded !== undefined) {
      applyUpdate(this.doc, toUint8Array(encoded));
    }
  }
}
