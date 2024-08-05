import { Hono } from "hono";

type Service = {
  createRoom(roomId: string): Promise<WebSocket> | WebSocket;
};

export const createApp = (service: Service) => {
  const app = new Hono();

  return app.get("/rooms/:roomId", async (c) => {
    const roomId = c.req.param("roomId");
    const client = await service.createRoom(roomId);

    return new Response(null, {
      webSocket: client,
      status: 101,
      statusText: "Switching Protocols",
    });
  });
};
