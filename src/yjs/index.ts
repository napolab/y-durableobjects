import { DurableObject } from "cloudflare:workers";
import { fromUint8Array, toUint8Array } from "js-base64";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { WSSharedDoc } from "../yjs/ws-share-doc";

import type { Env } from "hono";

export class YDurableObjects extends DurableObject<Env["Bindings"]> {
  private doc = new WSSharedDoc();
  private sessions = new Map<WebSocket, () => void>();
  private readonly yDocKey = "doc";

  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env["Bindings"],
  ) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      await this.restoreYDoc();

      for (const ws of this.ctx.getWebSockets()) {
        this.connect(ws);
      }
    });
  }

  socket() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    this.connect(server);

    return new Response(null, { webSocket: client, status: 101 });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    try {
      this.doc.update(new Uint8Array(message));
    } catch (e) {
      this.doc.emit("error", [e]);
    }
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
    if (this.sessions.size < 2) {
      await this.storeYDoc();
    }
  }

  private async storeYDoc() {
    const state = encodeStateAsUpdate(this.doc);
    const encoded = fromUint8Array(state);
    await this.ctx.storage.put(this.yDocKey, encoded);
  }
  private async restoreYDoc() {
    const encoded = await this.ctx.storage.get<string>(this.yDocKey);
    if (encoded !== undefined) {
      applyUpdate(this.doc, toUint8Array(encoded));
    }
  }
}
