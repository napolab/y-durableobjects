import { SELF, env, runInDurableObject } from "cloudflare:test";
import { hc } from "hono/client";
import { fromUint8Array } from "js-base64";

import { createSyncMessage, createYDocMessage } from "./helper";

import type { AppType } from ".";
import type { InternalYDurableObject } from "../yjs/internal";

describe("yRoute Shorthand", () => {
  it("should return a route", async () => {
    const res = await SELF.fetch("http://localhost/shorthand/1", {
      headers: {
        Upgrade: "websocket",
      },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeInstanceOf(WebSocket);
  });

  it("should return status 426 if no headers are present", async () => {
    const res = await SELF.fetch("http://localhost/shorthand/1");
    expect(res.status).toBe(426);
    await expect(res.text()).resolves.toBe("Expected websocket");
  });

  it("should verify the typing of the shorthand route", () => {
    const client = hc<AppType>("http://localhost", {
      fetch: SELF.fetch.bind(SELF),
    });

    expectTypeOf(client.shorthand[":id"].$ws).toEqualTypeOf<
      (args?: { param: { id: string } } | undefined) => WebSocket
    >();
  });
});

describe("endpoint request", () => {
  it("should return a WebSocket response", async () => {
    const res = await SELF.fetch("http://localhost/rooms/1", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeInstanceOf(WebSocket);
  });

  it("should return status 426 if no headers are present", async () => {
    const res = await SELF.fetch("http://localhost/rooms/1");
    expect(res.status).toBe(426);
    await expect(res.text()).resolves.toBe("Expected websocket");
  });

  it("should get the YDoc state", async () => {
    const roomId = "1";
    const id = env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = env.Y_DURABLE_OBJECTS.get(id);
    const message = createYDocMessage("get state");
    const update = createSyncMessage(message);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      await instance.updateYDoc(update);
    });

    const res = await SELF.fetch(`http://localhost/rooms/${roomId}/state`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ doc: fromUint8Array(message) });
  });

  it("should update the YDoc state", async () => {
    const message = createYDocMessage("get state");
    const update = createSyncMessage(message);

    const roomId = "1";
    const id = env.Y_DURABLE_OBJECTS.idFromName(roomId);
    const stub = env.Y_DURABLE_OBJECTS.get(id);

    const res = await SELF.fetch(`http://localhost/rooms/${roomId}/update`, {
      method: "POST",
      body: update.buffer,
    });
    expect(res.status).toBe(200);

    await runInDurableObject(stub, async (instance: InternalYDurableObject) => {
      const state = await instance.getYDoc();
      expect(state).toEqual(message);
    });
  });
});
