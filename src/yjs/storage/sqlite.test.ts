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
