# Bake the watcher into the devcontainer image

This is the source-independent workflow. The compiled addon, adapter, installer, dependencies, policy and startup integration live under `/opt/vscode-rust-watcher` in the image. `/workspaces/mounted/projects/vscode-rust-watcher` is not needed when the rebuilt container runs. Rust, Cargo, npm and a source checkout are not used for startup installation.

## 1. Produce the binary package once

The prepared archive is `dist/vscode-rust-watcher-image.tar.gz`. To regenerate it after changing the implementation, run as `vscode` using the pinned development Node 24:

```bash
npm ci
npm run build
npm run lint
npm test
npm run package
```

The CLI also accepts a policy to embed:

```bash
node bin/watcherctl.cjs package \
  --output dist/vscode-rust-watcher-image.tar.gz \
  --config config/devcontainer.json
```

Copy **only that archive** into the root of your existing Docker build context, named `vscode-rust-watcher-image.tar.gz`. The build context is the existing `build.context` directory, which need not be the Dockerfile's directory. Ensure your `.dockerignore` does not exclude the archive. Keep it with your devcontainer assets so later rebuilds do not need this source folder. Do not copy a mutable source-tree symlink into the image.

The package is Linux x86_64/glibc and must be built against the same libc version as the final container image. The inspected environment uses Debian 13 / glibc 2.41. A different architecture or libc is refused; regenerate the package in the matching build environment. VS Code's separate Node executable must still pass the installer ABI and event checks.

## 2. Dockerfile: extract the package into the image

Insert the following after the existing `vscode` user has been created, keeping your original final `USER`, service setup and other commands:

```dockerfile
ADD --chown=vscode:vscode vscode-rust-watcher-image.tar.gz /opt/vscode-rust-watcher/
RUN chmod -R a+rX /opt/vscode-rust-watcher
ENV NODE_OPTIONS="--require=/opt/vscode-rust-watcher/integrations/devcontainer/preload.cjs"
```

The same snippet is in [Dockerfile.image.fragment](../integrations/devcontainer/Dockerfile.image.fragment). If `NODE_OPTIONS` already contains flags, **append** this `--require` flag to its existing value instead of discarding those flags. Package files must be readable to other container users because `NODE_OPTIONS` can reach their Node processes too; the preload exits immediately for unrelated Node programs and worker threads.

You can retain the earlier `ENV PATH="/home/vscode/.cargo/bin:${PATH}"` addition for your existing Rust development setup. The packaged runtime does not need it. No privileged mode or kernel setting changes are necessary.

## 3. devcontainer.json: merge these fields

```json
{
  "containerEnv": {
    "RUST_WATCHER_ROOT": "/workspaces/mounted/projects",
    "RUST_WATCHER_CONFIG": "/opt/vscode-rust-watcher/config/devcontainer.json",
    "RUST_WATCHER_FIX_PERMISSIONS": "1"
  },
  "postAttachCommand": [
    "bash",
    "/opt/vscode-rust-watcher/integrations/devcontainer/on-attach.sh",
    "--image"
  ]
}
```

[The merge fragment](../rust-filewatcher-devcontainer-merge.json) contains exactly these fields. Merge into existing objects; do not replace the whole configuration. If you already have `postAttachCommand`, add this command under a `rustWatcher` key alongside the existing commands in an object. Preserve `workspaceFolder`, mounts, ports, Node feature, extensions, zsh, `remoteEnv.PONYTAIL_DEFAULT_MODE`, all of `postCreateCommand`, and `postStartCommand: "start-dev-services"` with its databases.

Replace/remove any older `RUST_WATCHER_CONFIG` override pointing into the source folder, including one in `remoteEnv`. The image path above contains the embedded policy and overrides the old source-folder configuration.

`RUST_WATCHER_ROOT` forces restricted mode for exactly that normalized absolute directory, overriding the policy's scope while retaining its ignore rules and resource limits. A request for `/workspaces` is intersected with this root before any recursive traversal. Requests outside it become inactive. Set it in `containerEnv`, or add `ENV RUST_WATCHER_ROOT="/workspaces/mounted/projects"` to your Dockerfile. `containerEnv` takes precedence over an image ENV value. An empty, relative or unnormalized value is an explicit error; it never means unrestricted mode. Restart/rebuild to change the root of existing processes. The adapter and installer both honor the override, and live health reports the effective policy. Older archives do not implement this variable.

## 4. Rebuild and check activation

Rebuild the container. No separate initial `watcherctl install` or mounted source folder is required for this workflow.

`NODE_OPTIONS` loads the startup integration before a recognized VS Code Server `server-main.js` or fileWatcher bootstrap loads Parcel. It identifies that server from its own executable, validates the package/bundle fingerprints and runs the existing reversible installer. It does not search for or arbitrarily patch the first of several installations. Nested verification processes and unrelated Node applications do not activate it. Supported startup activation therefore precedes the first Parcel import.

The image's first activation creates the persistent opt-in marker unless a previous rollback disabled auto activation. The attach hook provides a second opportunity to validate/reapply the image package, without building or downloading anything. If the launcher removed `NODE_OPTIONS`, startup preloading cannot run; the attach hook can install on disk but will then report reload/reconnect required. There is no automatic reload loop. Unsupported VS Code updates remain stock with a warning.

Check from any directory:

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs status --live
node /opt/vscode-rust-watcher/bin/watcherctl.cjs doctor
```

Require `running Rust backend` for the actual `fileWatcher` process, with the expected policy. Check external edits in Explorer/open editors too. A real Docker rebuild and VS Code UI check have not been performed here; automated tests verified first-import activation with an independent fake server and a copied actual server Node binary.

The default policy still monitors `/workspaces/mounted/projects` and deliberately excludes dependency/generated subtrees. State, verified backups, releases, health records and the disabled marker remain under `/workspaces/mounted/.vscode-rust-watcher`, outside the projects tree. They are independent of the deleted source folder.

## Server directory permissions

The image package lives in `/opt`, but installing its reversible shim also needs write and execute permission on the selected server's `node_modules/@parcel/watcher` directory. Some devcontainer server volumes provide that directory as `root:root` with mode `755`. Owning `/opt/vscode-rust-watcher` does not grant access to it. Dockerfile build steps cannot change ownership on a server volume that is mounted later at container startup.

The `RUST_WATCHER_FIX_PERMISSIONS: "1"` container setting above opts into automatic repair during both startup preload and attachment. After validating the selected server/package fingerprints, the installer uses noninteractive `sudo` to change ownership of only that root-owned package directory to the running user's UID/GID. It does not recurse or change native binaries. Your inspected container already grants `vscode` passwordless sudo. Without that capability it leaves the watcher unchanged and reports the failure; it never prompts for a password. The setting is ignored when the directory is already writable, and symlink directories are not repaired. Omit the setting for administrator-managed permissions instead.

Use the updated archive with this setting, then rebuild. The older archive does not implement automatic ownership repair.

If installation reports EACCES while creating `.rust-watcher-original-index.cjs...tmp`, select the server from discovery and run this once as its container administrator:

```bash
sudo chown vscode:vscode -- "$SERVER/node_modules/@parcel/watcher"
bash /opt/vscode-rust-watcher/integrations/devcontainer/on-attach.sh --image
```

Only the package directory's ownership changes; no recursive ownership change or native-binary modification is needed. Directory access is necessary for atomic temporary-file creation and rename, even when `index.js` itself is writable. Run the hook as `vscode`, then reload/reconnect and check `status --live`.

This ownership persists if the server volume is retained. With automatic repair enabled, supported new root-owned installations receive the same targeted setup. Without the setting, a new root-owned installation needs the administrator command again. Unsupported updates remain stock and are not granted ownership by installation.

## Tracking limits and generated project data

`maxTrackedEntries` is a policy setting, separate from `maxQueuedEvents`. It counts retained files/directories, with the same numeric bound applied independently to pending traversal work. The implementation defaults to 1,000,000; the supplied projects policy now sets 3,000,000. Valid values are integers from 1 to 10,000,000. Raising the cap can increase memory consumption; it does not reserve capacity up front or guarantee a fixed total RSS. The separate snapshot-file size limit remains 512 MiB.

The supplied policy still allows **only `/workspaces/mounted/projects`**. An incoming `/workspaces` request is clipped to that root before traversal; its displayed requested path does not mean siblings are scanned. The following confirmed trees are now excluded before descending:

- `/workspaces/mounted/projects/specs/log-widgets.backup-*` and descendants;
- `loghub`, `zenodo` and `secrepo` below `/workspaces/mounted/projects/specs/log-widgets`;
- the same three generated groups below `/workspaces/mounted/projects/btcwid/specs/log-widgets`.

`btcwid/scripts/generate-log-widget-specs.mjs` confirms the generated output layout; its improvement script names the timestamped backup directories. Generator scripts, `mappings.json`, handwritten specs and other projects' specs remain monitored. No files were deleted. These deliberate exclusions suppress notifications for the generated trees, including independent extension requests into them.

To choose another limit without this source checkout, save a copy of the policy outside `/opt`, change `maxTrackedEntries` in that copy, and repackage the existing binary:

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs package \
  --config /absolute/path/to/your-policy.json \
  --output /tmp/vscode-rust-watcher-image.tar.gz
```

Copy that archive back into your Docker build context and rebuild. This needs tar, not npm, Cargo or Rust sources. Keep the policy copy outside the checksummed `/opt` package; editing package files in place invalidates its integrity checks. Older archives do not recognize `maxTrackedEntries`.

## Persistent rollback and re-enable

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs restore --all --disable-auto
```

Reload/reconnect afterward. This writes a persistent `auto-disabled.json` marker, honored by **both startup preload and attach hooks**, including after another image rebuild. Do not delete the state directory to disable it: deleting state also deletes backups and the persistent opt-out.

To explicitly re-enable or migrate from an older source-based install, discover the relevant server and use the packaged CLI:

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs discover --json
# If an older source-based shim is still installed, restore it first:
node /opt/vscode-rust-watcher/bin/watcherctl.cjs restore --all --disable-auto
node /opt/vscode-rust-watcher/bin/watcherctl.cjs install \
  --server-root "$SERVER" \
  --config /opt/vscode-rust-watcher/config/devcontainer.json \
  --enable-auto
```

Set `SERVER` to the relevant discovered root. Explicit `--enable-auto` clears the disabled marker after successful verification. Subsequent image rebuilds activate automatically again. An old marker belonging to the source path is refused rather than silently replacing a custom policy.

References: [Docker ADD for local archives](https://docs.docker.com/reference/dockerfile/#add), [Node preload and NODE_OPTIONS](https://nodejs.org/api/cli.html#node_optionsoptions), [devcontainer metadata](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md).
