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

      // Each connection publishes real awareness state through an actual
      // awareness-protocol message, the same way "derives awareness
      // ownership from the WebSocket origin observed at runtime" does. This
      // is essential: driving state through the real onStart() awareness
      // handler is what makes removeAwarenessStates() below have anything
      // to remove, which is the exact path that broke when
      // unregisterWebSocket() removed awareness states while the departing
      // socket was still a registered WSSharedDoc listener (broadcast()
      // would call send() on an already-closed socket and throw). A version
      // of this test that sets clientIds by calling sessions.track()
      // directly, or by calling awareness.setLocalStateField() on the
      // shared doc (which fires under the *local* client id, not either
      // socket's), would never exercise that path and would pass even
      // against the broken ordering.
      const firstAwareness = new Awareness(new Doc());
      firstAwareness.setLocalStateField("user", { name: "a" });
      await instance.webSocketMessage(
        first,
        createAwarenessMessage(firstAwareness).slice(0).buffer,
      );

      const secondAwareness = new Awareness(new Doc());
      secondAwareness.setLocalStateField("user", { name: "b" });
      await instance.webSocketMessage(
        second,
        createAwarenessMessage(secondAwareness).slice(0).buffer,
      );

      expect(instance.sessions.clientIdsOf(first)).toEqual([
        firstAwareness.clientID,
      ]);
      expect(instance.sessions.clientIdsOf(second)).toEqual([
        secondAwareness.clientID,
      ]);

      // Close `first` the way a real disconnect would leave it: the
      // underlying socket is already closed by the time webSocketClose()
      // fires, so any send() on it throws. This reproduces the exact
      // condition the ordering bug hit — a throwing listener still
      // registered in WSSharedDoc when removeAwarenessStates() runs.
      first.close();

      // (a) the call completes without throwing, even though `first` is a
      // dead socket and, until the fix, awareness removal still tried to
      // broadcast to it.
      await expect(instance.webSocketClose(first)).resolves.toBeUndefined();

      // (b) the departing socket is fully unregistered — no leaked session
      // or listener.
      expect(instance.sessions.has(first)).toBe(false);
      expect(instance.sessions.size).toBe(1);
      expect(instance.sessions.clientIdsOf(second)).toEqual([
        secondAwareness.clientID,
      ]);

      // (c) the remaining connection's awareness state survives; only the
      // departing connection's clientId was removed from the room.
      const states = instance.doc.awareness.getStates();
      expect(states.has(secondAwareness.clientID)).toBe(true);
      expect(states.has(firstAwareness.clientID)).toBe(false);
    });
  });

  it("unsubscribes the departing connection before broadcasting its awareness removal", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());

      // The departing socket must genuinely own awareness state, or
      // removeAwarenessStates() in unregisterWebSocket() has nothing to
      // remove and never emits "update" — in which case the handler below
      // would never run and the observation would never be recorded,
      // making the test vacuously pass no matter the ordering.
      const awareness = new Awareness(new Doc());
      awareness.setLocalStateField("user", { name: "a" });
      await instance.webSocketMessage(
        server,
        createAwarenessMessage(awareness).slice(0).buffer,
      );
      expect(instance.sessions.clientIdsOf(server)).toEqual([
        awareness.clientID,
      ]);

      // Assert the ordering invariant behaviourally, without relying on
      // ws.send() throwing (the broadcast guard added for Finding 2 means a
      // throw there no longer surfaces as a test failure on its own — see
      // the toggle-off note in the report for why that guard alone doesn't
      // prove the ordering is right). Capture the observation inside the
      // handler rather than asserting inside it, so a failure surfaces as a
      // normal assertion in the test body instead of an exception thrown
      // from deep inside Awareness's emit() and swallowed by
      // unregisterWebSocket()'s own try/catch.
      let serverStillRegisteredWhenAwarenessUpdateFired: boolean | undefined;
      instance.doc.awareness.on("update", () => {
        serverStillRegisteredWhenAwarenessUpdateFired =
          instance.sessions.has(server);
      });

      await instance.webSocketClose(server);

      // Guard against a vacuous pass: the handler must actually have run.
      expect(serverStillRegisteredWhenAwarenessUpdateFired).not.toBeUndefined();
      // The session must already be gone by the time the awareness removal
      // broadcasts — i.e. sessions.remove(ws) ran before
      // removeAwarenessStates(...) in unregisterWebSocket().
      expect(serverStillRegisteredWhenAwarenessUpdateFired).toBe(false);
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

  it("closes only the offending connection on a malformed message", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      await instance.createRoom("room1");
      const [first, other] = Array.from(instance.sessions.sockets());

      // 未知のメッセージ型。例外が外に漏れると DO 全体がリセットされる
      const malformed = new Uint8Array([99]).buffer;
      await expect(
        instance.webSocketMessage(first, malformed),
      ).resolves.toBeUndefined();

      // DO は生存し、他の（無関係な）接続も維持されている。webSocketClose
      // が `first` に対して呼ばれるかどうかはランタイムの詳細であり、この
      // テストが依存すべき性質ではない。ここで確かめるべきは「DO がリセット
      // されず、正常な接続が生き残ること」だけ。
      expect(instance.sessions.has(other)).toBe(true);
    });
  });

  it("persists an update before webSocketMessage resolves", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const client = await instance.createRoom("room1");

      // storeUpdate に人為的な遅延を挟む。SQLite への実書き込みは同期 API
      // なので、遅延を入れずに `await this.persist` を webSocketMessage から
      // 消してみても、たまたまマイクロタスクの実行順序だけで書き込みが先に
      // 終わってしまい、「直列化されている」ことを何も検証しない空振りの
      // テストになる（実際に確認した。トグルオフ検証は報告書を参照）。
      let persisted = false;
      const originalStoreUpdate = instance.storage.storeUpdate.bind(
        instance.storage,
      );
      instance.storage.storeUpdate = async (update: Uint8Array) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await originalStoreUpdate(update);
        persisted = true;
      };

      const message = createSyncMessage(createYDocMessage("persisted"));
      await instance.webSocketMessage(client, message.slice(0).buffer);

      // webSocketMessage が解決した時点で、遅延込みの永続化が完了している
      expect(persisted).toBe(true);

      // ストレージから読み直しても内容が入っている
      const stored = await instance.storage.getUpdate();
      expect(stored).not.toBeNull();
    });
  });

  it("closes every connection and asks the runtime to reset when persistence fails", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(
      stub,
      async (instance: InternalYDurableObject, state: DurableObjectState) => {
        const first = await instance.createRoom("room1");
        await instance.createRoom("room1");
        const sockets = Array.from(instance.sessions.sockets());

        // state.abort() の"本物"の実装は、この Durable Object の
        // io-context（≒このテストの runInDurableObject 呼び出しそのもの）
        // を丸ごと破棄する。実際に呼ばせると、それを待っている
        // runInDurableObject() 自身の Promise が二度と解決/reject されず、
        // このファイルどころか単一ランタイム上の以降の全テストごと
        // ハングすることを確認済み（トグルオフ検証時に実測、報告書に記載）。
        // ここで検証したいのは「失敗ハンドラが state.abort() を正しい理由
        // 付きで呼び、全ソケットを 1011 で閉じたか」という自分のコードの
        // 振る舞いであり、workerd 自身の abort 実装の正しさではないため、
        // abort() をスパイに差し替えて実行だけ観測する。
        let abortCalled = false;
        let abortReason: string | undefined;
        state.abort = (reason?: string) => {
          abortCalled = true;
          abortReason = reason;
        };

        instance.storage.storeUpdate = async () => {
          throw new Error("simulated storage failure");
        };

        const message = createSyncMessage(
          createYDocMessage("will not persist"),
        );

        // webSocketMessage 自体は例外を投げずに解決する
        // (Step 5 の try/catch は doc.update() の同期例外用。永続化の失敗は
        // schedulePersist の中で catch され、webSocketMessage はそれを
        // 待つだけなので reject しない)。
        await expect(
          instance.webSocketMessage(first, message.slice(0).buffer),
        ).resolves.toBeUndefined();

        for (const ws of sockets) {
          expect(ws.readyState).not.toBe(WebSocket.READY_STATE_OPEN);
        }
        expect(abortCalled).toBe(true);
        expect(abortReason).toBe("failed to persist a Yjs update");
      },
    );
  });
});
