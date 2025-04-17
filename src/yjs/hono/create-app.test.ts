import { Hono } from "hono";
import { vi } from "vitest";

import { createApp } from ".";

type Service = {
  createRoom(roomId: string): Promise<WebSocket> | WebSocket;
};

describe("Room Creation API", () => {
  let app: Hono;
  let service: Service;

  beforeEach(() => {
    service = {
      createRoom: vi.fn(),
    };
    app = createApp(service);
  });

  it("should initialize correctly", () => {
    expect(app).toBeInstanceOf(Hono);
  });

  it("should create a room and establish a WebSocket connection", async () => {
    const mockWebSocket = new WebSocket("ws://example.com");
    service.createRoom = vi.fn().mockResolvedValue(mockWebSocket);

    const response = await app.request("http://localhost/rooms/testRoom", {
      headers: {
        Upgrade: "websocket",
      },
    });

    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(mockWebSocket);
    expect(service.createRoom).toHaveBeenCalledWith("testRoom");
  });

  it("should handle createRoom error correctly", async () => {
    service.createRoom = vi.fn().mockRejectedValue(new Error("Service Error"));

    const response = await app.request("http://localhost/rooms/testRoom", {
      headers: {
        Upgrade: "websocket",
      },
    });

    expect(response.status).toBe(500);
    expect(service.createRoom).toHaveBeenCalledWith("testRoom");
  });
});
