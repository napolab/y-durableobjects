import { mergeUpdates } from "yjs";

import {
  COUNT_UPDATES,
  DELETE_ALL_UPDATES,
  INSERT_UPDATE,
  SELECT_ALL_UPDATES,
} from "./queries";
import { migrate } from "./schema";
import { UpdateKind } from "./type";

import type { YStorage } from "./type";

type UpdateRow = {
  seq: number;
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
  // eslint-disable-next-line no-unused-private-class-members -- read by commit() in Task 3
  readonly #maxRows: number;
  readonly #maxChunkBytes: number;
  // eslint-disable-next-line no-unused-private-class-members -- read by commit() in Task 3
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
      if (row.kind === UpdateKind.continuation) {
        if (pending.length === 0) {
          // A continuation row with nothing preceding it to attach to means
          // the updates table itself is corrupt (truncated compaction,
          // manual tampering, a bug elsewhere). Silently reinterpreting the
          // fragment as a standalone update would hand raw fragment bytes
          // to Y.mergeUpdates and either corrupt the document without any
          // signal or fail later with a confusing decode error far from the
          // real cause. A storage library must surface its own corruption
          // loudly instead of guessing, so we fail here and name the row.
          throw new Error(
            `YSqliteStorage: orphaned continuation row at seq=${row.seq} has no preceding row to attach to`,
          );
        }
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
