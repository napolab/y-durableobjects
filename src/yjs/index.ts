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

const MIGRATION_GUIDE_URL =
  "https://github.com/napolab/y-durableobjects#migrating-from-v1-key-value-backend";

/**
 * SQLite バックエンドで動作しているかを確認する。
 * KV バックエンドでは sql へのアクセスが失敗するため、
 * 原因不明のクラッシュではなく移行手順を示したエラーにする。
 */
const assertSqliteBackend = (storage: DurableObjectStorage): void => {
  try {
    storage.sql.exec("SELECT 1");
  } catch (error) {
    throw new Error(
      `y-durableobjects v2 requires the SQLite storage backend. ` +
        `Use "new_sqlite_classes" in your wrangler migrations. ` +
        `Migration guide: ${MIGRATION_GUIDE_URL}`,
      { cause: error },
    );
  }
};

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

    assertSqliteBackend(state.storage);
    this.storage = new YSqliteStorage(state.storage.sql);

    // ping を自動応答にすることで、keepalive で Durable Object を
    // 起こさずに済む。duration 課金に最も効く設定。
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    void this.state.blockConcurrencyWhile(this.onStart.bind(this));
  }

  protected async onStart(): Promise<void> {
    const update = await this.storage.getUpdate();
    if (update !== null) {
      applyUpdate(this.doc, update);
    }

    for (const ws of this.state.getWebSockets()) {
      // ここはハイバネーションからの復帰パス。state.getWebSockets() が返す
      // ソケットのうち 1 つがすでに死んでいる（閉じている・エラー状態）こと
      // があり得る。registerWebSocket() は setupWSConnection() 経由で
      // ws.send() を呼ぶため、それだけで例外を投げうる。ここでガードせずに
      // 例外を外へ伝播させると、この for ループがそこで止まり、以降の
      // ソケットが二度と登録されないまま静かに配信を受けなくなる。さらに
      // 例外はコンストラクタの blockConcurrencyWhile まで伝播し、Durable
      // Object 全体がリセットされる — 例外境界を設けた意味そのものが
      // 失われる。1 つのソケットの復帰失敗が他のソケットの復帰を妨げては
      // いけない。
      try {
        this.registerWebSocket(ws);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }

    // 本番では onStart はコンストラクタの blockConcurrencyWhile からしか
    // 呼ばれず、二重登録は起こらない。ただし一部のテストは冷起動の代わりに
    // onStart() を直接呼び直して再水和ロジックを検証するため、リスナー登録
    // だけは冪等にしておく。ここを冪等にしないと、update リスナーが二重に
    // 登録され、以降の update ごとに schedulePersist が二重発火して永続化が
    // 重複する。
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.wireDocListeners();
    }
  }

  /**
   * this.doc に対して update / awareness update のリスナーを配線する。
   * onStart() から一度だけ呼ばれるほか、destroy() が this.doc を新しい
   * WSSharedDoc に差し替えたときにも呼び直す。
   */
  private wireDocListeners(): void {
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

  /**
   * 生の Yjs update を適用する。
   * WebSocket 経路と違い、プロトコルのフレーミングは不要。
   * getYDoc() の戻り値をそのまま渡せる。
   */
  async updateYDoc(update: Uint8Array): Promise<void> {
    applyUpdate(this.doc, update, RPC_ORIGIN);
    await this.persist;
    await this.cleanup();
  }
  async getYDoc(): Promise<Uint8Array> {
    return encodeStateAsUpdate(this.doc);
  }

  /** 部屋のデータを削除し、すべての接続を閉じる */
  async destroy(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      // すでに閉じている・エラー状態のソケットに close() を呼ぶと workerd は
      // 例外を投げることがある。1 つのソケットを閉じられないことが他の
      // ソケットを閉じ損ねたり、下の storage.destroy() の呼び出しを妨げたり
      // してはいけない。destroy() の存在意義はデータを消すことそのものなので、
      // 閉じ損ねたソケットが 1 つあってもデータ削除は必ず到達させる。
      try {
        ws.close(1001, "room destroyed");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }

      // この DO が自分から閉じたソケットは webSocketClose が確実に発火する
      // 保証がない。発火しなければ WSSharedDoc のリスナーがリークして以降
      // 毎回の broadcast が失敗するし、このソケットの awareness state が
      // 亡霊カーソルとしてルームに残り続け、sessions.size が 0 に落ちないため
      // cleanup() の「全員退出でコンパクション」条件も二度と成立しなくなる。
      // unregisterWebSocket は冪等なので、webSocketClose が別途発火しても
      // 問題ない。
      await this.unregisterWebSocket(ws);
    }

    // destroy() の時点で永続化キューにまだ書き込みが残っていることがある。
    // 先に drain してから DELETE しないと、キューに残っていた storeUpdate が
    // DELETE FROM updates の後に着地し、孤児行として復活してしまう。
    await this.persist;
    await this.storage.destroy();

    // メモリ上の Doc をストレージより進んだまま残すと、まだ生きているこの
    // インスタンスに接続してきたクライアントが sync step 1/2 で消したはずの
    // 内容を受け取ってしまい、以降の差分は実在しない親 struct を参照する
    // ようになる。onPersistFailure が state.abort() でインスタンスごと
    // 破棄するのと同じ理由だが、destroy() は RPC でありインスタンスを
    // 生かしたまま応答する必要があるため、abort() の代わりに Doc を
    // 作り直して同じ効果を得る。
    this.doc = new WSSharedDoc();
    this.wireDocListeners();
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

      // この DO 自身が閉じたソケットに対して webSocketClose が確実に発火する
      // 保証はない。発火しなければ unregisterWebSocket が一生呼ばれず、
      // WSSharedDoc のリスナーがリークして以降の broadcast がずっと失敗し、
      // このソケットの awareness state もルームに残り続ける。冪等なので
      // webSocketClose が別途発火しても問題ない。
      await this.unregisterWebSocket(ws);

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
      // すでに閉じている・エラー状態のソケットに close() を呼ぶと workerd は
      // 例外を投げる（例えば、この例外境界が 1003 で閉じた直後のソケット、
      // あるいは今回の失敗の原因になったソケット自身）。1 つのソケットを
      // 閉じられないことが他のソケットを閉じ損ねたり、下の abort() の
      // 呼び出しを妨げたりしてはいけない。abort() こそがこのポリシーの
      // 本体であり、閉じ損ねたソケットが 1 つあっても必ず到達させる。
      try {
        ws.close(1011, "storage failure");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
    this.state.abort("failed to persist a Yjs update");
  }
}
