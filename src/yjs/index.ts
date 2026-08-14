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

  /** 永続化を直列化するためのキュー。Yjs の update イベントは同期的に発火するため必要 */
  private persist: Promise<void> = Promise.resolve();
  /** onStart() が複数回呼ばれても doc/awareness のリスナーを二重登録しないためのガード */
  private listenersRegistered = false;

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

    // 本番では onStart はコンストラクタの blockConcurrencyWhile からしか
    // 呼ばれず、二重登録は起こらない。ただし一部のテストは冷起動の代わりに
    // onStart() を直接呼び直して再水和ロジックを検証するため、リスナー登録
    // だけは冪等にしておく。ここを冪等にしないと、update リスナーが二重に
    // 登録され、以降の update ごとに schedulePersist が二重発火して永続化が
    // 重複する。
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;

      this.doc.on("update", (update: Uint8Array) => {
        this.schedulePersist(update);
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
    await this.persist;
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

    try {
      this.doc.update(new Uint8Array(message), ws);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[y-durableobjects] invalid message", error);
      ws.close(1003, "invalid message");

      return;
    }

    await this.persist;
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
      const clientIds = this.sessions.clientIdsOf(ws);

      // 先にリスナーを解除してから removeAwarenessStates を呼ぶこと。
      // removeAwarenessStates は awareness の "update" を同期的に発火させ、
      // WSSharedDoc.broadcast がまだ登録されたままの ws.send() を呼んでしまう。
      // 切断直後のソケットへの send() は例外を投げるため、その場合に
      // sessions.remove(ws) が実行されずリスナーがリークし、以降このルームの
      // 配信が全滅する。
      this.sessions.remove(ws);
      removeAwarenessStates(this.doc.awareness, clientIds, null);
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

  private schedulePersist(update: Uint8Array): void {
    this.persist = this.persist
      .then(() => this.storage.storeUpdate(update))
      .catch((error: unknown) => {
        this.onPersistFailure(error);
      });
    this.state.waitUntil(this.persist);
  }

  /**
   * 永続化に失敗したら全接続を閉じ、Durable Object をリセットする。
   *
   * 接続を閉じるだけではメモリ上の Doc がストレージより進んだまま残り、
   * 後続の接続が「正常に見える」状態を受け取ったあと、eviction 時に
   * 差分が無言で失われる。abort() でストレージから読み直させる。
   *
   * CRDT ではクライアント側が完全な状態を保持しているため、再接続時の
   * sync step 1 / 2 で失われた更新が再送され、障害は自己修復する。
   */
  private onPersistFailure(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[y-durableobjects] failed to persist update", error);

    for (const ws of this.state.getWebSockets()) {
      ws.close(1011, "storage failure");
    }
    this.state.abort("failed to persist a Yjs update");
  }
}
