# Installation and devcontainer integration

For activation after image rebuilds **without the mounted source folder**, use [image installation](image-installation.md). The instructions below describe the optional source-based workflow.

## Build first

Use the [README build commands](../README.md#build-and-validate) as `vscode`, not root. Existing build-essential, clang, cmake, Python, pkg-config and rustup are sufficient. No privileged mode, SYS_PTRACE, seccomp change or inotify sysctl edit is required.

## Dockerfile: add one line

Immediately after the existing Rust installation, add:

```dockerfile
ENV PATH="/home/vscode/.cargo/bin:${PATH}"
```

The same line is in [Dockerfile.fragment](../integrations/devcontainer/Dockerfile.fragment). Keep existing Rust installation commands and subsequent PATH additions, including `/home/vscode/.local/bin`. The actual Dockerfile was not present in this repository, so no Dockerfile was edited.

## devcontainer.json: merge one field

If you have no existing `postAttachCommand`, add this **top-level field** to your current JSON/JSONC object:

```json
"postAttachCommand": [
  "bash",
  "/workspaces/mounted/projects/vscode-rust-watcher/integrations/devcontainer/on-attach.sh"
]
```

The snippet above is a merge, not a replacement container configuration. The separate [image merge fragment](../rust-filewatcher-devcontainer-merge.json) uses `/opt` paths for the source-independent workflow. If `postAttachCommand` already exists, retain it under a named command in an object and add the watcher as another named command:

```json
"postAttachCommand": {
  "existing": "COPY YOUR CURRENT postAttachCommand VALUE HERE",
  "rustWatcher": [
    "bash",
    "/workspaces/mounted/projects/vscode-rust-watcher/integrations/devcontainer/on-attach.sh"
  ]
}
```

Replace the placeholder with the actual existing string or array value. If the current field is already an object, simply add its `rustWatcher` property. Object commands can run concurrently; the installer lock prevents overlapping writes.

Preserve all other existing fields, especially:

- `workspaceFolder: "/workspaces/mounted/projects"`, Node feature, mounts and ports;
- extensions, zsh and terminal settings;
- `remoteEnv.PONYTAIL_DEFAULT_MODE: "lite"`;
- the **entire** existing `postCreateCommand`, including Codex, TRS, ponytail and Intent AI Ops;
- `postStartCommand: "start-dev-services"` and MongoDB/PostgreSQL/Redis setup.

No `containerEnv` entry is necessary. The loader embeds the install-time absolute configuration path. `RUST_WATCHER_CONFIG` is an optional startup override, not a prerequisite for first activation.

Optionally merge this entry into the existing `customizations.vscode.settings.files.watcherExclude` object:

```json
"**/target/**": true
```

Remove a temporary `"**": true` troubleshooting exclusion if you want normal workspace notifications. Keep your specific exclusions. The supplied restricted policy independently prunes `target` for requests routed through this adapter.

## Select and explicitly install

```bash
cd /workspaces/mounted/projects/vscode-rust-watcher
node bin/watcherctl.cjs discover --json
```

Discovery reports all bounded candidates and their observed server/fileWatcher processes. Select the relevant active installation, not the first listed candidate. In the inspected environment it was:

```bash
SERVER=/vscode/vscode-server/bin/linux-x64/69047191fc427f2f92828279aae1d90d8eeda7ab
```

Use that path **only if discovery still identifies it as your active server**. Then:

```bash
node bin/watcherctl.cjs install \
  --server-root "$SERVER" \
  --config "$PWD/config/devcontainer.json" \
  --enable-auto
node bin/watcherctl.cjs verify --server-root "$SERVER"
```

Omit `--enable-auto` for a manual-only installation. That smaller option needs no devcontainer attach hook. The initial policy allows only `/workspaces/mounted/projects`; timing and queue values are starting points, not performance guarantees.

Default state is `/workspaces/mounted/.vscode-rust-watcher`, outside the projects tree. `RUST_WATCHER_STATE=/absolute/private/directory` selects another location. Use the same setting for the CLI and hook, and keep it outside monitored roots. The shim embeds the chosen state path. State directories must belong to the running user and exclude group/other permissions.

The installer validates exact Parcel package, wrapper, entry and VS Code watcher-bundle fingerprints. It stages a self-contained immutable-by-convention release with checksums, backs up the stock entry both beside the package and outside the server, records a prepared manifest, and atomically installs an explicit-export loader shim. Original native binaries and package metadata remain untouched. It never installs npm packages in VS Code's node_modules.

The selected server's own Node runs create/update/rename/delete and snapshot smoke tests, CJS package-root loading, default/named ESM imports and policy-compatible temporary fixtures. Known machine/workspace watcher exclusions are compiled before patching; unsupported patterns stop installation. Dynamically introduced extension patterns are validated on each new request. Configured missing/invalid files are errors, not unrestricted defaults.

## Activate and verify the actual VS Code process

Run **Developer: Reload Window**. If the old watcher remains loaded, disconnect every VS Code window using this container and reconnect. Then:

```bash
node bin/watcherctl.cjs status --server-root "$SERVER" --live
```

For the live `fileWatcher` process, require `running Rust backend`, the expected build and policy. A replacement on disk, a smoke-test PID or stale health record is insufficient. Fallback is degraded. Unreadable process data is unknown, never zero watches.

From a terminal, create, edit, rename and delete your own disposable workspace file. Confirm Explorer and an open editor respond. This UI check has not been performed by the implementation agent.

## Rebuilds and updates

Rebuild the container after changing its Dockerfile/devcontainer.json. On attach the hook exits immediately without the opt-in marker. With the marker it selects an ancestor server or one unambiguous active server, rebuilds stale/missing artifacts with locked inputs as `vscode`, and validates/reapplies only a supported patch. Source movement, ambiguous servers and unsupported fingerprints produce warnings. No automatic reload occurs.

Post-attach can run after the stock watcher has loaded. A successful reapply therefore still reports reload/reconnect required. Run `status --live` after reconnecting.

For a manual reapply, rediscover, set `SERVER` to the current relevant installation, then repeat `install` and `verify` above. A new watcher-bundle fingerprint is refused until its call sites, API and differential tests have been audited and its compatibility profile intentionally updated. Do not replace hashes merely to bypass the check.

On failure the hook retains/restores stock where a verified known patch can be restored and leaves the container running. It does not touch services or databases. A successful `restore --all --disable-auto` removes the opt-in marker under the installer lock, so later hooks cannot reinstall it.

Reference: [Dev Container JSON specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md).
