#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/bin/opencode-agenthook.js"
PLUGIN_SRC="$ROOT/plugin/server.js"
BIN_DIR="$HOME/.local/bin"
DST="$BIN_DIR/opencode-agenthook"
PLUGIN_DIR="${OPENCODE_AGENTHOOK_PLUGIN_DIR:-$HOME/.local/share/opencode-agenthook}"
PLUGIN_DST="$PLUGIN_DIR/server.js"
ENV_FILE="$PLUGIN_DIR/hookbus.env"
CONFIG_PATH="${OPENCODE_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json}"
HOOKBUS_URL="${HOOKBUS_URL:-http://localhost:18800/event}"
HOOKBUS_SOURCE="${HOOKBUS_SOURCE:-opencode-agenthook}"
HOOKBUS_FAIL_MODE="${HOOKBUS_FAIL_MODE:-open}"

say() { printf "\033[1;32m[opencode-publisher]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[opencode-publisher]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[opencode-publisher] error:\033[0m %s\n" "$*"; exit 1; }

[ -f "$SRC" ] || die "missing $SRC"
[ -f "$PLUGIN_SRC" ] || die "missing $PLUGIN_SRC"
command -v node >/dev/null || die "node is required"
command -v opencode >/dev/null || warn "opencode was not found on PATH; install OpenCode before running the publisher"

mkdir -p "$BIN_DIR" "$PLUGIN_DIR"
install -Dm755 "$SRC" "$DST"
install -Dm644 "$PLUGIN_SRC" "$PLUGIN_DST"
say "installed $DST"
say "installed OpenCode server plugin $PLUGIN_DST"

TMP_ENV="$(mktemp "$PLUGIN_DIR/.hookbus.env.XXXXXX")"
trap 'rm -f "$TMP_ENV"' EXIT
chmod 600 "$TMP_ENV"
{
  echo "# hookbus-publisher-opencode config. Mode 600. Read by the OpenCode plugin at startup."
  echo "HOOKBUS_URL=$HOOKBUS_URL"
  echo "HOOKBUS_SOURCE=$HOOKBUS_SOURCE"
  echo "HOOKBUS_FAIL_MODE=$HOOKBUS_FAIL_MODE"
  if [ -n "${HOOKBUS_TOKEN:-}" ]; then
    echo "HOOKBUS_TOKEN=$HOOKBUS_TOKEN"
  fi
} > "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"
say "wrote HookBus config $ENV_FILE"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH. Add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

if command -v python3 >/dev/null; then
  CONFIG_PATH="$CONFIG_PATH" PLUGIN_DST="$PLUGIN_DST" python3 <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["CONFIG_PATH"])
plugin = str(Path(os.environ["PLUGIN_DST"]).resolve())
path.parent.mkdir(parents=True, exist_ok=True)
data = {}
if path.exists() and path.read_text(encoding="utf-8").strip():
    data = json.loads(path.read_text(encoding="utf-8"))
plugins = data.get("plugin")
if not isinstance(plugins, list):
    plugins = []
if plugin not in plugins:
    plugins.append(plugin)
data["plugin"] = plugins
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  say "registered plugin in $CONFIG_PATH"
else
  warn "python3 not found; add this plugin to opencode.json manually: $PLUGIN_DST"
fi

cat <<EOF

OpenCode HookBus publisher installed.

Run:
  export HOOKBUS_URL=\${HOOKBUS_URL:-http://localhost:18800/event}
  export HOOKBUS_TOKEN=<your-hookbus-token>
  opencode-agenthook run "Reply OK"

The server plugin is registered in:
  $CONFIG_PATH

That plugin is installed in the user-level OpenCode config by default, so normal:
  opencode

loads AgentHook events using the plugin-local hookbus.env. No shell profile export is required.

For OpenAI-compatible custom providers, configure OpenCode normally first, then pass:
  opencode-agenthook run -m provider/model "your task"
EOF
