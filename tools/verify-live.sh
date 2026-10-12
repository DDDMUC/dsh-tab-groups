#!/usr/bin/env bash
# Run the plugin-UI lane against the *live* dsh web on this machine.
#
# The lane keeps a persistent browser profile (~/.dsh-tab-groups-gui-profile), so
# after its first visit the auth cookie carries it across `dsh web` restarts and
# no token is needed at all. The URL is only fetched to seed that first visit.
set -euo pipefail

cd "$(dirname "$0")/.."

GUI_URL="${GUI_URL:-$(node tools/live-url.mjs)}"
MIRROR="${MIRROR:-$HOME/.dsh/dsh-tab-groups-extension}"

if [ ! -f "$MIRROR/manifest.json" ]; then
  echo "镜像目录里没有 manifest.json：$MIRROR" >&2
  echo "先在 DSH 里启用本插件（宿主半区会写出镜像）。" >&2
  exit 2
fi

echo "实时实例：$GUI_URL"
echo "扩展镜像：$MIRROR"
GUI_URL="$GUI_URL" MIRROR="$MIRROR" exec node tools/verify-section.mjs
