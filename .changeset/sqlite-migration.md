---
"y-durableobjects": major
---

Migrate to the Durable Objects SQLite storage backend and fix the defects the
key-value backend had forced.

**Breaking changes**

- Requires `new_sqlite_classes` in your wrangler migrations. A v1 namespace
  cannot be converted in place — see "Migrating from v1" in the README.
- `updateYDoc()` now takes a raw Yjs update instead of a sync-protocol message,
  so it round-trips with `getYDoc()`.
- The exported `YTransactionStorage` type is replaced by `YStorage`.
- `WSSharedDoc.notify(listener)` is now `notify(origin, listener)` and
  `WSSharedDoc.update(message)` is now `update(message, origin)`.
- `WebSocketAttachment` is replaced by `SessionAttachment`, which carries the
  connection's awareness client ids.

**Fixes**

- Documents are no longer capped at 128KiB.
- Compaction no longer exceeds the 128-key limit of `delete()`.
- Closing one connection no longer clears every participant's awareness state.
- Updates are persisted in order and awaited rather than left as floating promises.
- Sync step 2 replies go only to the requesting client instead of the whole room.
- Updates are no longer echoed back to their sender.
- A malformed binary message closes only that connection instead of resetting
  the Durable Object.
- Stored updates are restored in insertion order.

**Additions**

- `destroy()` deletes a room's data and closes its connections.
- A `"ping"` / `"pong"` auto-response keeps keepalives from waking the Durable
  Object from hibernation.
