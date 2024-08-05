import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding.js";
import { writeUpdate } from "y-protocols/sync.js";
import { Doc, encodeStateAsUpdate } from "yjs";

import { messageType } from "../yjs/message-type";

// Helper to create updates based on document type
export const createYDocMessage = (content: string = "Hello World!") => {
  const doc = new Doc();
  doc.getText("root").insert(0, content);

  return encodeStateAsUpdate(doc);
};

// Helper to create an encoded message from an update
export const createSyncMessage = (update: Uint8Array) => {
  const encoder = createEncoder();
  writeVarUint(encoder, messageType.sync);
  writeUpdate(encoder, update);

  return toUint8Array(encoder);
};
