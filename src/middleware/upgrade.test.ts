import { Hono } from "hono";

import { upgrade } from ".";

describe("Upgrade Middleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.get("/", upgrade(), (c) => c.text("WebSocket connection established"));
  });

  it("returns status 426 when Upgrade header is not websocket", async () => {
    const req = new Request("http://localhost/", {
      headers: { Upgrade: "non-websocket" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(426);
    expect(await res.text()).toBe("Expected websocket");
  });

  it("passes to the next middleware when Upgrade header is websocket", async () => {
    const req = new Request("http://localhost/", {
      headers: { Upgrade: "websocket" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("WebSocket connection established");
  });
});
