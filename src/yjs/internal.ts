import type { WSSharedDoc } from "./remote";
import type { YTransactionStorageImpl } from "./storage";
import type { DurableObject } from "cloudflare:workers";

export interface InternalYDurableObject extends DurableObject {
  doc: WSSharedDoc;
  storage: YTransactionStorageImpl;
  sessions: Map<WebSocket, () => void>;
  awarenessClients: Set<number>;

  onStart(): Promise<void>;
  createRoom(roomId: string): WebSocket;
  getYDoc(): Promise<Uint8Array>;
  updateYDoc(update: Uint8Array): Promise<void>;

  registerWebSocket(ws: WebSocket): void;
  unregisterWebSocket(ws: WebSocket): void;
  cleanup(): void;
}
