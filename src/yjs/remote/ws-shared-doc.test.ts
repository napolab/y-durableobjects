import { createDecoder, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import { Doc, encodeStateAsUpdate } from "yjs";

import { messageType } from "../message-type";

import { WSSharedDoc } from "./ws-shared-doc";

import type { Mock } from "vitest";

// Helper to create updates based on document type
const messageUpdate = (content: string = "Hello World!") => {
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
  let mockListener: Mock;

  beforeEach(() => {
    doc = new WSSharedDoc();
    mockListener = vi.fn();
    doc.notify(mockListener);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handling Yjs Updates", () => {
    it("should process Yjs updates and notify listeners", () => {
      const update = messageUpdate("Hello, world!");
      const message = createSyncMessage(update);

      doc.update(message);

      expect(mockListener).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockListener.mock.calls[0][0]).toEqual(message);

      const receivedDoc = applyMessage(mockListener.mock.calls[0][0]);
      expect(receivedDoc.getText("root").toString()).toEqual("Hello, world!");
    });
  });

  describe("Event Notification", () => {
    it("should add and remove listeners correctly", () => {
      const anotherListener = vi.fn();
      const unsubscribe = doc.notify(anotherListener);
      const message1 = createSyncMessage(messageUpdate("text1"));
      const message2 = createSyncMessage(messageUpdate("text2"));

      doc.update(message1);

      expect(mockListener).toHaveBeenCalledTimes(1);
      expect(anotherListener).toHaveBeenCalledTimes(1);

      unsubscribe();
      doc.update(message2);

      expect(mockListener).toHaveBeenCalledTimes(2);
      expect(anotherListener).toHaveBeenCalledTimes(1);
    });
  });
});
