import { Hono } from "hono";
import { removeAwarenessStates } from "y-protocols/awareness";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { upgrade } from "../middleware";
import { WSSharedDoc } from "../yjs/remote";

import { setupWSConnection } from "./client/setup";
import { YTransactionStorageImpl } from "./storage";

import type { AwarenessChanges } from "../yjs/remote";
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
  private awarenessClients = new Set<number>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: T["Bindings"],
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const doc = await this.storage.getYDoc();
      applyUpdate(this.doc, encodeStateAsUpdate(doc));

      for (const ws of this.state.getWebSockets()) {
        this.connect(ws);
      }
    });

    this.doc.on("update", async (update) => {
      await this.storage.storeUpdate(update);
    });
    this.doc.awareness.on(
      "update",
      async ({ added, removed, updated }: AwarenessChanges) => {
        for (const client of [...added, ...updated]) {
          this.awarenessClients.add(client);
        }
        for (const client of removed) {
          this.awarenessClients.delete(client);
        }
      },
    );

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
      const clientIds = this.awarenessClients;

      removeAwarenessStates(this.doc.awareness, Array.from(clientIds), null);
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
