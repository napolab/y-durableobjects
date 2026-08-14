export type SessionAttachment = {
  roomId: string;
  /** epoch ミリ秒。attachment は structured clone されるが、数値の方が扱いが単純 */
  connectedAt: number;
  /** この接続が所有する awareness の clientID */
  clientIds: number[];
};

const isSessionAttachment = (value: unknown): value is SessionAttachment => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.roomId === "string" &&
    typeof candidate.connectedAt === "number" &&
    Array.isArray(candidate.clientIds) &&
    candidate.clientIds.every((id) => typeof id === "number")
  );
};

/**
 * WebSocket と awareness の所有権を管理する。
 *
 * 所有権は WebSocket の attachment に永続化するため、Durable Object が
 * hibernation から復帰してメモリ上の状態を失っても復元できる。
 */
export class SessionRegistry {
  private disposers = new Map<WebSocket, () => void>();

  get size(): number {
    return this.disposers.size;
  }

  add(ws: WebSocket, dispose: () => void): void {
    this.disposers.set(ws, dispose);
  }

  remove(ws: WebSocket): void {
    this.disposers.get(ws)?.();
    this.disposers.delete(ws);
  }

  has(ws: WebSocket): boolean {
    return this.disposers.has(ws);
  }

  sockets(): IterableIterator<WebSocket> {
    return this.disposers.keys();
  }

  clientIdsOf(ws: WebSocket): number[] {
    return this.attachmentOf(ws)?.clientIds ?? [];
  }

  /**
   * この接続が所有する clientID を記録する。
   * 実際に増えたときだけ attachment を書き直すので、通常は接続あたり 1 回で済む。
   */
  track(ws: WebSocket, clientIds: readonly number[]): void {
    const current = this.attachmentOf(ws);
    if (current === null) return;

    const merged = new Set([...current.clientIds, ...clientIds]);
    if (merged.size === current.clientIds.length) return;

    ws.serializeAttachment({
      ...current,
      clientIds: Array.from(merged),
    } satisfies SessionAttachment);
  }

  private attachmentOf(ws: WebSocket): SessionAttachment | null {
    const raw: unknown = ws.deserializeAttachment();

    return isSessionAttachment(raw) ? raw : null;
  }
}
