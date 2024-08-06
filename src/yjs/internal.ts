import type { WSSharedDoc } from "./remote";
import type { YTransactionStorageImpl } from "./storage";

export interface InternalYDurableObject {
  // private state
  doc: WSSharedDoc;
  storage: YTransactionStorageImpl;
  sessions: Map<WebSocket, () => void>;
  awarenessClients: Set<number>;

  // private api

  onStart(): Promise<void>;
  createRoom(roomId: string): WebSocket;

  registerWebSocket(ws: WebSocket): void;
  unregisterWebSocket(ws: WebSocket): void;
  cleanup(): void;

  // public api
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
  webSocketError(ws: WebSocket): void;
  webSocketClose(ws: WebSocket): void;

  getYDoc(): Promise<Uint8Array>;
  updateYDoc(update: Uint8Array): Promise<void>;
}
