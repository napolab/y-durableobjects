import { DurableObject } from "cloudflare:workers";
import { removeAwarenessStates } from "y-protocols/awareness";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { WSSharedDoc } from "../yjs/remote";

import { setupWSConnection } from "./client/setup";
import { createApp } from "./hono";
import { SessionRegistry } from "./session";
import { YSqliteStorage } from "./storage";

import type { SessionAttachment } from "./session";
import type { AwarenessChanges } from "../yjs/remote";
import type { Env } from "hono";

/** WebSocket 由来でない更新（JS RPC 経由）の origin */
const RPC_ORIGIN: object = Object.freeze({ source: "rpc" });

export type { SessionAttachment } from "./session";

export type YDurableObjectsAppType = ReturnType<typeof createApp>;

export class YDurableObjects<T extends Env> extends DurableObject<
  T["Bindings"]
> {
  protected app = createApp({
    createRoom: this.createRoom.bind(this),
  });
  protected doc = new WSSharedDoc();
  protected storage: YSqliteStorage;
  protected sessions = new SessionRegistry();

  constructor(
    public state: DurableObjectState,
    public env: T["Bindings"],
  ) {
    super(state, env);

    this.storage = new YSqliteStorage(state.storage.sql);

    void this.state.blockConcurrencyWhile(this.onStart.bind(this));
  }

  protected async onStart(): Promise<void> {
    const update = await this.storage.getUpdate();
    if (update !== null) {
      applyUpdate(this.doc, update);
    }

    for (const ws of this.state.getWebSockets()) {
      this.registerWebSocket(ws);
    }

    this.doc.on("update", async (update) => {
      await this.storage.storeUpdate(update);
    });
    this.doc.awareness.on(
      "update",
      ({ added, updated }: AwarenessChanges, origin: unknown) => {
        if (origin instanceof WebSocket) {
          this.sessions.track(origin, [...added, ...updated]);
        }
      },
    );
  }

  protected createRoom(roomId: string) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      roomId,
      connectedAt: Date.now(),
      clientIds: [],
    } satisfies SessionAttachment);

    this.state.acceptWebSocket(server);
    this.registerWebSocket(server);

    return client;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  async updateYDoc(update: Uint8Array): Promise<void> {
    this.doc.update(update, RPC_ORIGIN);
    await this.cleanup();
  }
  async getYDoc(): Promise<Uint8Array> {
    return encodeStateAsUpdate(this.doc);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    this.doc.update(new Uint8Array(message), ws);
    await this.cleanup();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.unregisterWebSocket(ws);
    await this.cleanup();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.unregisterWebSocket(ws);
    await this.cleanup();
  }

  protected registerWebSocket(ws: WebSocket) {
    setupWSConnection(ws, this.doc);
    const dispose = this.doc.notify(ws, (message) => {
      ws.send(message);
    });
    this.sessions.add(ws, dispose);
  }

  protected async unregisterWebSocket(ws: WebSocket) {
    try {
      // この接続が所有する clientID だけを削除する。
      // 部屋全体の clientID を削除すると他の参加者の presence まで消える。
      removeAwarenessStates(
        this.doc.awareness,
        this.sessions.clientIdsOf(ws),
        null,
      );
      this.sessions.remove(ws);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  protected async cleanup() {
    if (this.sessions.size < 1) {
      await this.storage.commit();
    }
  }
}
