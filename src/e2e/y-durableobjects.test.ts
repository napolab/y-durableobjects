import { env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import { createEncoder, writeVarUint, toUint8Array } from "lib0/encoding.js";
import { expect, describe, it } from "vitest";
import { writeUpdate } from "y-protocols/sync.js";
import { Doc, encodeStateAsUpdate } from "yjs";

import { YDurableObjects } from "../yjs";
import { messageType } from "../yjs/message-type";

import type { YDurableObjectsAppType } from "../yjs";
import type { InternalYDurableObject } from "../yjs/internal";

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

describe("YDurableObjects", () => {
  it("initializes correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      expect(instance).toBeInstanceOf(YDurableObjects);
      expect(instance.doc).toBeDefined();
      expect(instance.storage).toBeDefined();
    });
  });

  it("create a room from request", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const client = hc<YDurableObjectsAppType>("http://localhost", {
        fetch(req: RequestInfo | URL) {
          const r = new Request(req);

          return instance.fetch?.(r) ?? new Response(null);
        },
      });
      const res = await client.rooms[":roomId"].$get({
        param: { roomId: "room1" },
      });

      expect(res.webSocket).toBeInstanceOf(WebSocket);
    });
  });

  it("creates a room correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const roomId = "room1";
      const client = await instance.createRoom(roomId);

      expect(client).toBeInstanceOf(WebSocket);
      expect(instance.sessions.size).toBe(1);
    });
  });

  it("updates YDoc correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const message = createYDocMessage();
      const update = createSyncMessage(message);
      await instance.updateYDoc(update);

      const docState = instance.getYDoc();
      expect(docState).toEqual(message);
    });
  });

  it("handles WebSocket messages correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const roomId = "room1";
      const client = await instance.createRoom(roomId);

      const message = createYDocMessage();
      const update = createSyncMessage(message);
      await instance.webSocketMessage?.(client, update.buffer);

      const docState = await instance.getYDoc();
      expect(docState).toEqual(message);
    });
  });

  it("handles WebSocket errors correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const roomId = "room1";
      await instance.createRoom(roomId);
      const [server] = Array.from(instance.sessions.entries()).at(0)!;

      await instance.webSocketError?.(server, {});

      expect(instance.sessions.size).toBe(0);
    });
  });

  it("handles WebSocket close correctly", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const roomId = "room1";
      await instance.createRoom(roomId);
      const [server] = Array.from(instance.sessions.entries()).at(0)!;

      await instance.webSocketClose?.(server, 1001, "reason", true);

      expect(instance.sessions.size).toBe(0);
    });
  });
});
