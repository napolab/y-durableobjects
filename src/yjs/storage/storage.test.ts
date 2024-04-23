import { Doc, encodeStateAsUpdate } from "yjs";

import { YTransactionStorageImpl } from ".";

import type { TransactionStorage } from "./type";
import type { Mocked } from "vitest";

describe("YTransactionStorageImpl", () => {
  let storage: Mocked<TransactionStorage>;

  beforeEach(() => {
    storage = {
      get: vi.fn(),
      list: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(async (closure) => closure(storage)),
    } as Mocked<TransactionStorage>;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  describe("Document Retrieval", () => {
    it("returns an empty YDoc when there are no updates", async () => {
      storage.get.mockResolvedValueOnce(undefined);
      storage.list.mockResolvedValueOnce(new Map());

      const yStorage = new YTransactionStorageImpl(storage);
      const doc = await yStorage.getYDoc();
      expect(encodeStateAsUpdate(doc)).toEqual(encodeStateAsUpdate(new Doc()));
    });

    it("reconstructs the correct YDoc state from updates", async () => {
      const stored = new Doc();
      stored.getText("root").insert(0, "Hello World");
      const update = encodeStateAsUpdate(stored);

      storage.get.mockResolvedValueOnce(undefined);
      storage.list.mockResolvedValueOnce(new Map([["ydoc:update:1", update]]));

      const yStorage = new YTransactionStorageImpl(storage);
      const doc = await yStorage.getYDoc();
      expect(encodeStateAsUpdate(doc)).toEqual(encodeStateAsUpdate(stored));
    });
  });

  describe("Update Storage", () => {
    it("stores updates correctly under unique keys", async () => {
      const update = new Uint8Array([1, 2, 3]);
      storage.get.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const yStorage = new YTransactionStorageImpl(storage);
      await yStorage.storeUpdate(update);
      expect(storage.put).toHaveBeenCalledWith("ydoc:state:bytes", 3);
      expect(storage.put).toHaveBeenCalledWith("ydoc:state:count", 1);
      expect(storage.put).toHaveBeenCalledWith("ydoc:update:1", update);
    });

    it("increments the update count and update bytes on subsequent updates", async () => {
      storage.get.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

      const yStorage = new YTransactionStorageImpl(storage);
      const update = new Uint8Array([4, 5, 6]);
      await yStorage.storeUpdate(update);
      expect(storage.put).toHaveBeenCalledWith(
        "ydoc:state:bytes",
        3 + update.byteLength,
      );
      expect(storage.put).toHaveBeenCalledWith("ydoc:state:count", 2);
      expect(storage.put).toHaveBeenCalledWith("ydoc:update:2", update);
    });
  });

  describe("Handling Exceeded Limits", () => {
    it.each([
      [2048 * 1024 * 2 + 1, 10], // Exceeded maxBytes
      [10, 501], // Exceeded maxUpdates
    ])(
      "resets counts and bytes and stores combined state doc when limits are exceeded (%p bytes, %p updates)",
      async (exceededBytes, exceededUpdates) => {
        const doc = new Doc();
        doc.getText("root").insert(0, "Hello World");
        const update = encodeStateAsUpdate(doc);

        storage.get
          .mockResolvedValueOnce(exceededBytes)
          .mockResolvedValueOnce(exceededUpdates);
        storage.list.mockResolvedValue(new Map([["ydoc:update:1", update]]));

        const yStorage = new YTransactionStorageImpl(storage);
        await yStorage.storeUpdate(update);

        const newDoc = await yStorage.getYDoc();
        const expectedState = encodeStateAsUpdate(newDoc);

        expect(storage.delete).toHaveBeenCalledWith(
          Array(exceededUpdates)
            .fill(0)
            .map((_, i) => `ydoc:update:${i + 1}`),
        );
        expect(storage.put).toHaveBeenCalledWith("ydoc:state:bytes", 0);
        expect(storage.put).toHaveBeenCalledWith("ydoc:state:count", 0);
        expect(storage.put).toHaveBeenCalledWith(
          "ydoc:state:doc",
          expect.any(Uint8Array),
        );
        expect(expectedState).toEqual(encodeStateAsUpdate(newDoc));
      },
    );
  });

  describe("Configuration Options", () => {
    it("handles options to modify maxBytes and maxUpdates", () => {
      const yStorage = new YTransactionStorageImpl(storage, {
        maxBytes: 1024,
        maxUpdates: 100,
      });
      expect(yStorage).toHaveProperty("MAX_BYTES", 1024);
      expect(yStorage).toHaveProperty("MAX_UPDATES", 100);
    });
  });
});
