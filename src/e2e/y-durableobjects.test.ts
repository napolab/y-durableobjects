import { env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import { expect, describe, it } from "vitest";
import { Doc, encodeStateAsUpdate } from "yjs";

import { YDurableObjects } from "../yjs";
import { YSqliteStorage } from "../yjs/storage";

import { createSyncMessage, createYDocMessage } from "./helper";

import type { YDurableObjectsAppType } from "../yjs";
import type { InternalYDurableObject } from "../yjs/internal";

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

  it("rehydrates the document from SQLite storage on startup", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(
      stub,
      async (instance: InternalYDurableObject, state) => {
        // Write directly into this instance's SQLite storage, bypassing
        // instance.doc entirely, so that the only way for the content to
        // reach instance.doc is through onStart()'s getUpdate()/applyUpdate
        // wiring — the exact seam this task changed.
        const storage = new YSqliteStorage(state.storage.sql);
        const seed = new Doc();
        seed.getText("root").insert(0, "Hello World!");
        await storage.storeUpdate(encodeStateAsUpdate(seed));

        // vitest-pool-workers keeps this Durable Object instance alive for
        // the whole worker lifetime, so there is no way to force a genuinely
        // fresh construction here. Invoking onStart() directly is the
        // workable substitute for a cold start: it re-runs the exact
        // rehydration logic construction would have run.
        //
        // Known wart surfaced by this: onStart() unconditionally
        // re-registers the doc "update" and awareness "update" listeners,
        // so after this second call the instance carries duplicate
        // listeners. That does not affect this assertion (rehydration reads
        // storage once, before any listener fires), but it is a real
        // pre-existing issue in onStart() worth flagging for Task 7, which
        // rewrites this listener wiring.
        await instance.onStart();

        expect(instance.doc.getText("root").toString()).toBe("Hello World!");
      },
    );
  });

  it("create a room from request", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const client = hc<YDurableObjectsAppType>("http://localhost", {
        fetch(req: RequestInfo | URL) {
          const r = new Request(req);

          return instance.fetch(r);
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
      await instance.updateYDoc(update.slice(0));

      const docState = await instance.getYDoc();
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
      await instance.webSocketMessage(client, update.slice(0).buffer);

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

      await instance.webSocketError(server);

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

      await instance.webSocketClose(server);

      expect(instance.sessions.size).toBe(0);
    });
  });
});
