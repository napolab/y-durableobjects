import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate, mergeUpdates } from "yjs";

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
  sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM updates").one()
    .count;

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

  it("round-trips a large number of individually stored updates", async () => {
    await withStorage(async (storage) => {
      const doc = new Doc();
      const text = doc.getText("root");

      // 1000 件の更新を個別に保存し、まとめて復元しても元のドキュメントと
      // 一致することを検証する（大量行のバルクラウンドトリップ）。
      // 注意: Y.mergeUpdates は因果的に依存する struct を並べ替えて解決する
      // ため、この結果だけでは seq 順に復元されていることは証明されない。
      // ORDER BY seq を外しても本テストは通ってしまう。順序に依存する
      // 検証（バイト断片の再構成）は Task 3 で追加する。
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

        // This is the ordering regression test for the compaction/chunk-split
        // path. Byte-fragment reassembly is the one place in this library
        // where ordering is genuinely load-bearing: concatenating chunks out
        // of `seq` order produces garbage bytes that no amount of CRDT
        // convergence in Y.mergeUpdates repairs. Asserting on the restored
        // *text* only proves the document round-trips (mergeUpdates could
        // in principle mask a reordering that a stricter comparison would
        // catch), so we additionally capture the merged bytes before
        // compaction and require getUpdate() to reproduce them exactly.
        const expectedBytes = mergeUpdates(updates);

        await storage.commit();

        // 512 バイトずつに分割されるので、複数行になっているはず
        expect(countRows(sql)).toBeGreaterThan(1);

        const restored = await storage.getUpdate();
        expect(textOf(restored!)).toBe(text.toString());
        expect(restored!).toEqual(expectedBytes);
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

  it("splits a single update larger than maxChunkBytes without needing commit()", async () => {
    await withStorageAndSql(
      async (storage, sql) => {
        const doc = new Doc();
        doc.getText("root").insert(0, "z".repeat(5000));
        const update = encodeStateAsUpdate(doc);
        expect(update.byteLength).toBeGreaterThan(200);

        // storeUpdate() alone, with no commit() call, must split an
        // oversized update into multiple rows. A bare INSERT of the whole
        // update would eventually exceed Cloudflare's 2MB SQLite BLOB limit
        // and throw inside storeUpdate(), wedging the room forever (every
        // reconnect resends the same oversized update and hits the same
        // error). This uses a small maxChunkBytes instead of an actual >2MB
        // payload so the test stays fast, but exercises the same code path.
        await storage.storeUpdate(update);

        expect(countRows(sql)).toBeGreaterThan(1);

        const restored = await storage.getUpdate();
        expect(textOf(restored!)).toBe("z".repeat(5000));
      },
      { maxChunkBytes: 200, maxRows: 1000 },
    );
  });

  it("does not recompact on every storeUpdate once maxRows is below the data's minimum chunk count", async () => {
    await withStorageAndSql(
      async (storage, sql) => {
        let commitCalls = 0;
        const originalCommit = storage.commit.bind(storage);
        storage.commit = async () => {
          commitCalls += 1;
          await originalCommit();
        };

        const doc = new Doc();
        const text = doc.getText("root");
        const updates: Uint8Array[] = [];
        doc.on("update", (update: Uint8Array) => updates.push(update));
        // Each individual insert's update must stay under maxChunkBytes on
        // its own (so a single storeUpdate() call never needs to split by
        // itself) -- only the *cumulative* merged document, once compacted,
        // should need more than maxRows chunks.
        for (let i = 0; i < 30; i++) {
          text.insert(text.length, "ab");
        }

        for (const update of updates) {
          expect(update.byteLength).toBeLessThan(300);
          await storage.storeUpdate(update);
        }

        // maxRows (1) is far below the number of rows the merged content
        // actually needs at maxChunkBytes (300), so compaction can never
        // bring the row count back under maxRows. Without flooring the
        // threshold at (roughly) the row count the last compaction actually
        // produced, every single storeUpdate() call after the first
        // compaction re-triggers a full commit() (confirmed empirically:
        // 29 of 30 calls recompact without the floor). The floor at least
        // halves that (observed: 15 of 30) by skipping compaction until the
        // row count has grown past what the last compaction produced, not
        // just past the configured maxRows.
        expect(commitCalls).toBeGreaterThan(0);
        expect(commitCalls).toBeLessThan(updates.length * 0.7);

        const restored = await storage.getUpdate();
        expect(textOf(restored!)).toBe(text.toString());
      },
      { maxRows: 1, maxChunkBytes: 300 },
    );
  });

  it("throws when a continuation row has no preceding row to attach to", async () => {
    const stub = env.Y_DURABLE_OBJECTS.get(env.Y_DURABLE_OBJECTS.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new YSqliteStorage(state.storage.sql);

      // 破損した状態を直接作る: 先行する standalone 行なしに continuation
      // (kind = 1) 行だけを挿入する。
      state.storage.sql.exec(
        "INSERT INTO updates (kind, data) VALUES (1, ?)",
        new Uint8Array([1, 2, 3]),
      );

      await expect(storage.getUpdate()).rejects.toThrow(
        /orphaned continuation row at seq=\d+/,
      );
    });
  });
});
