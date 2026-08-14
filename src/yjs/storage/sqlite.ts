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
  readonly #maxRows: number;
  readonly #maxChunkBytes: number;
  #rowCount: number;
  /**
   * commit() を呼ばずに済む行数の下限。通常は #maxRows と同じだが、
   * コンパクション結果が #maxRows を超える行数を必要とする場合は
   * その行数（+1）まで引き上げる。そうしないと、以降の storeUpdate が
   * 呼ばれるたびに毎回フルコンパクションを再実行してしまう
   * （コンパクションしても #maxRows 以下にはならないため）。
   */
  #compactionFloor: number;

  constructor(sql: SqlStorage, options?: YSqliteStorageOptions) {
    this.#maxChunkBytes = options?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    if (this.#maxChunkBytes > SQLITE_BLOB_LIMIT) {
      // https://developers.cloudflare.com/durable-objects/platform/limits/
      throw new Error("maxChunkBytes must not exceed 2MB");
    }
    this.#maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
    this.#compactionFloor = this.#maxRows;

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
    // Cloudflare の SQLite は BLOB 1 行あたり 2MB までしか許さない。単一の
    // update がその上限を超えることは実際に起こる（大きな貼り付け、埋め込み
    // 画像、新規クライアントの sync step 2 が運ぶ大きなドキュメント全体など）。
    // #split() で maxChunkBytes 以下の断片に割ってから複数行として書き込む。
    // commit() と同じ分割ロジックを再利用するので、#readAll() の復元側は
    // 変更不要（continuation はすでに連結される）。
    const chunks = this.#split(update);

    // ここから下では await を挟まないこと。
    // 連続した同期書き込みが暗黙のトランザクションとして atomic に適用される。
    for (const [index, chunk] of chunks.entries()) {
      const kind =
        index === 0 ? UpdateKind.standalone : UpdateKind.continuation;
      this.#sql.exec(INSERT_UPDATE, kind, chunk);
    }
    this.#rowCount += chunks.length;

    if (this.#rowCount > this.#compactionFloor) {
      await this.commit();
    }
  }

  async commit(): Promise<void> {
    if (this.#rowCount <= 1) return;

    const updates = this.#readAll();
    if (updates.length === 0) return;

    const chunks = this.#split(mergeUpdates(updates));

    // ここから下では await を挟まないこと。
    // 連続した同期書き込みが暗黙のトランザクションとして atomic に適用される。
    this.#sql.exec(DELETE_ALL_UPDATES);
    for (const [index, chunk] of chunks.entries()) {
      const kind =
        index === 0 ? UpdateKind.standalone : UpdateKind.continuation;
      this.#sql.exec(INSERT_UPDATE, kind, chunk);
    }
    this.#rowCount = chunks.length;
    // このコンパクションが生んだ実際の行数が #maxRows を超えるなら、
    // それより低いしきい値で次の storeUpdate を毎回コンパクションさせても
    // 無駄な全件書き直しを繰り返すだけで行数は減らない。しきい値をこの
    // 行数（+1）まで引き上げて、実際に増えたときだけ再コンパクションする。
    this.#compactionFloor = Math.max(this.#maxRows, chunks.length + 1);
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

  /**
   * マージ済みの update を maxChunkBytes 以下のバイト断片に分割する。
   * subarray ではなく slice を使ってコピーを作る。ビューをそのまま
   * バインドすると基底バッファ全体が書き込まれる可能性があるため。
   */
  #split(update: Uint8Array): Uint8Array[] {
    if (update.byteLength <= this.#maxChunkBytes) return [update];

    const chunks: Uint8Array[] = [];
    for (
      let offset = 0;
      offset < update.byteLength;
      offset += this.#maxChunkBytes
    ) {
      chunks.push(
        update.slice(
          offset,
          Math.min(offset + this.#maxChunkBytes, update.byteLength),
        ),
      );
    }

    return chunks;
  }
}
