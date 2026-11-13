# Rust watcher for VS Code Server

A Rust-backed replacement for VS Code Server's recursive Parcel watcher on Linux x86_64 with glibc. It keeps the public Parcel API and installs through a reversible loader shim.

## What's different?

Both stock Parcel and this backend use Linux **inotify**. This replaces the native engine with Rust and adds configurable monitoring policy and reversible installation:

- A dedicated Rust thread waits for events, without a permanent libuv worker or periodic tree scan.
- Overlapping subscriptions share directory watches. Files are tracked without a separate kernel watch for each file.
- Root restrictions and directory exclusions apply **before traversal**, so ignored trees are skipped rather than scanned and filtered afterward.
- Snapshots, overflow recovery, activation checks and rollback are included.

This is experimental, not a promise of lower CPU or memory use on every project. Large trees still need an initial scan and metadata storage. Other `fs.watch` calls and separate extension watchers are unchanged. Only [validated VS Code builds](config/compatibility.json) are patched; unsupported updates stay stock.

## Build

Use Node **24.22.3**, rustup and a C linker (`build-essential` on Debian) on Linux x86_64/glibc. Rust and dependencies are pinned. Run from the checkout as a non-root user:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm ci
npm run build
npm run lint
npm test
npm run package
```

The output is `dist/vscode-rust-watcher-image.tar.gz`. Build it against the same glibc version as your container. Review [config/devcontainer.json](config/devcontainer.json) first: the example includes exclusions specific to the original workspace.

## Install in a devcontainer

Copy the archive into your Docker build context. With the usual `.devcontainer/Dockerfile` setup and no explicit `build.context`, put it in `.devcontainer/`.

Add to your Dockerfile after the `vscode` user exists:

```dockerfile
ADD --chown=vscode:vscode vscode-rust-watcher-image.tar.gz /opt/vscode-rust-watcher/
RUN chmod -R a+rX /opt/vscode-rust-watcher
ENV NODE_OPTIONS="--require=/opt/vscode-rust-watcher/integrations/devcontainer/preload.cjs"
```

Append the preload flag if you already use `NODE_OPTIONS`. Merge these fields into devcontainer.json, keeping your existing settings and lifecycle commands:

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

Set `RUST_WATCHER_ROOT` to your workspace. Permission repair is optional: it needs passwordless sudo and changes ownership of only the validated Parcel package directory. Omit that setting if an administrator manages permissions.

**Rebuild the container.** Startup installs the watcher before Parcel loads when the preload reaches the server; the attach hook provides a fallback. The source checkout, npm and Cargo are not needed in the running container.

## Check activation

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs status --live
```

Check for `running Rust backend` on the actual fileWatcher process. If installation happened after startup, reload/reconnect first.

To restore the original watcher:

```bash
node /opt/vscode-rust-watcher/bin/watcherctl.cjs restore --all --disable-auto
```

Reload/reconnect afterward. The opt-out persists across rebuilds.

See [image installation](docs/image-installation.md) for configuration, [manual installation](docs/installation.md) for source installs, and [compatibility](docs/compatibility.md) for supported patterns and limits. [Validation results](docs/validation.md) record what was actually tested.

## License

[MIT](LICENSE). Dependencies retain their own licenses.
