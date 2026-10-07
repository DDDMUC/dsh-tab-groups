#!/bin/bash
#
# Verify that this plugin really mounts in a real DSH host — hermetically.
#
# It builds a throwaway `DSH_HOME` under $TMPDIR containing one profile whose
# only additions over the core web bundles are this package, boots `dsh web` on
# an OS-assigned port, and then runs tools/verify-mount.mjs against that GUI
# with the extension loaded from the mirror the host half just wrote.
#
# Your real profile and your real ~/.dsh are not touched: the harness home is
# redirected, so the mirror lands in the temporary home instead.
#
#   bash tools/verify-profile.sh
#
# Environment:
#   DSH_BIN              dsh executable (default: `dsh` from PATH)
#   DSH_SOURCE_PROFILE   profile whose node_modules is copied to avoid a full
#                        install (default: $HOME/.dsh/profiles/web)
#   PLAYWRIGHT_PATH      playwright package dir (passed through)
#   E2E_CHANNEL          msedge (default) / chromium / chrome
#   KEEP=1               keep the temporary home and print its path

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_NAME="$(node -e "console.log(require('$ROOT/package.json').name)")"
DSH_BIN="${DSH_BIN:-dsh}"
SOURCE_PROFILE="${DSH_SOURCE_PROFILE:-$HOME/.dsh/profiles/web}"
CHANNEL="${E2E_CHANNEL:-msedge}"

command -v "$DSH_BIN" >/dev/null 2>&1 || {
  echo "找不到 dsh 可执行文件；请设置 DSH_BIN=/path/to/dsh" >&2
  exit 2
}
[ -d "$SOURCE_PROFILE/node_modules" ] || {
  echo "找不到 $SOURCE_PROFILE/node_modules；请设置 DSH_SOURCE_PROFILE" >&2
  exit 2
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-tab-groups-verify-XXXXXX")"
PROFILE_DIR="$TMP/profiles/verify"
WEB_LOG="$TMP/web.log"
WEB_PID=""

cleanup() {
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  sleep 1
  if [ "${KEEP:-0}" = "1" ]; then
    echo "保留临时目录：$TMP"
    return
  fi
  case "$TMP" in
    */dsh-tab-groups-verify-*) rm -rf "$TMP" ;;
    *) echo "临时目录路径异常，拒绝删除：$TMP" >&2 ;;
  esac
}
trap cleanup EXIT

echo "隔离 DSH_HOME : $TMP"
echo "扩展目录      : $ROOT"
echo "node_modules  : 复制自 ${SOURCE_PROFILE}（避免整树安装）"

mkdir -p "$PROFILE_DIR"
cp -a "$SOURCE_PROFILE/node_modules" "$PROFILE_DIR/node_modules"
ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/$PACKAGE_NAME"

cat > "$PROFILE_DIR/package.json" <<JSON
{
  "name": "dsh-profile-tab-groups-verify",
  "private": true,
  "dependencies": {
    "$PACKAGE_NAME": "link:$ROOT"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "$PACKAGE_NAME"
      ]
    }
  }
}
JSON
printf -- "[]\n" > "$PROFILE_DIR/cordis.patch.yml"

echo
echo "== 1/3 profile 组合里能解析出插件行吗 =="
DSH_HOME="$TMP" "$DSH_BIN" --profile verify --dump-config > "$TMP/dump.yml" 2>&1 || {
  echo "dump-config 失败：" >&2
  tail -20 "$TMP/dump.yml" >&2
  exit 1
}
if grep -q "^# == $PACKAGE_NAME$" "$TMP/dump.yml"; then
  echo "  ✔ 组合结果里有 # == $PACKAGE_NAME"
else
  echo "  ✖ 组合结果里找不到插件行" >&2
  exit 1
fi

echo
echo "== 2/3 启动隔离实例，并确认宿主半区落地了镜像 =="
DSH_HOME="$TMP" "$DSH_BIN" --profile verify --no-open --port 0 > "$WEB_LOG" 2>&1 &
WEB_PID=$!

GUI_URL=""
for _ in $(seq 1 60); do
  GUI_URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$WEB_LOG" 2>/dev/null | head -1 || true)"
  [ -n "$GUI_URL" ] && break
  kill -0 "$WEB_PID" 2>/dev/null || break
  sleep 1
done
[ -n "$GUI_URL" ] || {
  echo "实例没有在 60s 内打印出 URL；日志：" >&2
  tail -30 "$WEB_LOG" >&2
  exit 1
}
echo "  ✔ 实例已启动：${GUI_URL%%\?*}"

MIRROR="$TMP/dsh-tab-groups-extension"
for _ in $(seq 1 30); do
  [ -f "$MIRROR/manifest.json" ] && break
  sleep 1
done
[ -f "$MIRROR/manifest.json" ] || {
  echo "  ✖ 宿主半区没有写出镜像目录 $MIRROR" >&2
  exit 1
}
echo "  ✔ 宿主半区写出镜像：$MIRROR"

echo
echo "== 3/3 用真浏览器打开该 GUI，检查插件的客户端半区 =="
MIRROR="$MIRROR" GUI_URL="$GUI_URL" E2E_CHANNEL="$CHANNEL" node "$ROOT/tools/verify-mount.mjs"
