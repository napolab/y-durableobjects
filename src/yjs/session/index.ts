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
   *
   * 所有権は排他的にする。overlapping reconnect（Yjs の Doc がソケットの
   * 再接続を跨いで生き残るケース）では、同じ awareness clientID が旧ソケット
   * と新ソケットの両方から送られてくることがある。ここで他のソケットから
   * 剥奪しておかないと、旧ソケットが後で閉じたときに
   * unregisterWebSocket() が新ソケットも使っている awareness state を
   * 消してしまい、他の参加者には再接続したユーザーが消えたように見える。
   */
  track(ws: WebSocket, clientIds: readonly number[]): void {
    const current = this.attachmentOf(ws);
    if (current === null) return;

    for (const other of this.disposers.keys()) {
      if (other === ws) continue;

      const otherAttachment = this.attachmentOf(other);
      if (otherAttachment === null) continue;

      const remaining = otherAttachment.clientIds.filter(
        (id) => !clientIds.includes(id),
      );
      if (remaining.length === otherAttachment.clientIds.length) continue;

      other.serializeAttachment({
        ...otherAttachment,
        clientIds: remaining,
      } satisfies SessionAttachment);
    }

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
