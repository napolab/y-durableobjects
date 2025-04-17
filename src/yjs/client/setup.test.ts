import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import { vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { Doc } from "yjs";

import { messageType } from "../message-type";

import { setupWSConnection } from "./setup";

import type { RemoteDoc } from "../remote";
import type { Mocked } from "vitest";

class TestDoc extends Doc implements RemoteDoc {
  awareness = new Awareness(this);
}

describe("setupWSConnection", () => {
  let ws: Mocked<WebSocket>;

  beforeEach(() => {
    ws = { send: vi.fn() } as unknown as Mocked<WebSocket>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const decodeMessage = (message: Uint8Array) => {
    const decoder = createDecoder(message);
    const type = readVarUint(decoder);
    const data = readVarUint8Array(decoder);

    return { type, data };
  };

  it("sends sync and awareness messages correctly", () => {
    const doc = new TestDoc();
    doc.getText("root").insert(0, "test");

    setupWSConnection(ws, doc);

    expect(ws.send).toHaveBeenCalledTimes(2);
    const [syncMessage, awarenessMessage] = ws.send.mock.calls
      .map((call) => call[0])
      .filter((m): m is Uint8Array => m instanceof Uint8Array);

    const { type: syncType } = decodeMessage(syncMessage);
    expect(syncType).toBe(messageType.sync);

    const { type: awarenessType } = decodeMessage(awarenessMessage);
    expect(awarenessType).toBe(messageType.awareness);
  });

  it("does not send awareness message if there are no states", () => {
    const doc = new TestDoc();
    doc.awareness.getStates = vi.fn(() => new Map());

    setupWSConnection(ws, doc);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const [syncMessage] = ws.send.mock.calls
      .map((call) => call[0])
      .filter((m): m is Uint8Array => m instanceof Uint8Array);

    const { type } = decodeMessage(syncMessage);
    expect(type).toBe(messageType.sync);
  });
});
