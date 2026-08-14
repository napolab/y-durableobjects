import { createDecoder, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import { Doc, encodeStateAsUpdate } from "yjs";

import { messageType } from "../message-type";

import { WSSharedDoc } from "./ws-shared-doc";

import type { Mock } from "vitest";

// Helper to create updates based on document type
const createYDocMessage = (content: string = "Hello World!") => {
  const doc = new Doc();
  doc.getText("root").insert(0, content);

  return encodeStateAsUpdate(doc);
};

// Helper to create an encoded message from an update
const createSyncMessage = (update: Uint8Array) => {
  const encoder = createEncoder();
  writeVarUint(encoder, messageType.sync);
  writeUpdate(encoder, update);

  return toUint8Array(encoder);
};

// Helper to apply a received message to a new document
const applyMessage = (message: Uint8Array) => {
  const receivedDoc = new Doc();
  const decoder = createDecoder(message);
  readVarUint(decoder);
  readSyncMessage(decoder, createEncoder(), receivedDoc, null);

  return receivedDoc;
};

describe("WSSharedDoc", () => {
  let doc: WSSharedDoc;
  let origin: object;
  let mockListener: Mock;

  beforeEach(() => {
    doc = new WSSharedDoc();
    origin = {};
    mockListener = vi.fn();
    doc.notify(origin, mockListener);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handling Yjs Updates", () => {
    it("should process Yjs updates and notify listeners", () => {
      const update = createYDocMessage("Hello, world!");
      const message = createSyncMessage(update);

      doc.update(message, {});

      expect(mockListener).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockListener.mock.calls[0][0]).toEqual(message);

      const receivedDoc = applyMessage(mockListener.mock.calls[0][0]);
      expect(receivedDoc.getText("root").toString()).toEqual("Hello, world!");
    });
  });

  describe("Event Notification", () => {
    it("should add and remove listeners correctly", () => {
      const anotherOrigin = {};
      const anotherListener = vi.fn();
      const unsubscribe = doc.notify(anotherOrigin, anotherListener);
      const message1 = createSyncMessage(createYDocMessage("text1"));
      const message2 = createSyncMessage(createYDocMessage("text2"));

      doc.update(message1, {});

      expect(mockListener).toHaveBeenCalledTimes(1);
      expect(anotherListener).toHaveBeenCalledTimes(1);

      unsubscribe();
      doc.update(message2, {});

      expect(mockListener).toHaveBeenCalledTimes(2);
      expect(anotherListener).toHaveBeenCalledTimes(1);
    });

    it("does not let an earlier unsubscribe for an origin remove a later listener registered for that same origin", () => {
      const sharedOrigin = {};
      const firstListener = vi.fn();
      const secondListener = vi.fn();

      const unsubscribeFirst = doc.notify(sharedOrigin, firstListener);
      // A second notify() for the same origin overwrites the first entry.
      doc.notify(sharedOrigin, secondListener);

      // This should be a no-op: it registered `firstListener`, which is no
      // longer the listener stored for `sharedOrigin`.
      unsubscribeFirst();

      doc.update(createSyncMessage(createYDocMessage("text3")), {});

      expect(secondListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("Origin-aware routing", () => {
    it("sends the sync step 2 reply only to the requesting origin", () => {
      const doc = new WSSharedDoc();
      const requester = {};
      const bystander = {};
      const toRequester: Uint8Array[] = [];
      const toBystander: Uint8Array[] = [];
      doc.notify(requester, (message) => toRequester.push(message));
      doc.notify(bystander, (message) => toBystander.push(message));

      doc.getText("root").insert(0, "seed");
      toRequester.length = 0;
      toBystander.length = 0;

      const encoder = createEncoder();
      writeVarUint(encoder, messageType.sync);
      writeSyncStep1(encoder, new Doc());
      doc.update(toUint8Array(encoder), requester);

      expect(toRequester.length).toBe(1);
      expect(toBystander.length).toBe(0);
    });

    it("does not echo an update back to its origin", () => {
      const doc = new WSSharedDoc();
      const sender = {};
      const receiver = {};
      const toSender: Uint8Array[] = [];
      const toReceiver: Uint8Array[] = [];
      doc.notify(sender, (message) => toSender.push(message));
      doc.notify(receiver, (message) => toReceiver.push(message));

      const source = new Doc();
      source.getText("root").insert(0, "hello");
      const encoder = createEncoder();
      writeVarUint(encoder, messageType.sync);
      writeUpdate(encoder, encodeStateAsUpdate(source));
      doc.update(toUint8Array(encoder), sender);

      expect(toSender.length).toBe(0);
      expect(toReceiver.length).toBe(1);
    });

    it("does not let a throwing recipient's send escape update()", () => {
      const doc = new WSSharedDoc();
      const requester = {};
      doc.notify(requester, () => {
        throw new Error("dead socket");
      });

      // A sync step 1 reply goes only to the requester via the private
      // send() path (this.send(origin, ...)), not broadcast() -- so this
      // exercises send()'s own guard, not broadcast()'s.
      const encoder = createEncoder();
      writeVarUint(encoder, messageType.sync);
      writeSyncStep1(encoder, new Doc());

      expect(() => doc.update(toUint8Array(encoder), requester)).not.toThrow();
    });

    it("throws on an unknown message type", () => {
      const doc = new WSSharedDoc();
      const encoder = createEncoder();
      writeVarUint(encoder, 99);

      expect(() => doc.update(toUint8Array(encoder), {})).toThrow();
    });
  });
});
