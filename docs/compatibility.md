# Inspected integration contract

Inspection date: 2026-11-13, as `vscode` (UID 1000), Debian glibc Linux x86_64. Live package files were inspected read-only. Original TypeScript sources were unavailable in the installation, so the installed `watcherMain.js` bundle and actual loading behavior were used.

| Item | Observed value |
|---|---|
| Server root | `/vscode/vscode-server/bin/linux-x64/69047191fc427f2f92828279aae1d90d8eeda7ab` |
| VS Code commit | `69047191fc427f2f92828279aae1d90d8eeda7ab` |
| Bundled package | `@parcel/watcher` 2.5.6 |
| Package main | `index.js`, CommonJS, no module type override |
| Server Node | v24.22.1 |
| Server `process.versions.napi` | 10 |
| Architecture | x64 / x86_64 |
| Runtime libc | glibc 2.41 |
| Development Node | 24.22.3 (pinned), initial shell was 26.13.1 |
| Rust | 1.99.1 (58cf8f9c3, 2026-10-13) |
| Addon ABI | Node-API 8, independently loaded by the selected server Node |

SHA-256 fingerprints:

| File | SHA-256 |
|---|---|
| Parcel `index.js` | `7028a46ab84bc5b0effeb7b6781b1f1375f1762c18de089b74a3d9f8cc742224` |
| Parcel `wrapper.js` | `aff6fa51c1a1d8bd792a0f082b98200bac568def3e5c1442ada78c915e924406` |
| Parcel `package.json` | `287b0a3346201d109888d06361d94c1284e8aba7251459a3edcbb3c503adb7ba` |
| VS Code `out/vs/platform/files/node/watcher/watcherMain.js` | `6fc7003a7d3bdf8922c9aac2626ae737e66e67a37fba25a8440a11c6ddccdf68` |

The installed package advertises `index.d.ts` but does not ship it. [The upstream 2.5.6 declarations](parcel-index.d.ts) were fetched for reference; [Parcel's MIT notice](parcel-LICENSE) is retained. The installed wrapper, native package, package manifest and flow declaration were available. Wrapper normalization was verified against source and runtime differential tests.

## Loading and API

The bundle imports the **package root with a default ESM import**, `import <binding> from "@parcel/watcher"`, not `watcher.node` or another private internal path. Native subscribe calls pass `{ backend: "inotify", ignore: <request exclusions> }`. Linux predefined exclusions are an empty array. Polling calls use `getEventsSince` and `writeSnapshot` with the same options and write a snapshot before the first query.

The baseline exports `subscribe`, `unsubscribe`, `writeSnapshot` and `getEventsSince`. The wrapper resolves root/snapshot paths, returns Promises, delivers error-first callbacks and exposes `subscription.unsubscribe()`. Runtime CJS and default/named ESM tests exercise these exports. The replacement shim explicitly assigns each named export so CJS static export detection works.

Directory moves are delete/create. Atomic replacement via `rename(temp, existing)` emits a **create** at the existing path in the inspected baseline; the implementation preserves that coalescing behavior. A create followed by delete within a batch is suppressed. Differential fixtures pre-create their directories so a race while stock Parcel adds a new directory watch does not become an assumed API guarantee.

## Ignores

The installed wrapper classifies strings with `is-glob`. Literals become absolute paths; literal containment is component-aware. Glob patterns are compiled by picomatch with `dot: true, windows: false`, then matched by Parcel's C++ ECMAScript regex against root-relative paths. An absolute **glob** remains an absolute glob against that relative coordinate system, rather than being silently converted to an absolute-path ignore. Global policy rules instead deliberately match absolute paths.

The replacement uses pinned picomatch 4.0.7 for parsing and Rust non-backtracking byte regexes for matching UTF-8 filesystem bytes, preserving the native byte-oriented wildcard behavior. Only exact picomatch assertions excluding `.`/`..` are removed, since directory enumeration never supplies those components. Literal names and repeated/nested globstars, dot directories, brace alternatives, escaping, character classes and positive `@()`, `+()`, `?()`, `*()` extglobs have dedicated tests.

Unsupported patterns are explicit errors: leading negation, negative extglobs, numeric brace ranges, backreferences, remaining lookarounds and anything rejected by the bounded native regex compiler. Non-ASCII character classes can be rejected by byte-regex validation. There is no exponential regex engine or fallback on each event. Known machine/workspace rules and default exclusion forms are checked in a fully excluded native subscription before install. Requests from future extension code are validated individually; their patterns cannot all be known at install time.

Non-UTF-8 filenames stop the affected request with an informative error. Compatible roots follow root symlinks but never descend child symlinks. Restricted roots reject symlink components; monitoring policy is not a protection against hostile filesystem races. Removal of a requested root's parent requires re-subscription if its sentinel is lost.

## Discovery and updates

Discovery enumerates bounded known server roots and current process references, never the whole filesystem. Supported layouts are `/vscode/vscode-server/bin/linux-x64/<installation>`, `~/.vscode-server/bin/<installation>`, the Insiders counterpart, and `~/.vscode-server/cli/servers/<installation>/server` and `~/.vscode-server-insiders/cli/servers/<installation>/server`. Process-referenced layouts with the verified package and watcher bundle can also be used explicitly.

No commit is hard-coded into discovery or patching. [config/compatibility.json](../config/compatibility.json) stores exact tested **file fingerprints**. A new directory/commit undergoes its own package, wrapper, bundle, Node-API, architecture, libc, load and event checks. Changed watcher-bundle fingerprints remain stock until deliberately audited; superficial string matching cannot authorize an unknown update. Build metadata and release checksums are recorded with each installation.

Reference reading: [VS Code internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals), [watcher issues](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues), [Parcel](https://github.com/parcel-bundler/watcher), [VS Code issue 305923](https://github.com/microsoft/vscode/issues/305923). That issue is relevant background, not a diagnosis established for this workspace.
