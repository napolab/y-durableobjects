import { Hono } from "hono";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { upgrade } from "../middleware";
import { WSSharedDoc } from "../yjs/remote";

import { setupWSConnection } from "./client/setup";
import { YTransactionStorageImpl } from "./storage";

import type { Env } from "hono";

export class YDurableObjects<T extends Env> implements DurableObject {
  private app = new Hono<T>();
  private doc = new WSSharedDoc();
  private storage = new YTransactionStorageImpl({
    get: (key) => this.state.storage.get(key),
    list: (options) => this.state.storage.list(options),
    put: (key, value) => this.state.storage.put(key, value),
    delete: async (key) =>
      this.state.storage.delete(Array.isArray(key) ? key : [key]),
    transaction: (closure) => this.state.storage.transaction(closure),
  });
  private sessions = new Map<WebSocket, () => void>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: T["Bindings"],
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const doc = await this.storage.getYDoc();
      applyUpdate(this.doc, encodeStateAsUpdate(doc));

      this.doc.on("update", async (update) => {
        await this.storage.storeUpdate(update);
      });

      for (const ws of this.state.getWebSockets()) {
        this.connect(ws);
      }
    });

    this.app.get("/", upgrade(), async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      this.connect(server);

      return new Response(null, { webSocket: client, status: 101 });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    const update = new Uint8Array(message);
    this.doc.update(update);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws);
    await this.cleanup();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.disconnect(ws);
    await this.cleanup();
  }

  private connect(ws: WebSocket) {
    setupWSConnection(ws, this.doc);
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
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  private async cleanup() {
    if (this.sessions.size < 1) {
      await this.storage.commit();
    }
  }
}
