import type { WSSharedDoc } from "./remote";
import type { SessionRegistry } from "./session";
import type { YSqliteStorage } from "./storage";

export interface InternalYDurableObject {
  // private state
  doc: WSSharedDoc;
  storage: YSqliteStorage;
  sessions: SessionRegistry;

  // private api

  onStart(): Promise<void>;
  createRoom(roomId: string): WebSocket;

  registerWebSocket(ws: WebSocket): void;
  unregisterWebSocket(ws: WebSocket): Promise<void>;
  cleanup(): Promise<void>;

  // public api
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketError(ws: WebSocket): Promise<void>;
  webSocketClose(ws: WebSocket): Promise<void>;

  getYDoc(): Promise<Uint8Array>;
  updateYDoc(update: Uint8Array): Promise<void>;
  destroy(): Promise<void>;
}
