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
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .toArray()
        .map((row) => row.name);

      expect(tables).toContain("updates");
      expect(tables).toContain("schema_version");
    });
  });

  it("records the schema version", async () => {
    await withSql((sql) => {
      migrate(sql);

      const row = sql
        .exec<{ version: number }>("SELECT version FROM schema_version")
        .one();

      expect(row.version).toBe(1);
    });
  });

  it("is idempotent and preserves existing rows", async () => {
    await withSql((sql) => {
      migrate(sql);
      sql.exec(
        "INSERT INTO updates (kind, data) VALUES (?, ?)",
        0,
        new Uint8Array([1, 2, 3]),
      );

      migrate(sql);

      const count = sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM updates")
        .one();
      const version = sql
        .exec<{ version: number }>("SELECT version FROM schema_version")
        .one();

      expect(count.count).toBe(1);
      expect(version.version).toBe(1);
    });
  });
});
