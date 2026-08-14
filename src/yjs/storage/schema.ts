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
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );

  const current = sql
    .exec<{ version: number }>("SELECT version FROM schema_version")
    .toArray()
    .at(0);
  const applied = current?.version ?? 0;

  for (let i = applied; i < MIGRATIONS.length; i++) {
    sql.exec(MIGRATIONS[i]);
  }

  if (current === undefined) {
    sql.exec(
      "INSERT INTO schema_version (version) VALUES (?)",
      MIGRATIONS.length,
    );
  } else if (applied !== MIGRATIONS.length) {
    sql.exec("UPDATE schema_version SET version = ?", MIGRATIONS.length);
  }
};
