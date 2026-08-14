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

  it("restores ownership from an existing attachment after hibernation", () => {
    // hibernation 復帰を模す。registry は空だが WebSocket の attachment は残っている
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
});
