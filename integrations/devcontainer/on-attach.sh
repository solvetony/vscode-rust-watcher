#!/usr/bin/env bash
set -u
export PATH="/home/vscode/.cargo/bin:${PATH}"
STATE="${RUST_WATCHER_STATE:-/workspaces/mounted/.vscode-rust-watcher}"
[[ -f "$STATE/auto-disabled.json" ]] && exit 0
[[ -f "$STATE/auto.json" || "${1:-}" == --image ]] || exit 0
PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -f "$PROJECT/scripts/on-attach.cjs" ]]; then
  echo '[rust-watcher] Source unavailable; leaving watcher unchanged. Restore manually if needed.' >&2
  exit 0
fi
if [[ "$(id -u)" == 0 ]]; then
  echo '[rust-watcher] Attach hook must run as vscode. Leaving watcher unchanged.' >&2
  exit 0
fi
NODE="$PROJECT/node_modules/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo '[rust-watcher] Node unavailable; leaving watcher unchanged.' >&2
  exit 0
fi
"$NODE" "$PROJECT/scripts/on-attach.cjs" "$@" || echo '[rust-watcher] Attach integration failed; container remains usable.' >&2
exit 0
