import { env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import { createDecoder, readVarUint } from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { expect, describe, it, vi } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage } from "y-protocols/sync";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

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
        // onStart() guards its doc "update" and awareness "update" listener
        // registration with a `listenersRegistered` flag (Task 7), so this
        // second call re-runs rehydration without re-registering either
        // listener. That guard doesn't affect this assertion either way
        // (rehydration reads storage once, before any listener fires) — it's
        // just why calling onStart() twice here is safe to do at all.
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

  it("round-trips between getYDoc and updateYDoc", async () => {
    const source = env.Y_DURABLE_OBJECTS.get(
      env.Y_DURABLE_OBJECTS.newUniqueId(),
    );
    const target = env.Y_DURABLE_OBJECTS.get(
      env.Y_DURABLE_OBJECTS.newUniqueId(),
    );

    const message = createYDocMessage("Hello World!");
    await runInDurableObject(
      source,
      async (instance: InternalYDurableObject) => {
        await instance.updateYDoc(message.slice(0));
      },
    );

    const exported = await runInDurableObject(
      source,
      (instance: InternalYDurableObject) => instance.getYDoc(),
    );
    await runInDurableObject(
      target,
      async (instance: InternalYDurableObject) => {
        // getYDoc の出力をそのまま updateYDoc に渡せる
        await instance.updateYDoc(exported);
      },
    );

    const copied = await runInDurableObject(
      target,
      (instance: InternalYDurableObject) => instance.getYDoc(),
    );

    const doc = new Doc();
    applyUpdate(doc, copied);
    expect(doc.getText("root").toString()).toBe("Hello World!");
  });

  it("broadcasts an updateYDoc change to connected WebSocket clients", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());

      // registerWebSocket() already sent an initial sync/awareness pair
      // synchronously when the room was created above; only care about
      // what gets sent in response to updateYDoc, so install the spy
      // after that initial handshake has already happened.
      const sent = vi.fn();
      server.send = sent;

      const message = createYDocMessage("via rpc");
      await instance.updateYDoc(message.slice(0));

      // applyUpdate(this.doc, update, RPC_ORIGIN) must fire WSSharedDoc's
      // "update" handler, which calls broadcast(msg, RPC_ORIGIN) — and
      // broadcast only excludes an origin that is itself a registered
      // listener key. RPC_ORIGIN is never registered (only WebSockets are,
      // via notify()), so every connected socket, including this one,
      // must receive the broadcast.
      expect(sent).toHaveBeenCalled();

      const syncMessage = sent.mock.calls
        .map((call: unknown[]) => call[0])
        .find((raw): raw is Uint8Array => {
          if (!(raw instanceof Uint8Array)) return false;
          const decoder = createDecoder(raw);

          return readVarUint(decoder) === messageType.sync;
        });
      expect(syncMessage).toBeDefined();

      // Decode past the outer messageType.sync wrapper and apply the inner
      // sync-protocol payload to a fresh Doc exactly as a real client would
      // on receipt. This proves the *content* of the RPC update actually
      // reached the socket, not merely that some send() happened to fire.
      const decoder = createDecoder(syncMessage as Uint8Array);
      readVarUint(decoder); // messageType.sync, already checked above
      const received = new Doc();
      readSyncMessage(decoder, createEncoder(), received, null);

      expect(received.getText("root").toString()).toBe("via rpc");
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

      // 実際に不正なメッセージを送った接続自体は 1003 で閉じられている。
      // これがないと、例外境界が ws.close(1003, ...) を一切呼ばない
      // (単に catch { return; } するだけの) 実装でもこのテストは通ってしまう。
      expect(first.readyState).not.toBe(WebSocket.READY_STATE_OPEN);
    });
  });

  it("unregisters the session immediately when the exception boundary closes a socket, without relying on webSocketClose", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());

      // Give it real awareness state to remove, so the assertions below
      // actually exercise removeAwarenessStates() rather than a no-op.
      const awareness = new Awareness(new Doc());
      awareness.setLocalStateField("user", { name: "a" });
      await instance.webSocketMessage(
        server,
        createAwarenessMessage(awareness).slice(0).buffer,
      );
      expect(instance.sessions.clientIdsOf(server)).toEqual([
        awareness.clientID,
      ]);

      // 未知のメッセージ型。例外境界がこのソケットを 1003 で閉じる。
      const malformed = new Uint8Array([99]).buffer;
      await instance.webSocketMessage(server, malformed);

      // This DO closed the socket itself; webSocketClose is not guaranteed
      // to fire for a close the DO initiated. Without the exception
      // boundary's own explicit unregisterWebSocket() call, the session and
      // this socket's awareness state would leak indefinitely (or until
      // webSocketClose happens to fire on its own), instead of being gone
      // by the time webSocketMessage() resolves.
      expect(instance.sessions.has(server)).toBe(false);
      expect(instance.doc.awareness.getStates().has(awareness.clientID)).toBe(
        false,
      );
    });
  });

  it("still unregisters the session and resolves when close() throws inside the malformed-message exception boundary", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());

      const awareness = new Awareness(new Doc());
      awareness.setLocalStateField("user", { name: "a" });
      await instance.webSocketMessage(
        server,
        createAwarenessMessage(awareness).slice(0).buffer,
      );
      expect(instance.sessions.clientIdsOf(server)).toEqual([
        awareness.clientID,
      ]);

      // workerd throws if close() is called on a socket that is already
      // closed or errored -- exactly what could be true of the socket that
      // just sent a malformed frame. Simulate that here.
      server.close = () => {
        throw new Error("already closed");
      };

      const malformed = new Uint8Array([99]).buffer;

      // webSocketMessage must still resolve normally: the close() throwing
      // must not escape the exception boundary and reject the call, or the
      // whole room resets on a single malformed frame -- the exact outage
      // H-4 exists to prevent.
      await expect(
        instance.webSocketMessage(server, malformed),
      ).resolves.toBeUndefined();

      // And unregisterWebSocket() must still have run despite close()
      // throwing, or the session/awareness leak IMPORTANT 3 fixed comes
      // back for any socket close() fails on.
      expect(instance.sessions.has(server)).toBe(false);
      expect(instance.doc.awareness.getStates().has(awareness.clientID)).toBe(
        false,
      );
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

  it("still closes the other sockets and reaches abort() when one socket's close() throws", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(
      stub,
      async (instance: InternalYDurableObject, state: DurableObjectState) => {
        await instance.createRoom("room1");
        await instance.createRoom("room1");
        const [troublesome, healthy] = Array.from(instance.sessions.sockets());

        // workerd throws if close() is called on a socket that is already
        // closed or errored — exactly what state.getWebSockets() can hand
        // the failure handler: the socket the exception boundary just
        // closed with 1003, or the socket whose own error caused this
        // failure in the first place. Simulate that here.
        troublesome.close = () => {
          throw new Error("already closed");
        };

        let abortCalled = false;
        state.abort = () => {
          abortCalled = true;
        };

        instance.storage.storeUpdate = async () => {
          throw new Error("simulated storage failure");
        };

        const message = createSyncMessage(
          createYDocMessage("will not persist"),
        );

        // webSocketMessage still resolves normally: the per-socket
        // try/catch in onPersistFailure must contain the throwing close(),
        // not let it escape and reject the persist chain.
        await expect(
          instance.webSocketMessage(troublesome, message.slice(0).buffer),
        ).resolves.toBeUndefined();

        // The other socket is not left open just because one close() threw.
        expect(healthy.readyState).not.toBe(WebSocket.READY_STATE_OPEN);
        // And critically, abort() — the actual point of this failure
        // policy — is still reached despite the throw.
        expect(abortCalled).toBe(true);
      },
    );
  });

  it("configures a ping/pong auto response", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();

      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
    });
  });

  it("clears the document and closes connections on destroy", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      const [server] = Array.from(instance.sessions.sockets());
      await instance.updateYDoc(createYDocMessage("bye").slice(0));

      await instance.destroy();

      // Storage is cleared.
      expect(await instance.storage.getUpdate()).toBeNull();

      // The connection is actually closed, not just left registered.
      expect(server.readyState).not.toBe(WebSocket.READY_STATE_OPEN);
      expect(instance.sessions.size).toBe(0);

      // The in-memory Doc is discarded too, not just storage. Otherwise a
      // client connecting to this still-live instance after destroy() would
      // receive the old content via sync step 1/2, and subsequent deltas
      // would reference struct parents that no longer exist anywhere.
      expect(instance.doc.getText("root").toString()).toBe("");
    });
  });

  it("destroys the replaced document instead of only discarding it", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const oldDoc = instance.doc;

      await instance.destroy();

      // destroy() replaces this.doc with a fresh WSSharedDoc. WSSharedDoc's
      // constructor builds a y-protocols Awareness, which installs a
      // repeating setInterval and a `doc.on('destroy', ...)` listener that
      // stay alive until the Yjs document itself is destroyed. If the old
      // doc is merely dropped (`this.doc = new WSSharedDoc()`) instead of
      // destroyed first, that interval and listener leak for the rest of
      // this Durable Object's lifetime -- once per room destruction.
      //
      // Y.Doc.destroy() sets `isDestroyed = true` and emits 'destroy',
      // which is what Awareness listens for to clear its own interval (see
      // node_modules/.pnpm/y-protocols@*/node_modules/y-protocols/awareness.js,
      // lines 78-88: `doc.on('destroy', () => this.destroy())`, and
      // `destroy()` calls `clearInterval(this._checkInterval)`). isDestroyed
      // is the only state destroy() leaves behind that a test can observe
      // directly -- the timer/listener cleanup itself isn't inspectable
      // from here.
      expect(oldDoc.isDestroyed).toBe(true);
      expect(instance.doc).not.toBe(oldDoc);
      expect(instance.doc.isDestroyed).toBe(false);
    });
  });

  it("drains the persistence queue before deleting so a slow write cannot resurrect data after destroy", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const client = await instance.createRoom("room1");

      // Delay storeUpdate so it is still in flight (queued on `this.persist`)
      // when destroy() starts running -- the same hazard a real slow SQLite
      // write could hit, made deterministic here.
      const originalStoreUpdate = instance.storage.storeUpdate.bind(
        instance.storage,
      );
      instance.storage.storeUpdate = async (update: Uint8Array) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await originalStoreUpdate(update);
      };

      const message = createSyncMessage(createYDocMessage("late"));
      // Deliberately not awaited: doc.update() runs synchronously inside
      // this call and enqueues the delayed write onto `this.persist` before
      // this line returns, but the write itself is still pending.
      const pending = instance.webSocketMessage(
        client,
        message.slice(0).buffer,
      );

      // destroy() must await the same persist queue before deleting, or the
      // delayed write above would land after DELETE FROM updates and
      // resurrect an orphan row.
      await instance.destroy();
      await pending;

      expect(await instance.storage.getUpdate()).toBeNull();
    });
  });

  it("keeps registering the remaining sockets when an earlier one throws on the hibernation-wake path", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(
      stub,
      async (instance: InternalYDurableObject, state: DurableObjectState) => {
        // Simulate what onStart() sees on a real hibernation wake: sockets
        // already accepted by the runtime (state.getWebSockets()), with the
        // in-memory SessionRegistry empty because this process never
        // registered them. Accept two: the loop must not let the first
        // socket's failure stop it from reaching the second.
        const brokenPair = new WebSocketPair();
        const brokenServer = brokenPair[1];
        brokenServer.serializeAttachment({
          roomId: "room1",
          connectedAt: 0,
          clientIds: [],
        });
        state.acceptWebSocket(brokenServer);

        const healthyPair = new WebSocketPair();
        const healthyServer = healthyPair[1];
        healthyServer.serializeAttachment({
          roomId: "room1",
          connectedAt: 0,
          clientIds: [],
        });
        state.acceptWebSocket(healthyServer);

        // registerWebSocket() -> setupWSConnection() -> ws.send(). Simulate
        // the socket workerd hands back already dead, the way it can on
        // hibernation wake.
        brokenServer.send = () => {
          throw new Error("simulated dead socket on hibernation wake");
        };

        expect(instance.sessions.has(healthyServer)).toBe(false);

        // onStart() is what a real cold start / hibernation wake runs.
        await expect(instance.onStart()).resolves.toBeUndefined();

        // The broken socket's registration failure must not have stopped
        // the loop before it reached the socket after it.
        expect(instance.sessions.has(healthyServer)).toBe(true);
      },
    );
  });

  it("restores session ownership from a socket's attachment when onStart() re-registers it", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(
      stub,
      async (instance: InternalYDurableObject, state: DurableObjectState) => {
        // Simulate what a real hibernation wake leaves behind: a WebSocket
        // that state.getWebSockets() already returns, carrying a
        // SessionAttachment with clientIds recorded by a prior connection,
        // but with the in-memory SessionRegistry never having seen it in
        // this process (it never called sessions.add() for it before now).
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment({
          roomId: "room1",
          connectedAt: 0,
          clientIds: [42],
        });
        state.acceptWebSocket(server);

        expect(instance.sessions.has(server)).toBe(false);

        // onStart() is the actual reconstruction path a cold start /
        // hibernation wake runs -- not a stand-in for it. Real hibernation
        // cannot be forced in this test environment, so this drives the
        // genuine code path instead of faking eviction/restart.
        await instance.onStart();

        expect(instance.sessions.has(server)).toBe(true);
        expect(instance.sessions.clientIdsOf(server)).toEqual([42]);
      },
    );
  });

  it("still destroys storage when one socket's close() throws", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId();
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.createRoom("room1");
      await instance.createRoom("room1");
      const [troublesome] = Array.from(instance.sessions.sockets());

      // Same workerd hazard as onPersistFailure: close() on an
      // already-closed/errored socket throws. destroy()'s per-socket
      // try/catch must contain it so storage.destroy() is still reached —
      // otherwise the caller is told the room was destroyed while its data
      // is still on disk.
      troublesome.close = () => {
        throw new Error("already closed");
      };

      await instance.updateYDoc(createYDocMessage("bye").slice(0));

      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(await instance.storage.getUpdate()).toBeNull();
    });
  });
});
