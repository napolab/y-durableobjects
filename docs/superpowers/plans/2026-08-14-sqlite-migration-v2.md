# y-durableobjects v2 SQLite Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `y-durableobjects` を Durable Objects の legacy key-value ストレージバックエンドから SQLite バックエンドへ完全移行し、その破壊的変更に便乗して既知の重大な不具合（C-1〜C-5 / H-1〜H-5 / H-7）をすべて解消する。

**Architecture:** 単一の `updates` テーブルにすべてを保存する。スナップショットと増分更新を区別せず、コンパクションは「全行を `Y.mergeUpdates` で 1 本にして書き戻す」だけの操作にする。1 本化した結果が SQLite の BLOB 上限を超える場合はバイト断片に分割し、`kind` カラムで断片であることを示す。Yjs の transaction origin を WebSocket まで通すことで、ブロードキャストの除外と awareness 所有権の追跡を同一の仕組みで解決する。

**Tech Stack:** TypeScript (strict), Cloudflare Durable Objects (SQLite backend), Yjs / y-protocols / lib0, Hono, Vitest + `@cloudflare/vitest-pool-workers`, tsup, ESLint + Prettier, changesets

**Spec:** `docs/superpowers/specs/2026-08-14-sqlite-migration-design.md`

## Global Constraints

- ブランチは `feat/sqlite-migration-v2`。spec は既にこのブランチにコミット済み。
- テスト実行は `pnpm exec vitest run <path>`。`pnpm test` は全件実行。`mise` 管理のため `pnpm` が見つからない場合は `export PATH="$HOME/.local/share/mise/shims:$PATH"` を先に実行する。
- コミット前に必ず `pnpm fmt`（Prettier + ESLint --fix）と `pnpm typecheck` を通す。
- ESLint: `no-console` は `error`。ログ出力が必要な箇所は既存コードと同様に `// eslint-disable-next-line no-console` を直前に置く。`newline-before-return` が `error` なので `return` の前に空行を入れる。
- TypeScript strict。`any` は使用しない。`ws.deserializeAttachment()` は `any` を返すので `const raw: unknown = ws.deserializeAttachment();` のように `unknown` で受ける。
- ファイル名は kebab-case。import 順序は ESLint が強制する（`pnpm fmt` で自動整列）。
- **`PRAGMA` は Durable Objects の SQLite では使用不可**（`Error: not authorized: SQLITE_AUTH`）。スキーマ版管理は `schema_version` テーブルで行う。
- **BLOB カラムは `ArrayBuffer` として返る。** 読み出し時は `new Uint8Array(row.data)` で変換する。書き込み時は `Uint8Array` をそのままバインドできる。
- `sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` を実行できない。`await` を挟まない連続した書き込みが暗黙のトランザクションとして atomic に適用されることを利用する。**コンパクションの `DELETE` と `INSERT` の間に `await` を入れてはならない。**
- 確認済みの型定義（`worker-configuration.d.ts`）:
  - `DurableObjectState.abort(reason?: string): void`
  - `DurableObjectState.setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void`
  - `new WebSocketRequestResponsePair(request: string, response: string)`
  - `SqlStorage.exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]): SqlStorageCursor<T>`
  - `type SqlStorageValue = ArrayBuffer | string | number | null`
  - カーソルは `toArray()` / `one()` / `next()` / `raw()` を持つ

---

### Task 1: SQLite バックエンドへの切り替えとスキーマ管理

KV バックエンドから SQLite バックエンドへ設定を切り替え、`schema_version` テーブルによるマイグレーションランナーを追加する。KV API は SQLite バックエンド上でも隠しテーブル `__cf_kv` 経由で透過的に動作するため、既存コードは無変更で全テストが通る（検証済み）。

**Files:**
- Modify: `wrangler.toml:3`（`compatibility_date`）, `wrangler.toml:12`（`new_classes` → `new_sqlite_classes`）
- Create: `src/yjs/storage/schema.ts`
- Test: `src/yjs/storage/schema.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `migrate(sql: SqlStorage): void` — `updates` テーブルと `schema_version` テーブルを作成し、冪等に実行できる

- [ ] **Step 1: wrangler.toml を SQLite バックエンドに切り替える**

`wrangler.toml` を以下の内容にする。

```toml
name = "yjs-workers"
main = "src/e2e/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags=["nodejs_compat"]

[[durable_objects.bindings]]
name = "Y_DURABLE_OBJECTS"
class_name = "YDurableObjects"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["YDurableObjects"]
```

- [ ] **Step 2: 既存テストが SQLite バックエンドでも全件通ることを確認する**

Run: `pnpm exec vitest run`
Expected: PASS（41 tests）。`create-app.test.ts` の stderr に `Error: Service Error` が出るが、これは意図的なエラー系テストの出力であり失敗ではない。

- [ ] **Step 3: schema.test.ts に失敗するテストを書く**

```ts
// src/yjs/storage/schema.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migrate } from "./schema";

const withSql = async (fn: (sql: SqlStorage) => void): Promise<void> => {
  const stub = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    fn(state.storage.sql);
  });
};

describe("migrate", () => {
  it("creates the updates table", async () => {
    await withSql((sql) => {
      migrate(sql);

      const tables = sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);

      expect(tables).toContain("updates");
      expect(tables).toContain("schema_version");
    });
  });

  it("records the schema version", async () => {
    await withSql((sql) => {
      migrate(sql);

      const row = sql.exec<{ version: number }>("SELECT version FROM schema_version").one();

      expect(row.version).toBe(1);
    });
  });

  it("is idempotent and preserves existing rows", async () => {
    await withSql((sql) => {
      migrate(sql);
      sql.exec("INSERT INTO updates (kind, data) VALUES (?, ?)", 0, new Uint8Array([1, 2, 3]));

      migrate(sql);

      const count = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM updates").one();
      const version = sql.exec<{ version: number }>("SELECT version FROM schema_version").one();

      expect(count.count).toBe(1);
      expect(version.version).toBe(1);
    });
  });
});
```

- [ ] **Step 4: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/yjs/storage/schema.test.ts`
Expected: FAIL — `Failed to resolve import "./schema"`

- [ ] **Step 5: schema.ts を実装する**

```ts
// src/yjs/storage/schema.ts

/**
 * スキーマのマイグレーション定義。
 * 変更するときは既存の要素を書き換えず、末尾に ALTER TABLE を追記すること。
 * Durable Object の SQLite はインスタンスごとに独立した DB なので、
 * 各インスタンスが初回起動時に自分のペースでマイグレートする。
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE updates (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     kind INTEGER NOT NULL,
     data BLOB NOT NULL
   )`,
];

/**
 * 未適用のマイグレーションを適用する。すべて同期実行なので、
 * 呼び出し中に await を挟まなければ暗黙のトランザクションとして atomic に完了する。
 *
 * PRAGMA user_version は Durable Objects の SQLite では SQLITE_AUTH で拒否されるため、
 * 版番号は schema_version テーブルに保持する。
 */
export const migrate = (sql: SqlStorage): void => {
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  const current = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray().at(0);
  const applied = current?.version ?? 0;

  for (let i = applied; i < MIGRATIONS.length; i++) {
    sql.exec(MIGRATIONS[i]);
  }

  if (current === undefined) {
    sql.exec("INSERT INTO schema_version (version) VALUES (?)", MIGRATIONS.length);
  } else if (applied !== MIGRATIONS.length) {
    sql.exec("UPDATE schema_version SET version = ?", MIGRATIONS.length);
  }
};
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm exec vitest run src/yjs/storage/schema.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 7: 全体を検証してコミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add wrangler.toml src/yjs/storage/schema.ts src/yjs/storage/schema.test.ts
git commit -m "feat: switch to SQLite storage backend and add schema migration runner"
```

---

### Task 2: SQL 定義と YSqliteStorage の読み書き

`updates` テーブルへの読み書きを実装する。コンパクションは Task 3 で追加する。既存の KV 実装には触れないため、この時点では両方の実装が並存する。

**Files:**
- Create: `src/yjs/storage/queries.ts`
- Modify: `src/yjs/storage/type.ts`（`YStorage` と `UpdateKind` を追加。既存の `TransactionStorage` は Task 4 まで残す）
- Create: `src/yjs/storage/sqlite.ts`
- Test: `src/yjs/storage/sqlite.test.ts`

**Interfaces:**
- Consumes: `migrate(sql: SqlStorage): void`（Task 1）
- Produces:
  - `const UpdateKind: { readonly standalone: 0; readonly continuation: 1 }`
  - `interface YStorage { getUpdate(): Promise<Uint8Array | null>; storeUpdate(update: Uint8Array): Promise<void>; commit(): Promise<void>; destroy(): Promise<void>; }`
  - `type YSqliteStorageOptions = { maxRows?: number; maxChunkBytes?: number }`
  - `class YSqliteStorage implements YStorage`、コンストラクタは `(sql: SqlStorage, options?: YSqliteStorageOptions)`

- [ ] **Step 1: sqlite.test.ts に失敗するテストを書く**

```ts
// src/yjs/storage/sqlite.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { YSqliteStorage } from "./sqlite";

import type { YSqliteStorageOptions } from "./sqlite";

const withStorage = async (
  fn: (storage: YSqliteStorage) => Promise<void>,
  options?: YSqliteStorageOptions,
): Promise<void> => {
  const stub = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    await fn(new YSqliteStorage(state.storage.sql, options));
  });
};

const docWith = (text: string): Doc => {
  const doc = new Doc();
  doc.getText("root").insert(0, text);

  return doc;
};

const textOf = (update: Uint8Array): string => {
  const doc = new Doc();
  applyUpdate(doc, update);

  return doc.getText("root").toString();
};

describe("YSqliteStorage", () => {
  it("returns null when nothing has been stored", async () => {
    await withStorage(async (storage) => {
      expect(await storage.getUpdate()).toBeNull();
    });
  });

  it("round-trips a single update", async () => {
    await withStorage(async (storage) => {
      await storage.storeUpdate(encodeStateAsUpdate(docWith("Hello World!")));

      const update = await storage.getUpdate();

      expect(update).not.toBeNull();
      expect(textOf(update!)).toBe("Hello World!");
    });
  });

  it("applies stored updates in insertion order", async () => {
    await withStorage(async (storage) => {
      const doc = new Doc();
      const text = doc.getText("root");

      // 1000 件の更新を個別に保存する。キーの辞書順ではなく seq 順で
      // 復元されることを検証する（H-5 の回帰テスト）。
      const updates: Uint8Array[] = [];
      doc.on("update", (update: Uint8Array) => updates.push(update));
      for (let i = 0; i < 1000; i++) {
        text.insert(text.length, String(i % 10));
      }
      for (const update of updates) {
        await storage.storeUpdate(update);
      }

      const restored = await storage.getUpdate();

      expect(textOf(restored!)).toBe(text.toString());
    });
  });

  it("clears all rows on destroy", async () => {
    await withStorage(async (storage) => {
      await storage.storeUpdate(encodeStateAsUpdate(docWith("gone")));
      await storage.destroy();

      expect(await storage.getUpdate()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/yjs/storage/sqlite.test.ts`
Expected: FAIL — `Failed to resolve import "./sqlite"`

- [ ] **Step 3: queries.ts を作成する**

```ts
// src/yjs/storage/queries.ts

/**
 * SQL 文字列をこのファイルに隔離する。
 * 将来スキーマが複雑になり Kysely 等のクエリビルダを導入する場合も、
 * 変更はこのファイル内で完結する。
 */
export const SELECT_ALL_UPDATES = "SELECT kind, data FROM updates ORDER BY seq";
export const INSERT_UPDATE = "INSERT INTO updates (kind, data) VALUES (?, ?)";
export const DELETE_ALL_UPDATES = "DELETE FROM updates";
export const COUNT_UPDATES = "SELECT COUNT(*) AS count FROM updates";
```

- [ ] **Step 4: type.ts に YStorage と UpdateKind を追加する**

`src/yjs/storage/type.ts` の既存の `TransactionStorage` はそのまま残し、末尾に以下を追記する。

```ts
/**
 * updates テーブルの kind カラムの値。
 *
 * Yjs の update はバイト列として単純に分割・連結できないため、
 * コンパクション結果が BLOB 上限を超える場合はバイト断片に分割して保存する。
 * continuation は「直前の行から続く断片」であることを示す。
 */
export const UpdateKind = {
  standalone: 0,
  continuation: 1,
} as const;

export interface YStorage {
  /** 保存されているすべての update を 1 本にマージして返す。空なら null */
  getUpdate(): Promise<Uint8Array | null>;
  /** 増分 update を 1 行追加する。しきい値を超えたらコンパクションする */
  storeUpdate(update: Uint8Array): Promise<void>;
  /** 明示的にコンパクションする */
  commit(): Promise<void>;
  /** すべての update を削除する。テーブル定義とスキーマ版は維持する */
  destroy(): Promise<void>;
}
```

- [ ] **Step 5: sqlite.ts を実装する（コンパクションは Task 3 で追加）**

```ts
// src/yjs/storage/sqlite.ts
import { mergeUpdates } from "yjs";

import { COUNT_UPDATES, DELETE_ALL_UPDATES, INSERT_UPDATE, SELECT_ALL_UPDATES } from "./queries";
import { migrate } from "./schema";
import { UpdateKind } from "./type";

import type { YStorage } from "./type";

type UpdateRow = {
  kind: number;
  data: ArrayBuffer;
};

export type YSqliteStorageOptions = {
  /**
   * この行数を超えたらコンパクションする。
   * @default 2000
   */
  maxRows?: number;
  /**
   * コンパクション結果を分割する単位（バイト）。
   * SQLite の BLOB 上限 2MB に対する安全マージンを取る。
   * @default 1024 * 1024
   */
  maxChunkBytes?: number;
};

const DEFAULT_MAX_ROWS = 2000;
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
const SQLITE_BLOB_LIMIT = 2 * 1024 * 1024;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0];

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }

  return merged;
};

export class YSqliteStorage implements YStorage {
  readonly #sql: SqlStorage;
  readonly #maxRows: number;
  readonly #maxChunkBytes: number;
  #rowCount: number;

  constructor(sql: SqlStorage, options?: YSqliteStorageOptions) {
    this.#maxChunkBytes = options?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    if (this.#maxChunkBytes > SQLITE_BLOB_LIMIT) {
      // https://developers.cloudflare.com/durable-objects/platform/limits/
      throw new Error("maxChunkBytes must not exceed 2MB");
    }
    this.#maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;

    this.#sql = sql;
    migrate(sql);
    this.#rowCount = sql.exec<{ count: number }>(COUNT_UPDATES).one().count;
  }

  async getUpdate(): Promise<Uint8Array | null> {
    const updates = this.#readAll();
    if (updates.length === 0) return null;

    return mergeUpdates(updates);
  }

  async storeUpdate(update: Uint8Array): Promise<void> {
    this.#sql.exec(INSERT_UPDATE, UpdateKind.standalone, update);
    this.#rowCount += 1;
  }

  async commit(): Promise<void> {
    // Task 3 で実装する
  }

  async destroy(): Promise<void> {
    this.#sql.exec(DELETE_ALL_UPDATES);
    this.#rowCount = 0;
  }

  /**
   * 全行を読み、continuation の断片を連結して独立した update の配列に戻す。
   * BLOB は ArrayBuffer で返るため Uint8Array へ変換する。
   */
  #readAll(): Uint8Array[] {
    const rows = this.#sql.exec<UpdateRow>(SELECT_ALL_UPDATES).toArray();

    const updates: Uint8Array[] = [];
    let pending: Uint8Array[] = [];
    for (const row of rows) {
      const bytes = new Uint8Array(row.data);
      if (row.kind === UpdateKind.continuation && pending.length > 0) {
        pending.push(bytes);
        continue;
      }
      if (pending.length > 0) updates.push(concat(pending));
      pending = [bytes];
    }
    if (pending.length > 0) updates.push(concat(pending));

    return updates;
  }
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm exec vitest run src/yjs/storage/sqlite.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 7: 全体を検証してコミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add src/yjs/storage/queries.ts src/yjs/storage/type.ts src/yjs/storage/sqlite.ts src/yjs/storage/sqlite.test.ts
git commit -m "feat: add SQLite-backed Yjs storage with ordered update log"
```

---

### Task 3: コンパクションとチャンク分割

行数しきい値に到達したら全行を 1 本にマージして書き戻す。マージ結果が `maxChunkBytes` を超える場合はバイト断片に分割する。これで C-2（128KiB 制限）と C-3（delete 128 キー制限）が構造的に解消する。

**Files:**
- Modify: `src/yjs/storage/sqlite.ts`（`commit()` と `storeUpdate()`、`#split()` を追加）
- Test: `src/yjs/storage/sqlite.test.ts`（テストを追記）

**Interfaces:**
- Consumes: Task 2 の `YSqliteStorage`
- Produces: 変更なし（`commit()` の実装が入るのみ）

- [ ] **Step 1: 失敗するテストを追記する**

`src/yjs/storage/sqlite.test.ts` の `describe("YSqliteStorage", ...)` の中に以下を追記する。`countRows` ヘルパーはファイル冒頭のヘルパー群の隣に置く。

```ts
// ファイル冒頭のヘルパー群に追加
const withStorageAndSql = async (
  fn: (storage: YSqliteStorage, sql: SqlStorage) => Promise<void>,
  options?: YSqliteStorageOptions,
): Promise<void> => {
  const stub = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    await fn(new YSqliteStorage(state.storage.sql, options), state.storage.sql);
  });
};

const countRows = (sql: SqlStorage): number =>
  sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM updates").one().count;
```

```ts
// describe("YSqliteStorage", ...) の中に追加
it("compacts once the row threshold is exceeded", async () => {
  await withStorageAndSql(
    async (storage, sql) => {
      const doc = new Doc();
      const text = doc.getText("root");
      const updates: Uint8Array[] = [];
      doc.on("update", (update: Uint8Array) => updates.push(update));
      for (let i = 0; i < 50; i++) {
        text.insert(text.length, "x");
      }
      for (const update of updates) {
        await storage.storeUpdate(update);
      }

      // maxRows 10 に対し 50 件保存したので、行数は大幅に減っているはず
      expect(countRows(sql)).toBeLessThanOrEqual(10);

      const restored = await storage.getUpdate();
      expect(textOf(restored!)).toBe(text.toString());
    },
    { maxRows: 10 },
  );
});

it("splits a compacted update that exceeds maxChunkBytes and restores it", async () => {
  await withStorageAndSql(
    async (storage, sql) => {
      const doc = new Doc();
      const text = doc.getText("root");
      const updates: Uint8Array[] = [];
      doc.on("update", (update: Uint8Array) => updates.push(update));
      for (let i = 0; i < 20; i++) {
        text.insert(text.length, "abcdefghij".repeat(50));
      }
      for (const update of updates) {
        await storage.storeUpdate(update);
      }
      await storage.commit();

      // 512 バイトずつに分割されるので、複数行になっているはず
      expect(countRows(sql)).toBeGreaterThan(1);

      const restored = await storage.getUpdate();
      expect(textOf(restored!)).toBe(text.toString());
    },
    { maxRows: 1000, maxChunkBytes: 512 },
  );
});

it("stores a document larger than the legacy 128KiB key-value limit", async () => {
  await withStorage(async (storage) => {
    const doc = new Doc();
    // 300KB 相当。KV バックエンドでは 1 キーに収まらず保存に失敗していた（C-2）
    doc.getText("root").insert(0, "y".repeat(300 * 1024));
    await storage.storeUpdate(encodeStateAsUpdate(doc));
    await storage.commit();

    const restored = await storage.getUpdate();

    expect(textOf(restored!).length).toBe(300 * 1024);
  });
});

it("is a no-op when there is at most one row to compact", async () => {
  await withStorageAndSql(async (storage, sql) => {
    await storage.storeUpdate(encodeStateAsUpdate(docWith("single")));
    await storage.commit();

    expect(countRows(sql)).toBe(1);
    expect(textOf((await storage.getUpdate())!)).toBe("single");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/yjs/storage/sqlite.test.ts`
Expected: FAIL — 3 件が失敗する。`commit()` が未実装のため行数が減らず、`expect(countRows(sql)).toBeLessThanOrEqual(10)` などが失敗する。

- [ ] **Step 3: storeUpdate にしきい値判定を追加する**

`src/yjs/storage/sqlite.ts` の `storeUpdate` を置き換える。

```ts
  async storeUpdate(update: Uint8Array): Promise<void> {
    this.#sql.exec(INSERT_UPDATE, UpdateKind.standalone, update);
    this.#rowCount += 1;

    if (this.#rowCount > this.#maxRows) {
      await this.commit();
    }
  }
```

- [ ] **Step 4: commit と #split を実装する**

`src/yjs/storage/sqlite.ts` の `commit()` を置き換え、`#split()` を `#readAll()` の隣に追加する。

```ts
  async commit(): Promise<void> {
    if (this.#rowCount <= 1) return;

    const updates = this.#readAll();
    if (updates.length === 0) return;

    const chunks = this.#split(mergeUpdates(updates));

    // ここから下では await を挟まないこと。
    // 連続した同期書き込みが暗黙のトランザクションとして atomic に適用される。
    this.#sql.exec(DELETE_ALL_UPDATES);
    for (const [index, chunk] of chunks.entries()) {
      const kind = index === 0 ? UpdateKind.standalone : UpdateKind.continuation;
      this.#sql.exec(INSERT_UPDATE, kind, chunk);
    }
    this.#rowCount = chunks.length;
  }

  /**
   * マージ済みの update を maxChunkBytes 以下のバイト断片に分割する。
   * subarray ではなく slice を使ってコピーを作る。ビューをそのまま
   * バインドすると基底バッファ全体が書き込まれる可能性があるため。
   */
  #split(update: Uint8Array): Uint8Array[] {
    if (update.byteLength <= this.#maxChunkBytes) return [update];

    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < update.byteLength; offset += this.#maxChunkBytes) {
      chunks.push(update.slice(offset, Math.min(offset + this.#maxChunkBytes, update.byteLength)));
    }

    return chunks;
  }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm exec vitest run src/yjs/storage/sqlite.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 6: 全体を検証してコミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add src/yjs/storage/sqlite.ts src/yjs/storage/sqlite.test.ts
git commit -m "feat: compact update log with chunk splitting for large documents"
```

---

### Task 4: YDurableObjects を YSqliteStorage に載せ替え、KV 実装を削除

Durable Object 本体を新しいストレージに切り替え、KV バックエンド向けの実装をすべて削除する。起動時に Doc を 2 つ構築していた無駄も解消する。

**Files:**
- Modify: `src/yjs/index.ts:28-35`（`storage` フィールド）, `src/yjs/index.ts:39-46`（コンストラクタ）, `src/yjs/index.ts:48-50`（`onStart`）
- Modify: `src/yjs/storage/index.ts`（再エクスポートのみにする）
- Modify: `src/yjs/storage/type.ts`（`TransactionStorage` を削除）
- Modify: `src/yjs/internal.ts:2,7`
- Modify: `src/index.ts:40`
- Delete: `src/yjs/storage/storage-key/index.ts`, `src/yjs/storage/storage-key/storage-key.test.ts`, `src/yjs/storage/storage.test.ts`

**Interfaces:**
- Consumes: `YSqliteStorage`, `YStorage`（Task 2）
- Produces: `YDurableObjects.storage` の型が `YSqliteStorage` になる。`src/index.ts` が `YStorage` をエクスポートする（旧 `YTransactionStorage` は削除）

- [ ] **Step 1: 旧実装のテストを削除する**

```bash
git rm src/yjs/storage/storage.test.ts src/yjs/storage/storage-key/storage-key.test.ts src/yjs/storage/storage-key/index.ts
```

- [ ] **Step 2: storage/index.ts を再エクスポートだけにする**

`src/yjs/storage/index.ts` の内容を完全に置き換える。

```ts
export { YSqliteStorage } from "./sqlite";
export { UpdateKind } from "./type";

export type { YSqliteStorageOptions } from "./sqlite";
export type { YStorage } from "./type";
```

- [ ] **Step 3: type.ts から TransactionStorage を削除する**

`src/yjs/storage/type.ts` から `ListOptions` インターフェースと `TransactionStorage` インターフェースを削除し、Task 2 で追記した `UpdateKind` と `YStorage` のみを残す。

- [ ] **Step 4: YDurableObjects を新しいストレージに載せ替える**

`src/yjs/index.ts` の該当箇所を書き換える。`storage` はフィールド初期化子ではなくコンストラクタ本体で代入する。フィールド初期化子は `useDefineForClassFields` の下でパラメータプロパティ（`public state`）の代入より先に走るため、初期化子から `this.state` を参照すると `undefined` になる。

```ts
  protected app = createApp({
    createRoom: this.createRoom.bind(this),
  });
  protected doc = new WSSharedDoc();
  protected storage: YSqliteStorage;
  protected sessions = new Map<WebSocket, () => void>();
  private awarenessClients = new Set<number>();

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
      async ({ added, removed, updated }: AwarenessChanges) => {
        for (const client of [...added, ...updated]) {
          this.awarenessClients.add(client);
        }
        for (const client of removed) {
          this.awarenessClients.delete(client);
        }
      },
    );
  }
```

import 文も更新する。`encodeStateAsUpdate` は `getYDoc()` でまだ使うので残す。

```ts
import { applyUpdate, encodeStateAsUpdate } from "yjs";
// ...
import { YSqliteStorage } from "./storage";
```

- [ ] **Step 5: internal.ts と src/index.ts のエクスポートを更新する**

`src/yjs/internal.ts` の 2 行目と 7 行目:

```ts
import type { YSqliteStorage } from "./storage";
```

```ts
  storage: YSqliteStorage;
```

`src/index.ts:40` を置き換える:

```ts
export type { YStorage, YSqliteStorageOptions } from "./yjs/storage";
```

- [ ] **Step 6: 全テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS。`storage.test.ts` と `storage-key.test.ts` が消えた分テスト数は減る（41 → 34 前後）が、e2e テストは全件通る。

- [ ] **Step 7: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "refactor!: replace key-value storage layer with SQLite implementation"
```

---

### Task 5: WSSharedDoc に origin を通し、メッセージ型を拡張する

Yjs の transaction origin を WebSocket まで伝播させ、syncStep2 を要求元だけに返し（H-1）、送信者へのエコーバックを止める（H-2）。あわせて `queryAwareness` と `auth` を追加し、未知のメッセージ型を無言で捨てないようにする（H-7）。

**Files:**
- Modify: `src/yjs/message-type/index.ts`
- Modify: `src/yjs/remote/ws-shared-doc.ts`（全面改修）
- Modify: `src/yjs/index.ts:119-125`（`registerWebSocket`）, `src/yjs/index.ts:91-94`（`updateYDoc`）
- Modify: `src/yjs/remote/ws-shared-doc.test.ts`（`notify` / `update` の新シグネチャに追従）
- Modify: `src/yjs/message-type/messaeg-type.test.ts`（型が増えたことに追従）

**Interfaces:**
- Consumes: なし
- Produces:
  - `messageType: { sync: 0; awareness: 1; auth: 2; queryAwareness: 3 }`
  - `WSSharedDoc.notify(origin: object, listener: (message: Uint8Array) => void): () => void`
  - `WSSharedDoc.update(message: Uint8Array, origin: object): void`
  - `const RPC_ORIGIN: object`（`src/yjs/index.ts` 内で定義。WebSocket 由来でない更新の origin として使う）

- [ ] **Step 1: 失敗するテストを書く**

`src/yjs/remote/ws-shared-doc.test.ts` に以下を追記する。

```ts
it("sends the sync step 2 reply only to the requesting origin", () => {
  const doc = new WSSharedDoc();
  const requester = {};
  const bystander = {};
  const toRequester: Uint8Array[] = [];
  const toBystander: Uint8Array[] = [];
  doc.notify(requester, (message) => toRequester.push(message));
  doc.notify(bystander, (message) => toBystander.push(message));

  doc.getText("root").insert(0, "seed");
  toRequester.length = 0;
  toBystander.length = 0;

  const encoder = createEncoder();
  writeVarUint(encoder, messageType.sync);
  writeSyncStep1(encoder, new Doc());
  doc.update(toUint8Array(encoder), requester);

  expect(toRequester.length).toBe(1);
  expect(toBystander.length).toBe(0);
});

it("does not echo an update back to its origin", () => {
  const doc = new WSSharedDoc();
  const sender = {};
  const receiver = {};
  const toSender: Uint8Array[] = [];
  const toReceiver: Uint8Array[] = [];
  doc.notify(sender, (message) => toSender.push(message));
  doc.notify(receiver, (message) => toReceiver.push(message));

  const source = new Doc();
  source.getText("root").insert(0, "hello");
  const encoder = createEncoder();
  writeVarUint(encoder, messageType.sync);
  writeUpdate(encoder, encodeStateAsUpdate(source));
  doc.update(toUint8Array(encoder), sender);

  expect(toSender.length).toBe(0);
  expect(toReceiver.length).toBe(1);
});

it("throws on an unknown message type", () => {
  const doc = new WSSharedDoc();
  const encoder = createEncoder();
  writeVarUint(encoder, 99);

  expect(() => doc.update(toUint8Array(encoder), {})).toThrow();
});
```

必要な import を先頭に追加する。

```ts
import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding";
import { writeSyncStep1, writeUpdate } from "y-protocols/sync";
import { Doc, encodeStateAsUpdate } from "yjs";

import { messageType } from "../message-type";
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/yjs/remote/ws-shared-doc.test.ts`
Expected: FAIL — `notify` が 2 引数を受け取らず、型エラーまたは実行時エラーになる

- [ ] **Step 3: message-type/index.ts を拡張する**

```ts
import { createEncoder, writeVarUint } from "lib0/encoding";

export const messageType = {
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
} as const;

export const isMessageType = (
  type: string,
): type is keyof typeof messageType => {
  return Object.keys(messageType).includes(type);
};

export const createTypedEncoder = (type: keyof typeof messageType) => {
  if (!isMessageType(type)) {
    throw new Error(`Unsupported message type: ${type}`);
  }

  const encoder = createEncoder();
  writeVarUint(encoder, messageType[type]);

  return encoder;
};
```

- [ ] **Step 4: ws-shared-doc.ts を書き換える**

```ts
import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  length,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import { Doc } from "yjs";

import { createTypedEncoder, messageType } from "../message-type";

import type { AwarenessChanges, RemoteDoc } from ".";

type Listener = (message: Uint8Array) => void;
type Unsubscribe = () => void;

interface Notification extends RemoteDoc {
  notify(origin: object, listener: Listener): Unsubscribe;
}

export class WSSharedDoc extends Doc implements Notification {
  /** origin（通常は WebSocket）をキーにした配信先 */
  private listeners = new Map<object, Listener>();
  readonly awareness = new Awareness(this);

  constructor(gc = true) {
    super({ gc });
    this.awareness.setLocalState(null);

    // カーソルなどの付加情報の更新通知
    this.awareness.on("update", (changes: AwarenessChanges, origin: unknown) => {
      this.awarenessChangeHandler(changes, origin);
    });
    // yDoc の更新通知
    this.on("update", (update: Uint8Array, origin: unknown) => {
      this.syncMessageHandler(update, origin);
    });
  }

  update(message: Uint8Array, origin: object) {
    const encoder = createEncoder();
    const decoder = createDecoder(message);
    const type = readVarUint(decoder);

    switch (type) {
      case messageType.sync: {
        writeVarUint(encoder, messageType.sync);
        readSyncMessage(decoder, encoder, this, origin);

        // sync step 1 への応答は要求元にだけ返す
        if (length(encoder) > 1) {
          this.send(origin, toUint8Array(encoder));
        }
        break;
      }
      case messageType.awareness: {
        applyAwarenessUpdate(this.awareness, readVarUint8Array(decoder), origin);
        break;
      }
      case messageType.queryAwareness: {
        const states = this.awareness.getStates();
        if (states.size > 0) {
          const reply = createTypedEncoder("awareness");
          writeVarUint8Array(
            reply,
            encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
          );
          this.send(origin, toUint8Array(reply));
        }
        break;
      }
      case messageType.auth: {
        // auth はサーバからクライアントへの一方向のメッセージなので受信しても何もしない
        break;
      }
      default: {
        throw new Error(`Unsupported message type: ${type}`);
      }
    }
  }

  notify(origin: object, listener: Listener) {
    this.listeners.set(origin, listener);

    return () => {
      this.listeners.delete(origin);
    };
  }

  private syncMessageHandler(update: Uint8Array, origin: unknown) {
    const encoder = createTypedEncoder("sync");
    writeUpdate(encoder, update);

    this.broadcast(toUint8Array(encoder), origin);
  }

  private awarenessChangeHandler(
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) {
    const changed = [...added, ...updated, ...removed];
    const encoder = createTypedEncoder("awareness");
    const update = encodeAwarenessUpdate(
      this.awareness,
      changed,
      this.awareness.states,
    );
    writeVarUint8Array(encoder, update);

    this.broadcast(toUint8Array(encoder), origin);
  }

  private send(origin: object, message: Uint8Array) {
    this.listeners.get(origin)?.(message);
  }

  private broadcast(message: Uint8Array, exclude: unknown) {
    for (const [origin, listener] of this.listeners) {
      if (origin === exclude) continue;
      listener(message);
    }
  }
}
```

- [ ] **Step 5: 呼び出し側を新シグネチャに合わせる**

`src/yjs/index.ts` のファイル先頭付近（import の直後）に定数を追加する。

```ts
/** WebSocket 由来でない更新（JS RPC 経由）の origin */
const RPC_ORIGIN: object = Object.freeze({ source: "rpc" });
```

`registerWebSocket` を書き換える。

```ts
  protected registerWebSocket(ws: WebSocket) {
    setupWSConnection(ws, this.doc);
    const s = this.doc.notify(ws, (message) => {
      ws.send(message);
    });
    this.sessions.set(ws, s);
  }
```

`updateYDoc` と `webSocketMessage` を書き換える。

```ts
  async updateYDoc(update: Uint8Array): Promise<void> {
    this.doc.update(update, RPC_ORIGIN);
    await this.cleanup();
  }
```

```ts
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    this.doc.update(new Uint8Array(message), ws);
    await this.cleanup();
  }
```

- [ ] **Step 6: message-type のテストを更新する**

`src/yjs/message-type/messaeg-type.test.ts` に `auth` と `queryAwareness` のケースを追加し、既存のアサーションが新しいキー集合と矛盾しないよう修正する。

- [ ] **Step 7: テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 8: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "fix!: route sync replies to the requester and stop echoing to the sender"
```

---

### Task 6: SessionRegistry で awareness の所有権を追跡する

接続ごとの awareness clientID を `serializeAttachment` に永続化し、切断時にその接続の clientID だけを削除する（C-4）。hibernation を跨いでも所有権が保たれる。

**Files:**
- Create: `src/yjs/session/index.ts`
- Test: `src/yjs/session/session.test.ts`
- Modify: `src/yjs/index.ts`（`sessions` を `SessionRegistry` に置換、`awarenessClients` を削除、`createRoom` / `onStart` / `registerWebSocket` / `unregisterWebSocket` / `cleanup`）
- Modify: `src/yjs/internal.ts`

**Interfaces:**
- Consumes: `WSSharedDoc.notify(origin, listener)`（Task 5）
- Produces:
  - `type SessionAttachment = { roomId: string; connectedAt: number; clientIds: number[] }`
  - `class SessionRegistry` — `size: number`, `add(ws, dispose)`, `remove(ws)`, `has(ws)`, `sockets(): IterableIterator<WebSocket>`, `clientIdsOf(ws): number[]`, `track(ws, clientIds)`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/yjs/session/session.test.ts
import { describe, expect, it, vi } from "vitest";

import { SessionRegistry } from ".";

import type { SessionAttachment } from ".";

const fakeSocket = (attachment: SessionAttachment | null): WebSocket => {
  let current = attachment;

  return {
    serializeAttachment: (value: SessionAttachment) => {
      current = value;
    },
    deserializeAttachment: () => current,
  } as unknown as WebSocket;
};

const attachment = (clientIds: number[]): SessionAttachment => ({
  roomId: "room1",
  connectedAt: 0,
  clientIds,
});

describe("SessionRegistry", () => {
  it("tracks and disposes sockets", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([]));
    const dispose = vi.fn();

    registry.add(ws, dispose);
    expect(registry.size).toBe(1);
    expect(registry.has(ws)).toBe(true);

    registry.remove(ws);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("records client ids on the attachment", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([]));
    registry.add(ws, () => {});

    registry.track(ws, [7]);

    expect(registry.clientIdsOf(ws)).toEqual([7]);
  });

  it("does not duplicate client ids", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([7]));
    registry.add(ws, () => {});

    registry.track(ws, [7, 8]);
    registry.track(ws, [8]);

    expect(registry.clientIdsOf(ws).sort()).toEqual([7, 8]);
  });

  it("restores ownership from an existing attachment after hibernation", () => {
    // hibernation 復帰を模す。registry は空だが WebSocket の attachment は残っている
    const ws = fakeSocket(attachment([42]));
    const registry = new SessionRegistry();
    registry.add(ws, () => {});

    expect(registry.clientIdsOf(ws)).toEqual([42]);
  });

  it("returns an empty list for a socket without a valid attachment", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(null);
    registry.add(ws, () => {});

    expect(registry.clientIdsOf(ws)).toEqual([]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/yjs/session/session.test.ts`
Expected: FAIL — `Failed to resolve import "."`

- [ ] **Step 3: SessionRegistry を実装する**

```ts
// src/yjs/session/index.ts

export type SessionAttachment = {
  roomId: string;
  /** epoch ミリ秒。attachment は structured clone されるが、数値の方が扱いが単純 */
  connectedAt: number;
  /** この接続が所有する awareness の clientID */
  clientIds: number[];
};

const isSessionAttachment = (value: unknown): value is SessionAttachment => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.roomId === "string" &&
    typeof candidate.connectedAt === "number" &&
    Array.isArray(candidate.clientIds) &&
    candidate.clientIds.every((id) => typeof id === "number")
  );
};

/**
 * WebSocket と awareness の所有権を管理する。
 *
 * 所有権は WebSocket の attachment に永続化するため、Durable Object が
 * hibernation から復帰してメモリ上の状態を失っても復元できる。
 */
export class SessionRegistry {
  private disposers = new Map<WebSocket, () => void>();

  get size(): number {
    return this.disposers.size;
  }

  add(ws: WebSocket, dispose: () => void): void {
    this.disposers.set(ws, dispose);
  }

  remove(ws: WebSocket): void {
    this.disposers.get(ws)?.();
    this.disposers.delete(ws);
  }

  has(ws: WebSocket): boolean {
    return this.disposers.has(ws);
  }

  sockets(): IterableIterator<WebSocket> {
    return this.disposers.keys();
  }

  clientIdsOf(ws: WebSocket): number[] {
    return this.attachmentOf(ws)?.clientIds ?? [];
  }

  /**
   * この接続が所有する clientID を記録する。
   * 実際に増えたときだけ attachment を書き直すので、通常は接続あたり 1 回で済む。
   */
  track(ws: WebSocket, clientIds: readonly number[]): void {
    const current = this.attachmentOf(ws);
    if (current === null) return;

    const merged = new Set([...current.clientIds, ...clientIds]);
    if (merged.size === current.clientIds.length) return;

    ws.serializeAttachment({
      ...current,
      clientIds: Array.from(merged),
    } satisfies SessionAttachment);
  }

  private attachmentOf(ws: WebSocket): SessionAttachment | null {
    const raw: unknown = ws.deserializeAttachment();

    return isSessionAttachment(raw) ? raw : null;
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run src/yjs/session/session.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: YDurableObjects を SessionRegistry に置き換える**

`src/yjs/index.ts` を以下のように変更する。`WebSocketAttachment` 型のエクスポートは `SessionAttachment` に置き換える。

```ts
// フィールド
  protected sessions = new SessionRegistry();
  // private awarenessClients = new Set<number>();  ← 削除

// onStart の awareness ハンドラを置き換える
    this.doc.awareness.on("update", ({ added, updated }: AwarenessChanges, origin: unknown) => {
      if (origin instanceof WebSocket) {
        this.sessions.track(origin, [...added, ...updated]);
      }
    });

// createRoom
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

// registerWebSocket
  protected registerWebSocket(ws: WebSocket) {
    setupWSConnection(ws, this.doc);
    const dispose = this.doc.notify(ws, (message) => {
      ws.send(message);
    });
    this.sessions.add(ws, dispose);
  }

// unregisterWebSocket
  protected async unregisterWebSocket(ws: WebSocket) {
    try {
      // この接続が所有する clientID だけを削除する。
      // 部屋全体の clientID を削除すると他の参加者の presence まで消える。
      removeAwarenessStates(this.doc.awareness, this.sessions.clientIdsOf(ws), null);
      this.sessions.remove(ws);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

// cleanup
  protected async cleanup() {
    if (this.sessions.size < 1) {
      await this.storage.commit();
    }
  }
```

import を追加する。

```ts
import { SessionRegistry } from "./session";

import type { SessionAttachment } from "./session";
```

`export type WebSocketAttachment = { ... }` を削除し、代わりに再エクスポートする。

```ts
export type { SessionAttachment } from "./session";
```

- [ ] **Step 6: internal.ts を更新する**

```ts
import type { SessionRegistry } from "./session";
```

```ts
  sessions: SessionRegistry;
  // awarenessClients: Set<number>;  ← 削除
```

- [ ] **Step 7: e2e テストの awareness 回帰テストを追加する**

`src/e2e/y-durableobjects.test.ts` に追記する。

```ts
it("keeps other clients' awareness when one connection closes", async () => {
  const id = env.Y_DURABLE_OBJECTS.newUniqueId();
  const stub = env.Y_DURABLE_OBJECTS.get(id);

  await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
    await instance.createRoom("room1");
    await instance.createRoom("room1");
    const [first, second] = Array.from(instance.sessions.sockets());

    instance.sessions.track(first, [1]);
    instance.sessions.track(second, [2]);
    instance.doc.awareness.setLocalStateField("user", { name: "a" });

    await instance.webSocketClose(first);

    // first の clientId だけが除去され、second の所有分は残る
    expect(instance.sessions.clientIdsOf(second)).toEqual([2]);
    expect(instance.sessions.size).toBe(1);
  });
});
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS。既存の `instance.sessions.size` を参照するテストは `SessionRegistry.size` でそのまま動く。`Array.from(instance.sessions.entries())` を使っている既存テスト（`y-durableobjects.test.ts:95,110`）は `Array.from(instance.sessions.sockets())` に書き換える。

- [ ] **Step 9: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "fix!: scope awareness removal to the disconnecting connection"
```

---

### Task 7: 永続化を直列化し、失敗時に安全側へ倒す

宙に浮いていた永続化 Promise を直列化し（C-5）、失敗時は全接続を閉じてメモリ状態を破棄する。あわせて不正メッセージの例外境界を設ける（H-4）。

**Files:**
- Modify: `src/yjs/index.ts`（`onStart` の update ハンドラ、`webSocketMessage`、`updateYDoc`、新規プライベートメソッド 2 つ）
- Test: `src/e2e/y-durableobjects.test.ts`（追記）

**Interfaces:**
- Consumes: `YSqliteStorage.storeUpdate`（Task 2）、`WSSharedDoc.update(message, origin)`（Task 5）
- Produces: なし（内部実装の変更のみ）

- [ ] **Step 1: 失敗するテストを書く**

`src/e2e/y-durableobjects.test.ts` に追記する。

```ts
it("closes only the offending connection on a malformed message", async () => {
  const id = env.Y_DURABLE_OBJECTS.newUniqueId();
  const stub = env.Y_DURABLE_OBJECTS.get(id);

  await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
    await instance.createRoom("room1");
    await instance.createRoom("room1");
    const [first] = Array.from(instance.sessions.sockets());

    // 未知のメッセージ型。例外が外に漏れると DO 全体がリセットされる
    const malformed = new Uint8Array([99]).buffer;
    await expect(instance.webSocketMessage(first, malformed)).resolves.toBeUndefined();

    // DO は生存し、他の接続も維持されている
    expect(instance.sessions.size).toBe(2);
  });
});

it("persists an update before webSocketMessage resolves", async () => {
  const id = env.Y_DURABLE_OBJECTS.newUniqueId();
  const stub = env.Y_DURABLE_OBJECTS.get(id);

  await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
    const client = await instance.createRoom("room1");
    const message = createSyncMessage(createYDocMessage("persisted"));

    await instance.webSocketMessage(client, message.slice(0).buffer);

    // ストレージから読み直しても内容が入っている
    const stored = await instance.storage.getUpdate();
    expect(stored).not.toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/e2e/y-durableobjects.test.ts`
Expected: FAIL — 未知のメッセージ型で `webSocketMessage` が reject する

- [ ] **Step 3: 永続化キューと失敗ハンドラを実装する**

`src/yjs/index.ts` にフィールドとプライベートメソッドを追加する。

```ts
  /** 永続化を直列化するためのキュー。Yjs の update イベントは同期的に発火するため必要 */
  private persist: Promise<void> = Promise.resolve();
```

```ts
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
```

- [ ] **Step 4: onStart の update ハンドラを差し替える**

```ts
    this.doc.on("update", (update: Uint8Array) => {
      this.schedulePersist(update);
    });
```

- [ ] **Step 5: webSocketMessage に例外境界を設け、永続化を待つ**

```ts
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
```

`updateYDoc` も同様に永続化を待つ。

```ts
  async updateYDoc(update: Uint8Array): Promise<void> {
    this.doc.update(update, RPC_ORIGIN);
    await this.persist;
    await this.cleanup();
  }
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 7: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "fix!: serialize persistence and fail closed when storage writes fail"
```

---

### Task 8: hibernation の衛生と KV バックエンドの検出、destroy API

ping/pong を自動応答にして hibernation 中の起床を防ぎ、KV バックエンドで起動された場合は移行手順を示して即座に失敗させ、部屋の削除 API を追加する。

**Files:**
- Modify: `src/yjs/index.ts`（コンストラクタ、`destroy()` の追加）
- Modify: `src/yjs/internal.ts`
- Test: `src/e2e/y-durableobjects.test.ts`（追記）

**Interfaces:**
- Consumes: `YSqliteStorage.destroy()`（Task 2）
- Produces: `YDurableObjects.destroy(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
it("configures a ping/pong auto response", async () => {
  const id = env.Y_DURABLE_OBJECTS.newUniqueId();
  const stub = env.Y_DURABLE_OBJECTS.get(id);

  await runInDurableObject(stub, async (_instance, state) => {
    const pair = state.getWebSocketAutoResponse();

    expect(pair?.request).toBe("ping");
    expect(pair?.response).toBe("pong");
  });
});

it("clears the document and closes connections on destroy", async () => {
  const id = env.Y_DURABLE_OBJECTS.newUniqueId();
  const stub = env.Y_DURABLE_OBJECTS.get(id);

  await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
    await instance.createRoom("room1");
    await instance.updateYDoc(createSyncMessage(createYDocMessage("bye")).slice(0));

    await instance.destroy();

    expect(await instance.storage.getUpdate()).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/e2e/y-durableobjects.test.ts`
Expected: FAIL — auto response が未設定、`destroy` が未定義

- [ ] **Step 3: コンストラクタに SQLite 検出と auto response を追加する**

`src/yjs/index.ts` のコンストラクタを書き換える。定数はファイル先頭に置く。

```ts
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
```

```ts
  constructor(
    public state: DurableObjectState,
    public env: T["Bindings"],
  ) {
    super(state, env);

    assertSqliteBackend(state.storage);
    this.storage = new YSqliteStorage(state.storage.sql);

    // ping を自動応答にすることで、keepalive で Durable Object を
    // 起こさずに済む。duration 課金に最も効く設定。
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    void this.state.blockConcurrencyWhile(this.onStart.bind(this));
  }
```

- [ ] **Step 4: destroy を実装する**

`getYDoc` / `updateYDoc` の隣に追加する。

```ts
  /** 部屋のデータを削除し、すべての接続を閉じる */
  async destroy(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      ws.close(1001, "room destroyed");
    }
    await this.storage.destroy();
  }
```

`src/yjs/internal.ts` の public api セクションに追記する。

```ts
  destroy(): Promise<void>;
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "feat!: add hibernation auto-response, SQLite backend assertion, and destroy API"
```

---

### Task 9: 公開 API を整える

`updateYDoc` が生の Yjs update を受け取るようにして `getYDoc()` との往復を成立させ（H-3）、`yRoute` を `getByName` に切り替える。

**Files:**
- Modify: `src/yjs/index.ts`（`updateYDoc`）
- Modify: `src/index.ts:16`（`idFromName` → `getByName`）
- Modify: `src/e2e/index.ts:25-26,45-46,55-56`（同上）
- Test: `src/e2e/y-durableobjects.test.ts`（`updateYDoc` のテストを書き換え）

**Interfaces:**
- Consumes: なし
- Produces: `YDurableObjects.updateYDoc(update: Uint8Array): Promise<void>` が **生の Yjs update** を受け取る（v1 はプロトコル framing 済みメッセージを要求していた）

- [ ] **Step 1: 往復テストを書く**

`src/e2e/y-durableobjects.test.ts` の `"updates YDoc correctly"` を以下に置き換える。

```ts
it("round-trips between getYDoc and updateYDoc", async () => {
  const source = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());
  const target = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());

  const message = createYDocMessage("Hello World!");
  await runInDurableObject(source, async (instance: InternalYDurableObject) => {
    await instance.updateYDoc(message.slice(0));
  });

  const exported = await runInDurableObject(
    source,
    (instance: InternalYDurableObject) => instance.getYDoc(),
  );
  await runInDurableObject(target, async (instance: InternalYDurableObject) => {
    // getYDoc の出力をそのまま updateYDoc に渡せる
    await instance.updateYDoc(exported);
  });

  const copied = await runInDurableObject(
    target,
    (instance: InternalYDurableObject) => instance.getYDoc(),
  );

  const doc = new Doc();
  applyUpdate(doc, copied);
  expect(doc.getText("root").toString()).toBe("Hello World!");
});
```

ファイル先頭に import を追加する。

```ts
import { Doc, applyUpdate } from "yjs";
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run src/e2e/y-durableobjects.test.ts -t "round-trips"`
Expected: FAIL — `updateYDoc` が生の update をプロトコルメッセージとして解釈しようとして失敗する

- [ ] **Step 3: updateYDoc を生の update を受け取るように変更する**

```ts
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
```

- [ ] **Step 4: 他のテストの updateYDoc 呼び出しを修正する**

`createSyncMessage` でラップして `updateYDoc` に渡している箇所（Task 7・Task 8 で追加したテストを含む）を、生の update を渡すように修正する。`webSocketMessage` に渡す箇所は引き続き `createSyncMessage` が必要である。

- [ ] **Step 5: getByName に切り替える**

`src/index.ts:15-16` を置き換える。

```ts
    const obj = selector(c.env as E["Bindings"]);
    const stub = obj.getByName(c.req.param("id"));
```

`src/e2e/index.ts` の 3 箇所（`:25-26`, `:45-46`, `:55-56`）も同様に `const stub = c.env.Y_DURABLE_OBJECTS.getByName(roomId);` に置き換える。

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm typecheck && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 7: コミットする**

```bash
pnpm fmt && pnpm typecheck && pnpm exec vitest run
git add -A src/
git commit -m "fix!: make updateYDoc accept a raw Yjs update so it round-trips with getYDoc"
```

---

### Task 10: ドキュメントとリリース準備

README を SQLite 前提に更新し、移行手順を掲載し、changeset を追加する。

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`（アーキテクチャ節のストレージ記述）
- Create: `.changeset/sqlite-migration.md`

**Interfaces:**
- Consumes: Task 1〜9 のすべて
- Produces: なし

- [ ] **Step 1: README の wrangler 設定を更新する**

`README.md` の "Configuration for Durable Objects" 節の TOML を置き換える。

```toml
name = "your-worker-name"
main = "src/index.ts"
compatibility_date = "2025-04-01"

account_id = "your-account-id"
workers_dev = true

# Durable Objects binding
[durable_objects]
bindings = [
  { name = "Y_DURABLE_OBJECTS", class_name = "YDurableObjects" }
]

# Durable Objects migrations
# v2 requires the SQLite storage backend.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["YDurableObjects"]
```

- [ ] **Step 2: README に移行手順の節を追加する**

`## Usage` の直前に以下を挿入する。アンカーは `assertSqliteBackend` が案内する URL と一致させること（`#migrating-from-v1-key-value-backend`）。

```markdown
## Migrating from v1 (key-value backend)

v2 requires the SQLite storage backend. A Durable Object namespace's storage
type is immutable, so an existing v1 namespace cannot be converted in place —
Cloudflare rejects it with `storage_type_mismatch`.

Run both versions side by side and copy each room across:

1. Keep your existing v1 binding (for example `Y_LEGACY`) pinned to
   `y-durableobjects@1`.
2. Add a new binding backed by v2 with `new_sqlite_classes`.
3. Copy each room over. `getYDoc()` returns a raw Yjs update and v2's
   `updateYDoc()` accepts one, so a single round trip is enough:

```typescript
app.post("/migrate/:id", async (c) => {
  const id = c.req.param("id");
  const legacy = c.env.Y_LEGACY.getByName(id);
  const next = c.env.Y_DURABLE_OBJECTS.getByName(id);

  await next.updateYDoc(await legacy.getYDoc());

  return c.json({ ok: true });
});
```

4. Once every room is copied, remove the v1 binding.

### Document size

Durable Objects give each instance 10GB of SQLite storage, but the whole
document must fit in the instance's 128MB of memory. That memory limit — not
storage — is the practical ceiling on document size.

### Keepalive and hibernation

v2 registers a `"ping"` / `"pong"` auto-response. If your client sends `"ping"`
as a keepalive, the Durable Object answers without waking from hibernation,
which is the single biggest lever on duration billing.
```

- [ ] **Step 3: README の updateYDoc の例を修正する**

`#### updateYDoc` 節の説明に、生の Yjs update を渡すことを明記する。既存のサンプルはリクエストボディをそのまま渡しているため、v2 の挙動と一致するようになる。以下の一文を追加する。

```markdown
`updateYDoc` takes a raw Yjs update — the same format `getYDoc` returns and
`Y.encodeStateAsUpdate(doc)` produces. It is not a sync-protocol message.
```

- [ ] **Step 4: CLAUDE.md のアーキテクチャ記述を更新する**

`3. **YTransactionStorage** (`src/yjs/storage/index.ts`)` の項目を置き換える。

```markdown
3. **YSqliteStorage** (`src/yjs/storage/sqlite.ts`)

   - Persistence layer backed by the Durable Objects SQLite storage backend
   - Single `updates` table; snapshots and incremental updates are not distinguished
   - Compacts with `Y.mergeUpdates` on a row-count threshold, splitting the
     result into chunks when it exceeds the SQLite BLOB limit
   - `PRAGMA` is unavailable on Durable Objects SQLite; schema versioning uses a
     `schema_version` table (`src/yjs/storage/schema.ts`)
```

同ファイルの `Development Constraints` に以下を追記する。

```markdown
4. **SQLite Storage Backend**

   - Requires `new_sqlite_classes` in wrangler migrations
   - BLOB columns are returned as `ArrayBuffer`; convert with `new Uint8Array(value)`
   - Consecutive synchronous `sql.exec` calls with no intervening `await` form an
     implicit transaction — do not await inside a compaction
```

- [ ] **Step 5: changeset を追加する**

```markdown
<!-- .changeset/sqlite-migration.md -->
---
"y-durableobjects": major
---

Migrate to the Durable Objects SQLite storage backend and fix the defects the
key-value backend had forced.

**Breaking changes**

- Requires `new_sqlite_classes` in your wrangler migrations. A v1 namespace
  cannot be converted in place — see "Migrating from v1" in the README.
- `updateYDoc()` now takes a raw Yjs update instead of a sync-protocol message,
  so it round-trips with `getYDoc()`.
- The exported `YTransactionStorage` type is replaced by `YStorage`.
- `WSSharedDoc.notify(listener)` is now `notify(origin, listener)` and
  `WSSharedDoc.update(message)` is now `update(message, origin)`.
- `WebSocketAttachment` is replaced by `SessionAttachment`, which carries the
  connection's awareness client ids.

**Fixes**

- Documents are no longer capped at 128KiB.
- Compaction no longer exceeds the 128-key limit of `delete()`.
- Closing one connection no longer clears every participant's awareness state.
- Updates are persisted in order and awaited rather than left as floating promises.
- Sync step 2 replies go only to the requesting client instead of the whole room.
- Updates are no longer echoed back to their sender.
- A malformed binary message closes only that connection instead of resetting
  the Durable Object.
- Stored updates are restored in insertion order.

**Additions**

- `destroy()` deletes a room's data and closes its connections.
- A `"ping"` / `"pong"` auto-response keeps keepalives from waking the Durable
  Object from hibernation.
```

- [ ] **Step 6: 最終確認とコミット**

```bash
pnpm fmt && pnpm typecheck && pnpm lint && pnpm exec vitest run && pnpm build
git add -A
git commit -m "docs: document the SQLite migration and add the v2 changeset"
```

---

## Self-Review

**Spec coverage:**

| Spec の要求 | 対応タスク |
| --- | --- |
| C-1 SQLite バックエンドへの移行 | Task 1, 4 |
| C-2 128KiB 制限の解消 | Task 3（300KB ドキュメントのテスト） |
| C-3 delete 128 キー制限の解消 | Task 3（`DELETE FROM updates` 1 文） |
| C-4 awareness の所有権 | Task 6 |
| C-5 永続化の直列化 | Task 7 |
| H-1 syncStep2 を要求元にのみ | Task 5 |
| H-2 エコーバックの停止 | Task 5 |
| H-3 `updateYDoc` の往復 | Task 9 |
| H-4 例外境界 | Task 7 |
| H-5 更新順序 | Task 2（1000 件の順序テスト） |
| H-7 メッセージ型の拡張 | Task 5 |
| `schema_version` マイグレーション | Task 1 |
| チャンク分割 | Task 3 |
| `maxRows` / `maxChunkBytes` | Task 2, 3 |
| hibernation 衛生 | Task 8 |
| KV バックエンド検出 | Task 8 |
| `destroy()` | Task 8 |
| `getByName` | Task 9 |
| 移行レシピの文書化 | Task 10 |
| 公開型の変更 | Task 4（`YStorage`）、Task 5（`WSSharedDoc`）、Task 6（`SessionAttachment`） |

すべての spec 要求にタスクが対応している。

**型の整合性:**

- `YStorage` は Task 2 で定義し、Task 4 でエクスポートする。メソッド名は全タスクで `getUpdate` / `storeUpdate` / `commit` / `destroy` に統一されている。
- `SessionRegistry` のメソッド名は Task 6 の定義（`add` / `remove` / `has` / `sockets` / `clientIdsOf` / `track` / `size`）で、Task 7・8 のテストからも同じ名前で参照している。
- `UpdateKind.standalone` / `UpdateKind.continuation` は Task 2 で定義し Task 3 で使用。
- `RPC_ORIGIN` は Task 5 で定義し Task 9 で再利用。
- `WSSharedDoc.notify(origin, listener)` の 2 引数シグネチャは Task 5 で導入し、Task 6 の `registerWebSocket` でも同じ順序で呼んでいる。

**残る不確実性:**

`assertSqliteBackend` が KV バックエンドを実際に検出できるかは、KV バックエンドの Durable Object を用意できないため自動テストでは検証できない。Task 8 では SQLite バックエンド上で例外を投げないことのみを確認する。KV バックエンド上での挙動は、v2 リリース前に手動で 1 度確認することが望ましい。
