import { describe, expect, it, vi } from "vitest";

import { SessionRegistry } from ".";

import type { SessionAttachment } from ".";

const fakeSocket = (attachment: SessionAttachment | null): WebSocket => {
  let current = attachment;

  return {
    serializeAttachment: (value: SessionAttachment) => {
      current = value;
    },
    deserializeAttachment: () => current,
  } as unknown as WebSocket;
};

const attachment = (clientIds: number[]): SessionAttachment => ({
  roomId: "room1",
  connectedAt: 0,
  clientIds,
});

describe("SessionRegistry", () => {
  it("tracks and disposes sockets", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([]));
    const dispose = vi.fn();

    registry.add(ws, dispose);
    expect(registry.size).toBe(1);
    expect(registry.has(ws)).toBe(true);

    registry.remove(ws);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("records client ids on the attachment", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([]));
    registry.add(ws, () => {});

    registry.track(ws, [7]);

    expect(registry.clientIdsOf(ws)).toEqual([7]);
  });

  it("does not duplicate client ids", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(attachment([7]));
    registry.add(ws, () => {});

    registry.track(ws, [7, 8]);
    registry.track(ws, [8]);

    expect(registry.clientIdsOf(ws).sort()).toEqual([7, 8]);
  });

  it("reads clientIds from the attachment already present when add() is called", () => {
    // This only exercises SessionRegistry in isolation: add() with a socket
    // whose attachment already carries clientIds, on a registry that never
    // called track() itself. It does NOT drive state.getWebSockets() or
    // onStart()'s reconstruction loop, so it does not cover hibernation
    // wake-up -- see "restores session ownership from a socket's attachment
    // when onStart() re-registers it" in src/e2e/y-durableobjects.test.ts
    // for that path. Real hibernation cannot be forced in this test
    // environment, so that test drives the actual onStart() code path
    // instead of faking eviction/restart.
    const ws = fakeSocket(attachment([42]));
    const registry = new SessionRegistry();
    registry.add(ws, () => {});

    expect(registry.clientIdsOf(ws)).toEqual([42]);
  });

  it("returns an empty list for a socket without a valid attachment", () => {
    const registry = new SessionRegistry();
    const ws = fakeSocket(null);
    registry.add(ws, () => {});

    expect(registry.clientIdsOf(ws)).toEqual([]);
  });

  it("makes ownership of a reused client id exclusive between sockets", () => {
    // Simulates an overlapping reconnect: the same awareness clientID (the
    // Yjs Doc survives socket reconnects, so this can genuinely happen) is
    // published by an old socket and then by its replacement. Ownership
    // must move to the new socket, not be shared by both -- otherwise
    // closing the old socket later removes awareness state the new socket
    // is still using.
    const registry = new SessionRegistry();
    const oldWs = fakeSocket(attachment([]));
    const newWs = fakeSocket(attachment([]));
    registry.add(oldWs, () => {});
    registry.add(newWs, () => {});

    registry.track(oldWs, [7]);
    expect(registry.clientIdsOf(oldWs)).toEqual([7]);

    registry.track(newWs, [7]);

    expect(registry.clientIdsOf(oldWs)).toEqual([]);
    expect(registry.clientIdsOf(newWs)).toEqual([7]);
  });

  it("does not remove a reclaimed client id when its former socket closes", () => {
    const registry = new SessionRegistry();
    const oldWs = fakeSocket(attachment([]));
    const newWs = fakeSocket(attachment([]));
    const oldDispose = vi.fn();
    registry.add(oldWs, oldDispose);
    registry.add(newWs, () => {});

    registry.track(oldWs, [7]);
    registry.track(newWs, [7]);

    registry.remove(oldWs);

    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(registry.clientIdsOf(newWs)).toEqual([7]);
  });
});
