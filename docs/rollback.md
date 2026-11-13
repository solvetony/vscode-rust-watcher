# Rollback

Run as the same user, with the same `RUST_WATCHER_STATE` override if one was used:

```bash
cd /workspaces/mounted/projects/vscode-rust-watcher
node bin/watcherctl.cjs restore --all --disable-auto
```

The command removes the persistent auto marker, writes `auto-disabled.json` under the installer lock, verifies every external original backup, and atomically restores known patched entry points. The disabled marker prevents both the image preload and attach hook from re-enabling the watcher after a rebuild. Explicit `install --enable-auto` clears it after successful verification. Unknown entry modifications or damaged backups stop restoration rather than overwriting them. Absent server trees keep their backups. Keep the state directory until recovery succeeds.

Reload every attached window or disconnect/reconnect. Already-running processes keep their loaded module after disk restoration. Check both disk and live process states:

```bash
node bin/watcherctl.cjs status --live
```

Expected disk state is `original package on disk`; a still-running Rust process means reconnect is still needed. A dead process's health record never proves activation because its PID/start identity must match a readable current process.

`RUST_WATCHER_DISABLE=1` is an emergency **startup** bypass to the untouched original module. It must reach a newly started server process; setting it in a terminal does not change an existing server's environment. Bypass and initialization fallback are prominently diagnosed and reported as original/degraded, not healthy Rust operation. Persistent restoration is the primary recovery path.

If manifests/state are missing, the installer refuses an unrecognized shim. Do not delete the adjacent `.rust-watcher-original-index.cjs`; its location preserves baseline relative module resolution. Preserve all surviving backups and use `doctor` plus the documented fingerprints to investigate. Do not overwrite an unknown modified package or delete unrelated VS Code caches. Reinstalling a clean supported VS Code Server is preferable to guessing at damaged native files.

Native crashes cannot be caught by the JS fallback. Reload/reconnect and rollback are still necessary after such a failure. No recovery command kills unrelated Node processes, containers, or database services.

If an installed startup falls back because its explicit configuration is missing or invalid, its diagnostics report the error and `policyEnforced: false`; health records show no effective restricted policy. Repair the configuration or restore persistently. It is never reported as healthy unrestricted Rust operation.
