interface ListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
}

export interface TransactionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  list<T = unknown>(options?: ListOptions): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  transaction<T>(
    closure: (txn: Omit<TransactionStorage, "transaction">) => Promise<T>,
  ): Promise<T>;
}

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
