# Contract: the storage abstraction

`apps/api/src/storage/` (research #10, #11). Used by the API (put, delete) and the worker (get, delete, list).

```ts
interface Storage {
  /** Stores the bytes under the key, replacing nothing: keys are fresh UUIDs. Throws StorageUnavailable. */
  put(key: OriginalKey, bytes: Uint8Array): Promise<void>;
  /** The bytes, or throws StorageUnavailable (including when the key is missing). */
  get(key: OriginalKey): Promise<Uint8Array>;
  /** Removes the key; succeeds when it is already gone. Throws StorageUnavailable. */
  delete(key: OriginalKey): Promise<void>;
  /** Every Scrylux key under the prefix, with its modification time. Keys of any other shape are not returned. */
  list(): AsyncIterable<{ key: OriginalKey; modifiedAt: Date }>;
}
```

- `OriginalKey` is a branded string matching `^sources/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  made only by `newOriginalKey()` or by parsing a listed key. Nothing derived from a name or a request becomes a key.
- `StorageUnavailable` carries no path, bucket, key, address or provider text in its message.
- **Local**: `<STORAGE_DIR>/sources/<uuid>`; writes to `<STORAGE_DIR>/tmp/<uuid>`, `fsync`, rename. `list()` yields
  only keys of the exact shape; the stale `tmp/` files (older than 1 hour) are removed by the optional `cleanupTemporary(olderThanMs)` that
  the local backend has and S3 does not (as built). Paths are joined from the configured root and the validated key
  only.
- **S3-compatible**: object `<STORAGE_S3_PREFIX>sources/<uuid>`; `PutObject` with `ContentLength`; `ListObjectsV2` under
  `<prefix>sources/`.

## The sweep (worker)

At start and every 10 minutes: for each listed key older than 1 hour that is not the `original_key` of a source whose
`ready_at` is null, delete it. Logged as one line with counts only: `{ "event": "storage_sweep", "listed": n, "deleted":
n, "failed": n, "temporary": n }` (as built, `temporary` counts the half-written files of the local volume that were removed).
