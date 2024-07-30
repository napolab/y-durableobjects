import { Doc, encodeStateAsUpdate } from "yjs";

import { storageKey } from "./storage-key";

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

        storage.get.mockImplementation((key) => {
          switch (key) {
            case storageKey({ type: "state", name: "bytes" }):
              return Promise.resolve(exceededBytes);
            case storageKey({ type: "state", name: "count" }):
              return Promise.resolve(exceededUpdates);
            default:
              return Promise.resolve(undefined);
          }
        });
        storage.list.mockResolvedValue(
          new Map(
            Array(exceededUpdates)
              .fill(0)
              .map((_, i) => [`ydoc:update:${i + 1}`, update]),
          ),
        );

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

    it("throws an error when maxBytes exceeds 128KB", () => {
      expect(() => {
        return new YTransactionStorageImpl(storage, {
          maxBytes: 128 * 1024 + 1,
          maxUpdates: 100,
        });
      }).toThrow("maxBytes must be less than 128KB");
    });
  });

  describe("commit method", () => {
    it("commits all updates and clears all related storage keys", async () => {
      const yStorage = new YTransactionStorageImpl(storage);

      const doc = new Doc();
      doc.getText("root").insert(0, "Hello World");
      const update = encodeStateAsUpdate(doc);
      storage.get.mockImplementation((key) => {
        switch (key) {
          case storageKey({ type: "state", name: "bytes" }):
            return Promise.resolve(update.byteLength);
          case storageKey({ type: "state", name: "count" }):
            return Promise.resolve(1);
          case storageKey({ type: "state", name: "doc" }):
            return Promise.resolve(undefined);
          default: {
            throw new Error("Unexpected key");
          }
        }
      });
      storage.list.mockResolvedValue(
        new Map(
          Array(1)
            .fill(0)
            .map((_, i) => [`ydoc:update:${i + 1}`, update]),
        ),
      );

      await yStorage.commit();

      expect(storage.delete).toHaveBeenCalledWith(expect.any(Array));
      expect(storage.put).toHaveBeenCalledWith(
        storageKey({ type: "state", name: "bytes" }),
        0,
      );
      expect(storage.put).toHaveBeenCalledWith(
        storageKey({ type: "state", name: "count" }),
        0,
      );
      expect(storage.put).toHaveBeenCalledWith(
        storageKey({ type: "state", name: "doc" }),
        expect.any(Uint8Array),
      );
    });

    it("does not throw errors when there are no updates to commit", async () => {
      const yStorage = new YTransactionStorageImpl(storage);
      storage.get.mockImplementation((key) => {
        switch (key) {
          case storageKey({ type: "state", name: "bytes" }):
            return Promise.resolve(undefined);
          case storageKey({ type: "state", name: "count" }):
            return Promise.resolve(undefined);
          case storageKey({ type: "state", name: "doc" }):
            return Promise.resolve(undefined);
          default: {
            throw new Error("Unexpected key");
          }
        }
      });

      storage.list.mockResolvedValue(new Map());

      await expect(yStorage.commit()).resolves.not.toThrow();
    });
  });
});
