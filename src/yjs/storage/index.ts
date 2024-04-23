import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { storageKey } from "./storage-key";

import type { TransactionStorage } from "./type";

interface YTransactionStorage {
  getYDoc(): Promise<Doc>;
  storeUpdate(update: Uint8Array): Promise<void>;
}

type Options = {
  maxBytes?: number;
  maxUpdates?: number;
};

export class YTransactionStorageImpl implements YTransactionStorage {
  private readonly MAX_BYTES: number;
  private readonly MAX_UPDATES: number;

  // eslint-disable-next-line no-useless-constructor
  constructor(
    private readonly storage: TransactionStorage,
    options?: Options,
  ) {
    this.MAX_BYTES = options?.maxBytes ?? 1024 * 1024 * 2;

    this.MAX_UPDATES = options?.maxUpdates ?? 500;
  }

  async getYDoc(): Promise<Doc> {
    const snapshot = await this.storage.get<Uint8Array>(
      storageKey({ type: "state", name: "doc" }),
    );
    const data = await this.storage.list<Uint8Array>({
      prefix: storageKey({ type: "update" }),
    });

    const updates: Uint8Array[] = Array.from(data.values());
    const doc = new Doc();

    doc.transact(() => {
      if (snapshot) {
        applyUpdate(doc, snapshot);
      }
      for (const update of updates) {
        applyUpdate(doc, update);
      }
    });

    return doc;
  }

  storeUpdate(update: Uint8Array): Promise<void> {
    return this.storage.transaction(async (tx) => {
      const bytes =
        (await tx.get<number>(storageKey({ type: "state", name: "bytes" }))) ??
        0;
      const count =
        (await tx.get<number>(storageKey({ type: "state", name: "count" }))) ??
        0;

      const updateBytes = bytes + update.byteLength;
      const updateCount = count + 1;

      if (updateBytes > this.MAX_BYTES || updateCount > this.MAX_UPDATES) {
        const doc = await this.getYDoc();
        applyUpdate(doc, update);

        await tx.put(storageKey({ type: "state", name: "bytes" }), 0);
        await tx.put(storageKey({ type: "state", name: "count" }), 0);
        const deleteKeys = Array(count)
          .fill(0)
          .map((_, i) => storageKey({ type: "update", name: i + 1 }));
        await tx.delete(deleteKeys);
        await this.storeDoc(doc, tx);
      } else {
        await tx.put(storageKey({ type: "state", name: "bytes" }), updateBytes);
        await tx.put(storageKey({ type: "state", name: "count" }), updateCount);
        await tx.put(storageKey({ type: "update", name: updateCount }), update);
      }
    });
  }

  private async storeDoc(
    doc: Doc,
    storage: Omit<TransactionStorage, "transaction">,
  ): Promise<void> {
    const state = encodeStateAsUpdate(doc);

    await storage.put(storageKey({ type: "state", name: "doc" }), state);
  }
}
