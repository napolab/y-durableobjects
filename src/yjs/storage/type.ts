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
