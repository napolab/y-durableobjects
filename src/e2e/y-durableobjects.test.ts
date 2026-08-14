import { env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import {
  createEncoder,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { expect, describe, it } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { Doc, encodeStateAsUpdate } from "yjs";

import { YDurableObjects } from "../yjs";
import { messageType } from "../yjs/message-type";
import { YSqliteStorage } from "../yjs/storage";

import { createSyncMessage, createYDocMessage } from "./helper";

import type { YDurableObjectsAppType } from "../yjs";
import type { InternalYDurableObject } from "../yjs/internal";

// Encodes a real awareness protocol message, the way an actual client would.
// Sending this through webSocketMessage() is the only way to exercise the
// production path that decides ownership: WSSharedDoc.update() passes the
// receiving WebSocket as `origin` into applyAwarenessUpdate(), which is what
// the awareness "update" handler in onStart() branches on with
// `origin instanceof WebSocket`.
const createAwarenessMessage = (awareness: Awareness) => {
  const encoder = createEncoder();
  writeVarUint(encoder, messageType.awareness);
  writeVarUint8Array(
    encoder,
    encodeAwarenessUpdate(awareness, [awareness.clientID]),
  );

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
      const [server] = Array.from(instance.sessions.sockets());

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
      const [server] = Array.from(instance.sessions.sockets());

      await instance.webSocketClose(server);

      expect(instance.sessions.size).toBe(0);
    });
  });

  it("keeps other clients' awareness when one connection closes", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      await instance.createRoom("room1");
      const [first, second] = Array.from(instance.sessions.sockets());

      instance.sessions.track(first, [1]);
      instance.sessions.track(second, [2]);
      instance.doc.awareness.setLocalStateField("user", { name: "a" });

      await instance.webSocketClose(first);

      // first の clientId だけが除去され、second の所有分は残る
      expect(instance.sessions.clientIdsOf(second)).toEqual([2]);
      expect(instance.sessions.size).toBe(1);
    });
  });

  it("derives awareness ownership from the WebSocket origin observed at runtime", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());

      // Simulate a remote peer announcing its presence, exactly as a real
      // Yjs client would over the wire.
      const remoteDoc = new Doc();
      const remoteAwareness = new Awareness(remoteDoc);
      remoteAwareness.setLocalStateField("user", { name: "remote" });

      const message = createAwarenessMessage(remoteAwareness);
      await instance.webSocketMessage(server, message.slice(0).buffer);

      // sessions.track() is only ever called from the awareness "update"
      // handler wired in onStart(), and only when `origin instanceof
      // WebSocket` is true. This test never calls sessions.track() itself,
      // so if that instanceof check silently failed to match (e.g. because
      // WebSocketPair sockets, or the sockets returned by
      // state.getWebSockets() after hibernation, are not real WebSocket
      // instances in this runtime), clientIdsOf(server) would stay empty
      // here and the assertion below would fail.
      expect(instance.sessions.clientIdsOf(server)).toEqual([
        remoteAwareness.clientID,
      ]);
    });
  });
});
