# Implementation and validation report

Validated on 2026-11-13 as UID 1000. Nothing was activated in the live VS Code installation. Its entry SHA-256 remains `7028a46ab84bc5b0effeb7b6781b1f1375f1762c18de089b74a3d9f8cc742224`; `status --live` identified the existing fileWatcher as original and auto-enable as false. No devcontainer/Dockerfile, service, mount, database or kernel setting was edited.

## Delivered

Rust inotify reactor, bounded callback delivery, shared physical directory watches, cancellation/cleanup, filtered scopes, real atomic snapshots, public CJS/ESM adapter and declarations, verified release staging, reversible CLI, compatibility profile, config/schema, generated-fixture tests, benchmark/stress harnesses, opt-in attach integration and manual Dockerfile/devcontainer merge instructions.

## Commands actually run

```bash
npm ci
npm run build
npm run package
npm run lint
npm test
npm run test:stress
npm run --silent bench
bash -n integrations/devcontainer/on-attach.sh
bash integrations/devcontainer/on-attach.sh
node bin/watcherctl.cjs discover --json
node bin/watcherctl.cjs status --server-root /vscode/vscode-server/bin/linux-x64/69047191fc427f2f92828279aae1d90d8eeda7ab --live
trs audit-docs
```

- Clean `npm ci` completed and npm reported zero vulnerabilities. The initial shell was Node 26 and emitted an engine warning; npm scripts use the pinned local Node 24.22.3. Build and tests also loaded the addon using VS Code Server's independent Node 24.22.1, Node-API 10.
- `lint` passed StandardJS, Rust formatting and Clippy for all targets with warnings denied.
- `npm test`: **2 Rust tests passed; 46 JavaScript tests passed, 0 failed, 1 opt-in stress test skipped** (47 JS cases total).
- `npm run test:stress`: **2 passed, 0 skipped**, including the normally skipped 100-cycle fixture soak.
- Selected-server Node smoke tests passed CJS package-root imports, exact bare default/named ESM imports, create/update/rename/delete delivery, effective production-style restricted policy and snapshot round trips in temporary fake installations.
- Installer tests covered existing installs, interrupted phases, missing/tampered state, immutable-release checksums, unknown modifications, changed package/bundle versions, native/configuration fallback, restoration, opt-in removal, multiple active candidates, concurrent real CLI installations, stale locks, live mappings/start identity, and attach build failure. Only fake server packages were patched.
- Image tests extracted the binary package with no source/Cargo/build script in it and `PATH=/nonexistent`, then installed, verified and restored using the selected server Node. A separate fake server with a copied actual Node executable verified `NODE_OPTIONS` activation before its first ESM Parcel import, persistent opt-out after package re-extraction, and stock behavior on an unsupported update. No runtime npm install or Cargo build ran.
- Engine tests covered atomic saves, directory moves/populated arrivals, root deletion/recreation, overlap/filter independence, pruning counts, all-excluded traversal, churn, Unicode/dotfiles, symlinks/cycles, malformed options, permissions, non-UTF-8 failure, cancellation/self-unsubscribe, active worker destruction, startup/snapshot teardown, queue backpressure and final-state overflow reconciliation. A 300-cycle regression checks shutdown and descriptor release.
- `audit-docs` found no on-disk agent instruction files in this repository. The supplied chat instructions were followed.

Watch-limit ENOSPC/EMFILE and EACCES registration failures were injected at the native syscall boundary in a unit test. Kernel overflow recovery was injected through the same reconciliation path as IN_Q_OVERFLOW. The userspace queue overflow test creates real backpressure with slow JS callbacks and verifies final creates.

## Small generated-fixture benchmark

One run, same selected server Node, same generated root, 200 directories with files, compatible scope, identical eight exclusions, 300 ms warmup, 1500 ms idle interval, and 100 paced creates. The fixture is in `/tmp`, not the reported projects bind mount. Stock and Rust run in separate processes. Raw CPU/user/system/wall/RSS/count/latency data: [bench-small.json](results/bench-small.json).

| Backend | Subscription startup ms | Idle one-core CPU | Idle RSS MiB | Threads | Processes | Watches | Create p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| stock | 11.57 | 0.0147% | 48.60 | 13 | 1 | 201 | 352.98 |
| rust | 8.49 | 0.0101% | 54.47 | 12 | 1 | 202 | 41.36 |

Measured at `2026-11-13T10:47:29.402Z`, using `/vscode/vscode-server/bin/linux-x64/69047191fc427f2f92828279aae1d90d8eeda7ab/node` (Node 24.22.1). Rust has one additional non-recursive parent watch for root recreation. Stock queued-event/rescan counters are unavailable and are recorded as null. Latency reflects different batching policies, including Rust's 40 ms batch window. These single-run small-fixture numbers are not a large-workspace speedup or memory claim; Rust's total process RSS was higher in this sample. Below 1% idle CPU is an engineering target, met here by both backends.

[stress.tap](results/stress.tap) records 100 subscribe/unsubscribe cycles on 2000 directories with files. Sampled process RSS was 79237120 bytes at cycle 0 and 79892480 bytes at cycle 90. This short run is not evidence of zero long-term memory growth.

## Not performed / remaining operational verification

No live patch, reload/reconnect, VS Code Explorer/editor UI verification, actual Docker rebuild/attach, real-project performance scan, 10,000-directory optional benchmark, multi-hour soak, host watch-limit saturation or forced kernel queue saturation was performed. No profiling privileges were requested. Native crashes cannot be caught by a JS fallback.

Negative extglobs/negated globs and other unsupported matcher constructs are rejected rather than guessed. Non-UTF-8 names stop a request. Removal/movement of a root's parent sentinel requires re-subscription. Native/configuration startup fallback is explicitly degraded and does not enforce the restricted Rust policy. These limits are detailed in [compatibility](compatibility.md) and [architecture](architecture.md).

## Manual activation, reapply and restore

The preferred source-independent workflow is [image installation](image-installation.md). Copy the generated binary archive into the Docker build context and apply the image Dockerfile/devcontainer snippets. It opts in on the first supported VS Code startup, while `restore --all --disable-auto` persists across subsequent image rebuilds. The source folder is unnecessary after the archive is copied. The commands below remain available for source-based manual installation.

Exact Dockerfile/devcontainer fields and all build/install/verify/live/reapply commands are in [installation](installation.md). The shorter manual-only option omits `--enable-auto` and needs no attach hook. The supplied fragment preserves your current container configuration.

```bash
node bin/watcherctl.cjs discover --json
node bin/watcherctl.cjs install --server-root "$SERVER" --config "$PWD/config/devcontainer.json" --enable-auto
node bin/watcherctl.cjs verify --server-root "$SERVER"
# Reload Window or reconnect, then check the actual fileWatcher process:
node bin/watcherctl.cjs status --server-root "$SERVER" --live
# After rebuild/update, rediscover SERVER and repeat install/verify only if supported.
node bin/watcherctl.cjs restore --all --disable-auto
```

Set `SERVER` from discovery as documented. After either activation or restoration, reload/reconnect and observe external edits in VS Code. Unknown updates remain stock until their compatibility profile is audited.

## Server-permission follow-up

The rebuilt live container exposed a root-owned mode-755 Parcel package directory on the server volume. The installer now checks directory write/execute access before backups/patching, with the same actionable check for restoration. Build, packaging, lint and all 13 targeted installer tests passed, including a read-only-directory regression. No live ownership or watcher installation was changed. See [server directory permissions](image-installation.md#server-directory-permissions) for the one-directory administrator setup. New server installations may need that setup again.

## Automatic ownership opt-in

`RUST_WATCHER_FIX_PERMISSIONS=1` now permits a noninteractive, nonrecursive sudo chown of the validated root-owned Parcel package directory. Build, packaging, lint and all 14 targeted installer tests passed. The new test mocks root ownership and sudo to verify the exact command, explicit opt-in, no recursive change and failure without authorization. Read-only inspection confirmed that this container already grants vscode passwordless sudo. No live ownership change or activation was performed. Replace the image archive and merge the new containerEnv setting before rebuilding.

## Large-project tracking and root environment override

The deployed policy was confirmed to clip `/workspaces` to `/workspaces/mounted/projects`; its failure was the fixed 1,000,000-entry/work cap. A read-only directory count found about 1.76 million non-excluded entries across 114 project directories. The large log-widget output/backup trees were confirmed against the generator and improvement scripts in btcwid. Following the user’s selection, the supplied policy now excludes those precise generated groups/backups while retaining source scripts and mappings. No files were deleted or live package/config files changed.

`maxTrackedEntries` is configurable from 1 to 10,000,000 (compatible default 1,000,000; supplied projects policy 3,000,000). Tracked metadata and traversal work are bounded separately. Traversal is depth-first, filters are applied before queuing children, and limits are enforced on events after readiness as well as initial scans and snapshots. Diagnostics include effective roots and cap/counter context.

`RUST_WATCHER_ROOT` forces restricted mode for one normalized absolute root, retaining ignores and resource limits. Tests verify precedence over compatible configuration, rejection of invalid roots, preservation of configured missing-file errors, and native traversal/delivery clipping before unreadable siblings are visited. Updated root environment and tracking features require the new image archive.

Build, lint, the full 2 Rust / 46-passing JavaScript suite (1 opt-in case skipped), and both dedicated stress cases passed. New regressions cover exact-limit startup with bounded directory iterators, growth beyond the cap after readiness, snapshots, generated-tree policy boundaries and the root environment override.

[projects-startup.json](results/projects-startup.json) records a separate read-only subscription using the new projects policy: a `/workspaces` request initialized successfully with 392,881 tracked entries, 22,564 physical watches and peak pending work of 21. Startup was 7.73 seconds and process RSS about 270 MiB. The short 1.5-second post-start sample measured 1.25% of one CPU, above the sub-1% engineering target; this is not a steady-state or stock-versus-Rust comparison. The new exclusions substantially change the workload. Live VS Code activation of this rebuilt archive and UI behavior remain unverified.
