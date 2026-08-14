# y-durableobjects v2: SQLite バックエンドへの完全移行

- 日付: 2026-08-14
- 対象バージョン: v2.0.0（破壊的変更を含むメジャーリリース）
- 現行バージョン: v1.0.5

## 1. 背景

`y-durableobjects` は Cloudflare Durable Objects の **key-value バックエンド**（`new_classes`）を前提に設計されている。Cloudflare は現在、既存の KV バックエンド namespace を持たないアカウントに対して KV バックエンドの新規作成を許可しておらず、Free プランでは SQLite バックエンドのみが利用可能である。したがって現行の v1 は **新規ユーザーがそもそもデプロイできない**状態にある。

加えて、KV バックエンドの制約に起因する複数の重大な不具合が存在する。

| ID | 内容 | 根拠 |
| --- | --- | --- |
| C-1 | `new_classes`（KV バックエンド）を前提としており、新規アカウントで利用不可 | `wrangler.toml:12`、README |
| C-2 | スナップショット全体を 1 キーに `put` するため、ドキュメントが 128KiB を超えると保存に失敗する | `src/yjs/storage/index.ts:105`、KV 値上限 128KiB |
| C-3 | コンパクション時の `delete(keys)` が 128 キー制限を超えて例外になる（既定 `maxUpdates` は 500） | `src/yjs/storage/index.ts:102` |
| C-4 | WebSocket が 1 本切断されると、部屋全体の awareness state が消える | `src/yjs/index.ts:132-134` |
| C-5 | 永続化が floating promise であり、完了保証・エラー処理・順序保証のいずれも無い | `src/yjs/index.ts:56-58` |
| H-1 | syncStep2 の応答が要求元だけでなく全接続にブロードキャストされる | `src/yjs/remote/ws-shared-doc.ts:56-58` |
| H-2 | 送信者自身に更新がエコーバックされる（origin を除外していない） | `src/yjs/remote/ws-shared-doc.ts:99-103` |
| H-3 | `getYDoc()` は生の Yjs update を返すが、`updateYDoc()` はプロトコル framing 済みメッセージを要求する。README のサンプルは動作しない | `src/yjs/index.ts:91-97`、`src/e2e/helper.ts:16` |
| H-4 | `webSocketMessage` に例外境界が無く、不正なバイナリ 1 通で DO がリセットされ全接続が落ちる | `src/yjs/index.ts:99-107` |
| H-5 | ストレージキーがゼロパディングされておらず、`list()` の復元順が更新順と一致しない | `src/yjs/storage/storage-key/index.ts:12` |
| H-7 | `queryAwareness`(3) と `auth`(2) が未実装で、`update()` の switch に `default` が無く未知の型を無言で捨てる | `src/yjs/message-type/index.ts:3-6` |

ストレージ種別は namespace 作成後に変更できない（`storage_type_mismatch`）ため、SQLite への移行はどのみち破壊的変更になる。この一度きりの機会に上記の不具合をすべて解消する。

## 2. スコープ

### 含むもの

- KV バックエンドから SQLite バックエンドへの完全移行（KV 実装は削除する）
- C-1 〜 C-5、H-1 〜 H-5、H-7 の修正
- WebSocket Hibernation の衛生（`setWebSocketAutoResponse`、`serializeAttachment` の実用化）
- `destroy()` RPC の追加
- 既存ユーザー向けの移行手順の文書化と、KV バックエンド検出時の明示的エラー

### 含まないもの

- 認証フック（`onBeforeConnect` 等の API 追加）。v2.1 以降に回す
- KV バックエンド向けの互換実装・移行ヘルパーの同梱
- R2 版履歴、Point-in-Time Recovery、Analytics Engine、Vectorize 連携などの新機能
- alarm を用いた時間ベースのコンパクションやアイドル部屋のアーカイブ

## 3. 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| リリーススコープ | SQLite 移行とバグ修正を v2.0.0 に一括で入れる | ストレージ種別変更が破壊的変更を強制するため、同じリリースにまとめる |
| 既存ユーザーの移行 | ライブラリは移行コードを持たない。KV バックエンドを検出したら手順書 URL 付きで throw し、README に移行レシピを載せる | H-3 修正により v1 の `getYDoc()` → v2 の `updateYDoc()` が成立し、専用コードが不要になる |
| ストレージスキーマ | 単一 `updates` テーブル。スナップショットと増分更新を区別しない | C-2 / C-3 / H-5 が設計から消える。2MB 超のチャンク分割が構造的に自然に扱える |
| コンパクション発火条件 | 行数しきい値（既定 2000 行）と全接続切断時の 2 つのみ。alarm による時間ベースの発火は使わない | 実装が単純でテストしやすい。rows read は rows written の 1/1000 の単価なので、しきい値を高く取るのが最適 |
| awareness の所有権 | `serializeAttachment` に clientID を永続化する | hibernation を跨いで所有権が保たれる。メモリ上の Map のみでは復帰後に幽霊カーソルが残る |
| 永続化失敗時の挙動 | 全接続を閉じ、メモリ上の状態も破棄する | CRDT ではクライアントが完全な状態を保持しており、再接続時に失われた更新が自己修復する |
| ORM / クエリビルダ | 採用しない。SQL は `storage/queries.ts` に隔離する | クエリが 3 本ですべて静的。Drizzle は API が非同期のため暗黙トランザクションの atomicity を壊すリスクがある |
| スキーマ版管理 | `PRAGMA user_version` ベースの自前マイグレーションランナー | 完全に同期実行でき、依存ゼロで 10 行程度に収まる |

### ORM を採用しない判断の詳細

**Drizzle ORM** は `drizzle-orm/durable-sqlite` で Durable Objects を正式サポートしているが、API が Promise ベースである。本設計はコンパクション時の `DELETE` と複数の `INSERT` が `await` を挟まずに実行されることで暗黙トランザクションの atomicity を得ているため、非同期 API はこの前提を壊すリスクがある。加えて unpacked size が 10MB あり、published library の依存としては重い。

**Kysely** は `compile(): CompiledQuery` が同期であり、`{ sql, parameters }` を取り出して自前の `sql.exec()` に渡す「コンパイラとしてのみ使う」構成が可能なため、atomicity の問題は発生しない。unpacked size も 1.7MB と Drizzle の 1/6 である。しかし本設計のクエリは 3 本ですべて静的であり、クエリビルダの価値が発生しない。テーブルが 1 つなので、型安全性は `sql.exec<UpdateRow>()` に渡す行型を 1 つ手書きすれば実質的に同等に得られる。なお Durable Objects 向けの公式 dialect は `kysely-do@0.0.1-rc.1` のみで、published library の依存としては採用できない（上記の compile-only 構成では dialect 自体が不要）。

将来スキーマが増えた場合に備え、SQL 生成は `storage/queries.ts` に隔離する。Kysely への差し替えが必要になった場合、このファイルの内部だけの変更で完結する。

## 4. アーキテクチャ

### ファイル構成

```
src/yjs/
  index.ts                  YDurableObjects（SQLite 専用）
  internal.ts               テスト用の内部インターフェース
  session/index.ts          新規: SessionRegistry（ws ↔ clientID、attachment 永続化）
  storage/
    index.ts                YSqliteStorage
    type.ts                 YStorage インターフェース
    schema.ts               新規: user_version マイグレーションランナー
    queries.ts              新規: SQL 文字列の隔離
    storage-key/            削除
  remote/ws-shared-doc.ts   origin 対応に改修
  message-type/index.ts     auth / queryAwareness を追加
  hono/index.ts             変更なし
  client/setup.ts           変更なし
src/middleware/index.ts     変更なし
src/index.ts                yRoute（getByName への変更のみ）
```

`SessionRegistry` を独立させることで、awareness の所有権管理・attachment の読み書き・hibernation 復帰時の再構築を 1 箇所に閉じ込め、`YDurableObjects` 本体の肥大化を防ぐ。単体でテスト可能な単位とする。

## 5. ストレージ層

### スキーマ

```sql
CREATE TABLE IF NOT EXISTS updates (
  seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind INTEGER NOT NULL,   -- 0 = 独立した update / 1 = 直前行から続くバイト断片
  data BLOB NOT NULL
);
```

`kind` カラムが必要な理由: Yjs の update はバイト列として単純に分割・連結できない。`Y.mergeUpdates([a, b])` は正しく動作するが、1 本の update を機械的に分割した断片は単体では有効な update ではなく、`mergeUpdates` では復元できない。したがってコンパクション結果が SQLite の BLOB 上限を超える場合はバイト断片として分割し、読み出し時に連結してから 1 本の update として扱う必要がある。

### インターフェース

```ts
export interface YStorage {
  getUpdate(): Promise<Uint8Array | null>;
  storeUpdate(update: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  destroy(): Promise<void>;
}
```

`getYDoc(): Promise<Doc>` は廃止し、`getUpdate(): Promise<Uint8Array | null>` にする。呼び出し側は `applyUpdate(this.doc, update)` するだけでよく、v1 の「起動時に Doc を 2 つ構築する」無駄が解消される。

### 読み出し

`SELECT kind, data FROM updates ORDER BY seq` を走査し、`kind = 1` の行は直前のバッファに連結、`kind = 0` で新しい update を開始する。最後に `Y.mergeUpdates([...])` で 1 本にまとめて返す。**Doc を一切構築しない。**

### 書き込み

`INSERT INTO updates (kind, data) VALUES (0, ?)` の 1 文のみ。行数はメモリ上のカウンタで保持し、起動時に `SELECT COUNT(*)` で 1 回だけ復元する。v1 の `bytes` / `count` キーへの 2 回の追加 `put` が不要になり、1 更新あたりの書き込みが 3 回から 1 回に減る。

### コンパクション

`maxRows`（既定 2000）に到達したら実行する。

1. 全行を `SELECT` し `Y.mergeUpdates` で 1 本化する
2. `DELETE FROM updates`
3. マージ結果を `maxChunkBytes`（1MB）ごとに分割し、先頭を `kind = 0`、以降を `kind = 1` として `INSERT`
4. メモリ上の行数カウンタを分割後のチャンク数で更新する

`sql.exec` は同期であるため、この一連の書き込みの間に `await` を挟まなければ暗黙のトランザクションとして atomic に適用される。Cloudflare のドキュメントは "Any series of write operations with no intervening `await` will automatically be submitted atomically" と明記している。したがって v1 の `TransactionStorage` 抽象および `storage.transaction()` の利用は不要となり、削除する。

加えて、全接続が切断されたとき（`SessionRegistry` が空になったとき）にも `commit()` を実行する。これは v1 の `cleanup()` と同じ発想を維持する。時間ベースの発火（alarm）は導入しない。

### コンストラクタオプション

v1 の `{ maxBytes?, maxUpdates? }` を廃止し、`{ maxRows?, maxChunkBytes? }` に置き換える。

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `maxRows` | 2000 | この行数に到達したらコンパクションを実行する |
| `maxChunkBytes` | 1MB | コンパクション結果を分割する単位。SQLite の 2MB 上限に対する安全マージン |

`maxBytes` はバイト数ベースの制御であり、KV の 128KiB 値上限に合わせるために存在していた。SQLite では行サイズがコストに影響しないため、この概念は廃止する。

### サイズ上限

SQLite の BLOB / 行の上限は 2MB のため、チャンクサイズは安全マージンを取って 1MB とする。Durable Object あたりのストレージは 10GB だが、`mergeUpdates` の結果と Yjs の `Doc` をメモリに載せる必要があるため、**実質的な上限は Durable Object の 128MB メモリ**である。この制約は README に明記する。

### スキーマ版管理

```ts
// src/yjs/storage/schema.ts
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE updates (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     kind INTEGER NOT NULL,
     data BLOB NOT NULL
   )`,
];

export const migrate = (sql: SqlStorage): void => {
  const version = sql.exec<{ user_version: number }>("PRAGMA user_version").one().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) sql.exec(MIGRATIONS[i]);
  sql.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
};
```

すべて同期実行のため `blockConcurrencyWhile` の中で atomic に完了する。将来スキーマを変更する場合は `MIGRATIONS` 配列に `ALTER TABLE` を追記するだけでよい。Durable Object の SQLite はインスタンスごとに独立した DB であるため、各インスタンスがそれぞれ初回起動時に自分のペースでマイグレートする。

## 6. Durable Object 本体

### 6-1. broadcast への origin の伝播（H-1 / H-2）

`WSSharedDoc` の listener を origin 付きに変更する。

```ts
class WSSharedDoc extends Doc {
  #listeners = new Map<object, Listener>();   // origin(WebSocket) → listener

  notify(origin: object, listener: Listener): Unsubscribe;

  update(message: Uint8Array, origin: object): void {
    // sync:      readSyncMessage(decoder, encoder, this, origin)
    //            length(encoder) > 1 なら origin にのみ送信
    // awareness: applyAwarenessUpdate(this.awareness, payload, origin)
  }
}
```

Yjs は `doc.on("update", (update, origin) => …)` および `awareness.on("update", (changes, origin) => …)` の第 2 引数に transaction origin を渡す。これを利用して、更新のブロードキャストから origin を除外する。

- syncStep2 の応答は要求元の接続にのみ返す（H-1）
- 送信者自身にはエコーバックしない（H-2）

RPC の `updateYDoc()` 経由の更新は origin を持たないため全接続にブロードキャストされる。これは意図した挙動である。

### 6-2. awareness の所有権（C-4）

`awarenessClients: Set<number>` を廃止し、`SessionRegistry` に置き換える。

```ts
export type SessionAttachment = {
  roomId: string;
  connectedAt: number;
  clientIds: number[];
};
```

clientID の特定には 6-1 で伝播させた origin をそのまま使う。

```ts
this.doc.awareness.on("update", ({ added, updated }, origin) => {
  if (origin instanceof WebSocket) registry.track(origin, [...added, ...updated]);
});
```

`applyAwarenessUpdate(awareness, payload, ws)` に渡した origin が awareness の update イベントまで伝播するため、awareness メッセージをデコードして clientID を抽出する処理は不要である。

切断時は該当接続の clientIds のみを `removeAwarenessStates` に渡す。

```ts
async webSocketClose(ws: WebSocket) {
  removeAwarenessStates(this.doc.awareness, registry.clientIdsOf(ws), null);
  registry.remove(ws);
  await this.maybeCommit();
}
```

hibernation からの復帰時は `onStart` で `state.getWebSockets()` を走査し、各 WebSocket の `deserializeAttachment()` から `SessionRegistry` を再構築する。v1 で書き込まれていながら一度も読まれていなかった `WebSocketAttachment` が、ここで実際に機能する。

### 6-3. 永続化の直列化（C-5）

```ts
#persist: Promise<void> = Promise.resolve();

#schedulePersist(update: Uint8Array): void {
  this.#persist = this.#persist
    .then(() => this.storage.storeUpdate(update))
    .catch((e) => this.#onPersistFailure(e));
  this.state.waitUntil(this.#persist);
}
```

`doc.on("update")` からこれを呼び、`webSocketMessage` の末尾で `await this.#persist` する。宙に浮いた Promise が無くなり、行数カウンタの競合も直列化によって解消する。

### 6-4. 永続化失敗時の挙動

`#onPersistFailure` は以下を行う。

1. エラーをログに出力する
2. `state.getWebSockets()` の全接続を close code `1011`（Internal Error）で閉じる
3. メモリ上の Doc の状態を破棄する

3 が必要な理由: 書き込み失敗時点でメモリ上の `this.doc` はストレージより進んでおり、DO 自体は生存し続ける。接続を閉じるだけでは、その後に接続したクライアントが「正常に見える」メモリ上の状態を受け取り、DO が evict された時点で差分が無言で失われる。`state.abort()` によって Durable Object をリセットし、次回起動時にストレージから読み直させる方針とする（`state.abort()` の実挙動は実装時に workerd 上で検証する）。

この選択が妥当な理由: CRDT ではクライアント側が完全な状態を保持している。`1011` での切断後、y-websocket クライアントは自動再接続し、syncStep1 / syncStep2 の過程で失われた更新を再送するため、障害が自己修復する。

### 6-5. 例外境界（H-4）

```ts
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
  if (!(message instanceof ArrayBuffer)) return;
  try {
    this.doc.update(new Uint8Array(message), ws);
  } catch (e) {
    console.error("[y-durableobjects] invalid message", e);
    ws.close(1003, "invalid message");
    return;
  }
  await this.#persist;
}
```

不正なバイナリを送った接続のみを閉じ、Durable Object と他の接続は影響を受けない。

### 6-6. Hibernation の衛生

```ts
this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```

文字列メッセージは `webSocketMessage` の先頭で無視されているため、既存の挙動と衝突しない。README に「クライアントが `"ping"` を定期送信すれば Durable Object を起こさずに keepalive できる」ことを明記する。duration 課金への影響が最も大きい項目である。

`acceptWebSocket()` のタグは付けない。clientID は接続確立時点では未確定であり、タグは `acceptWebSocket` 呼び出し時に確定している必要があるため相性が悪い。

## 7. 公開 API と移行

### RPC API

```ts
getYDoc(): Promise<Uint8Array>                  // 生の Yjs update（v1 から変更なし）
updateYDoc(update: Uint8Array): Promise<void>   // 生の Yjs update を受け取る（破壊的変更）
destroy(): Promise<void>                        // 新規
```

`updateYDoc` からプロトコル framing の要求を外し、内部で `applyUpdate(this.doc, update)` する（H-3）。これにより `getYDoc()` の出力をそのまま `updateYDoc()` に渡せるようになり、README のサンプルが実際に動作する。

`destroy()` は全接続を close code `1001` で閉じ、`DELETE FROM updates` を実行する。テーブル定義と `user_version` は維持する。

### エクスポートされる型の変更

`src/index.ts` から公開している型のうち、以下が破壊的に変更される。

| v1 | v2 | 備考 |
| --- | --- | --- |
| `YTransactionStorage` | `YStorage` | `getYDoc(): Promise<Doc>` が `getUpdate(): Promise<Uint8Array \| null>` になり、`destroy()` が追加される |
| `WSSharedDoc` | `WSSharedDoc` | `notify(cb)` が `notify(origin, cb)` に、`update(message)` が `update(message, origin)` になる |
| `RemoteDoc` | `RemoteDoc` | 変更なし |

`TransactionStorage`（`storage/type.ts`）は非公開だったため、削除しても公開 API には影響しない。

### KV バックエンドの検出

コンストラクタの `blockConcurrencyWhile` 内で SQLite バックエンドかを確認し、そうでなければ移行手順の URL を含むエラーを throw する。`"sql" in storage` による判定は確実でない可能性があるため、`sql.exec("SELECT 1")` を実際に試行する方式とし、workerd 上の実挙動は実装時に検証する。

### 移行レシピ（README に掲載）

v1 と v2 を別バインディングに共存させ、RPC で内容をコピーする。

```ts
app.post("/migrate/:id", async (c) => {
  const id = c.req.param("id");
  const legacy = c.env.Y_LEGACY.getByName(id);           // v1 / KV バックエンド
  const next   = c.env.Y_DURABLE_OBJECTS.getByName(id);  // v2 / SQLite バックエンド
  await next.updateYDoc(await legacy.getYDoc());
  return c.json({ ok: true });
});
```

v1 の `getYDoc()` は元から生の update を返しており、v2 の `updateYDoc()` は生の update を受け取るため、この組み合わせが成立する。ライブラリ側に移行専用コードを持つ必要がない。

### 設定ファイル

- `wrangler.toml` および README の migration を `new_sqlite_classes` に変更する
- `compatibility_date` を更新する
- README では新しい `exports` 形式にも言及する

### メッセージ型（H-7）

`message-type/index.ts` に `auth`(2) と `queryAwareness`(3) を追加し、`WSSharedDoc.update()` の switch に `default` 節を設けて未知の型を無言で捨てないようにする。

### `yRoute`

`obj.get(obj.idFromName(id))` を `obj.getByName(id)` に置き換える。それ以外の挙動は変更しない。

## 8. テスト戦略

実装は TDD で進める。既知の不具合については、先に失敗するテストを書いてから修正する。

`wrangler.toml` のテスト環境も `new_sqlite_classes` に切り替える。現行の `src/yjs/storage/storage.test.ts` は `TransactionStorage` をモックする方式だが、v2 ではテスト対象が SQLite の挙動そのものになるため、`runInDurableObject` 経由で実物の `ctx.storage.sql` を使う統合テストに書き換える。

| # | 検証内容 | 対応 ID |
| --- | --- | --- |
| 1 | 2MB を超えるドキュメントがチャンク分割され、round-trip で復元できる | C-2 |
| 2 | しきい値到達でコンパクションが走り、行数が減って内容が保たれる | C-3 |
| 3 | 3 接続のうち 1 つを切断しても、他 2 接続の awareness state が残る | C-4 |
| 4 | 永続化失敗時に全接続が閉じ、メモリ上の状態が破棄される | 6-4 |
| 5 | syncStep2 が要求元にのみ返り、他の接続には届かない | H-1 |
| 6 | 送信者に自分の更新がエコーバックされない | H-2 |
| 7 | `getYDoc()` → `updateYDoc()` の round-trip が成立する | H-3 |
| 8 | 不正なバイナリでその接続のみ閉じ、DO と他接続は生存する | H-4 |
| 9 | 1000 件の更新が `seq` 順に復元される | H-5 |
| 10 | `deserializeAttachment` から awareness の所有権が復元される | 6-2 |
| 11 | `user_version` マイグレーションが冪等である | 5 |

### テスト上の制約

`@cloudflare/vitest-pool-workers` には hibernation を強制的に発生させる API が存在しない。したがって #10 は「新しい `SessionRegistry` を生成し、既存の WebSocket の attachment から所有権を再構築できること」をユニットレベルで検証する形になり、実際の hibernation 往復は E2E では検証できない。

## 9. 既知の限界

- ドキュメントサイズの実質的な上限は Durable Object の 128MB メモリである。SQLite の 10GB は活用しきれない
- 実際の hibernation 往復を自動テストで検証できない（8 節参照）
- KV バックエンドで稼働中の既存ユーザーは、手動でのデータ移行が必要である
- `state.abort()` の実挙動は未検証であり、実装時に確認が必要である
- `sql.exec("SELECT 1")` による KV バックエンド検出の確実性は未検証であり、実装時に確認が必要である

## 10. 参考

- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Object Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Durable Objects Migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
