import { Bindings, HonoEnv } from "../types";
import { Hono } from "hono";
import { upgrade } from "../middleware";
import { WSSharedDoc } from "../ws-share-doc";

export class YjsProvider implements DurableObject {
  private app = new Hono<HonoEnv>();
  private doc = new WSSharedDoc();
  private sessions = new Map<WebSocket, () => void>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings,
  ) {
    state.blockConcurrencyWhile(async () => {
      const cache = await state.storage.get<WSSharedDoc>("doc");
      console.log(this.doc instanceof WSSharedDoc, cache === this.doc, this.doc?.guid, this.doc?.clientID);

      this.doc = cache ?? this.doc;
      console.log(cache instanceof WSSharedDoc, cache === this.doc, cache?.guid, cache?.clientID);

      for (const ws of this.state.getWebSockets()) {
        const s = this.doc.subscribe((message) => {
          ws.send(message);
        });
        this.sessions.set(ws, s);
      }
    });

    this.app.get("/", upgrade, async (c) => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      const s = this.doc.subscribe((message) => {
        server.send(message);
      });
      this.sessions.set(server, s);
      console.log("new connection", this.sessions.size);

      return new Response(null, { webSocket: client, status: 101 });
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.request(request, undefined, this.env);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    try {
      this.doc.onMessage(ws, new Uint8Array(message));
    } catch (e) {
      console.error(e);
      this.doc.emit("error", [e]);
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    const dispose = this.sessions.get(ws);
    dispose?.();
    this.sessions.delete(ws);

    console.error("WebSocket error:", error);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    const dispose = this.sessions.get(ws);
    dispose?.();
    this.sessions.delete(ws);

    if (this.sessions.size < 1) {
      this.state.storage.put("doc", this.doc);
      console.log("cleanup");
    }
  }
}
