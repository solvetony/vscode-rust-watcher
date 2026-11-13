# Architecture and operating limits

## Integration boundary

The small package-entry shim preserves named exports explicitly and loads an immutable runtime release, never a source-tree symlink. It exports the public Promise API, error-first event callback and subscription handle. An untouched `.rust-watcher-original-index.cjs` stays in the original package directory so relative `./wrapper` and native-module resolution remain valid. Initialization failure can use that original with a prominent fallback diagnostic. JavaScript cannot catch a native process crash.

The adapter validates configuration and request options, clips scopes and compiles picomatch globs on the JS thread. It does no recursive traversal there. All paths delivered to JavaScript are absolute UTF-8 paths. Compatible requests resolve root symlinks. Restricted roots undergo component checks and reject symlink ancestors; child symlinks are never followed in either mode.

## Reactor and ownership

A missing/invalid explicit policy is rejected by the adapter and installer. If configuration or native initialization fails during a later installed-server startup, the loader prominently reports degraded stock fallback with `policyEnforced: false` and a null effective-policy health field. This preserves editor availability without pretending the restricted policy is active.

Each Node environment has one dedicated reactor and one nonblocking inotify descriptor. It blocks in `poll`, with a Unix socket wakeup for commands, cancellation and shutdown. Directories have physical watches with logical owner sets; overlapping subscriptions independently maintain filters and state. Releasing an owner removes a kernel watch only after its final owner leaves. Every active subscription can add one non-recursive parent sentinel per effective root for root recreation; no unrelated parent children are scanned.

Traversal work consists of path visits and resumable directory iterators, at most 128 work steps per subscription per reactor iteration. A directory watch is installed before enumerating its contents. Inotify records are drained between work slices, reconciling creations, deletes and moves during initialization. Readiness establishes the initial state only after traversal and a drained kernel pass. Transient child ENOENT/ENOTDIR is local; missing requested roots and EACCES/ENOSPC/EMFILE are terminal and informative. No retry storm or normal periodic rescan is used.

Moves are represented as delete/create events. Removed directory subtrees release path mappings and physical ownership; arriving or populated directories are scanned incrementally with fresh paths. Paths are fixed requests, so root deletion/recreation keeps monitoring the original location. Deleting a root's parent sentinel is an operating limitation: reconnect/re-subscribe if the entire ancestor containing the requested root is removed or moved. The adapter is not a filesystem security sandbox and cannot close arbitrary concurrent path-replacement races.

Thread-safe function delivery has capacity one. Rust maintains bounded dirty paths and coalescing flags, with at most `maxBatchSize` events delivered per acknowledged callback. Callback acknowledgement uses a separate atomic flag, so a full command queue cannot swallow it. A batch window starts with the first pending event (`debounceMs`); continuous churn does not postpone delivery indefinitely.

Unsubscribe immediately closes its JS delivery gate and sets native cancellation. Returning from a callback that unsubscribes itself requires no JS-thread work from the reactor. Environment cleanup signals shutdown, wakes the reactor and joins it. Shutdown is checked immediately before blocking to prevent a consumed wakeup race. Explicit close releases the native channel and socket without waiting for JS garbage collection.

## Bounds and overflow

There are at most 1024 logical subscriptions per environment and 1024 queued commands. `maxTrackedEntries` independently bounds retained metadata entries and pending traversal work per subscription: default 1,000,000, supplied projects policy 3,000,000, accepted range 1-10,000,000. These limits apply during initialization, subsequent events and snapshots. Depth-first traversal and pruning before queuing children keep pending directory iterators proportional to depth rather than tree width. Each filter regex has a 2 MiB compiled-size limit. Queues and snapshots have explicit size checks, including a separate 512 MiB snapshot-file bound. These caps are failure boundaries, not recommended workloads or memory promises. Logical subscribers keep separate current/delivered metadata maps even when their physical watches are shared. Diagnostics expose tracked entries, pending work and peak per-subscription pending work; limit errors include the configured cap and effective roots.

If dirty-path bookkeeping exceeds `maxQueuedEvents`, it switches to a current-versus-delivered final-state diff. The complete current state is still maintained from kernel events. If the **kernel** overflows, all affected subscriptions drop physical ownership, reinstall watches and incrementally rescan, diffing against the last delivered state, including missed deletes. These exceptional resets can release up to the configured hard entry/watch cap before the incremental scan. No rename-cookie cache grows without bound.

Both cases emit a rate-limited overflow diagnostic. Transient create/delete history cannot be reconstructed; eventual final-state consistency is the recovery guarantee after the input settles. An unsuccessful reconciliation reports an error and stops the affected subscription. The recovery command used by tests exercises the same reconciliation path as `IN_Q_OVERFLOW`; tests do not change host sysctls to force kernel loss.

## Snapshots

Finite napi-rs `AsyncTask`s scan and query off the JS thread. They share scope/filter logic and check cancellation during traversal, directory enumeration and before atomic commit. Environment teardown sets their cancellation flag. The standard Parcel API has no per-operation AbortSignal; cancellation occurs through owning environment destruction.

Metadata records type, device/inode, size, mode, nanosecond mtime and ctime. The file begins with Parcel 2.5.6's count/length/path/mtime/type records, followed by a versioned Rust trailer containing root/policy identity and a SHA-256-checked payload. Queries validate the prefix against the checked entries, limits, path containment, version and policy. Snapshot writes use a unique mode-0600 temporary file, fsync, same-directory rename and parent fsync.

Stock Parcel can read the prefix and ignores the Rust trailer. Rust rejects stock-only snapshots rather than returning empty changes. The inspected VS Code polling loop writes before its first query, and rewrites after a caught query error on subsequent iterations. Tests cover both the cross-process stock reader and that startup order. No unrelated VS Code caches are deleted.

## Diagnostics

Structured requested/effective-root, readiness, pruning/count, initialization, error, overflow and fallback records go outside the watched tree. Logs rotate around 2 MiB with one prior file and per-kind one-second rate limits. Health files identify PID, `/proc` process-start ticks, thread, server, build, backend and effective policy; subsequent initialization removes bounded batches of stale process records.

`status --live` checks readable process mappings together with matching current-process records. Disk state and process state are reported separately. It does not infer zero watches from permission failures. `doctor` reads inotify limits but changes no kernel setting. No file contents, complete environments, telemetry or network diagnostics endpoint are logged.

References: [inotify semantics](https://man7.org/linux/man-pages/man7/inotify.7.html), [Node-API lifecycle](https://nodejs.org/api/n-api.html), [napi-rs thread-safe functions](https://napi.rs/docs/concepts/threadsafe-function).
