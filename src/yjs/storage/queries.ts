/**
 * SQL 文字列をこのファイルに隔離する。
 * 将来スキーマが複雑になり Kysely 等のクエリビルダを導入する場合も、
 * 変更はこのファイル内で完結する。
 */
export const SELECT_ALL_UPDATES = "SELECT kind, data FROM updates ORDER BY seq";
export const INSERT_UPDATE = "INSERT INTO updates (kind, data) VALUES (?, ?)";
export const DELETE_ALL_UPDATES = "DELETE FROM updates";
export const COUNT_UPDATES = "SELECT COUNT(*) AS count FROM updates";
