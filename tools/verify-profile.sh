#!/bin/bash
#
# Verify that this plugin really mounts in a real DSH host — hermetically.
#
# All the isolation lives in `with-scratch-profile.sh`; this lane states the
# assertion: the host half must write the extension mirror, the real host must
# deliver the plugin's browser half to a real browser, and that half must find
# the extension over `externally_connectable`.
#
#   bash tools/verify-profile.sh
#
# Environment: see tools/with-scratch-profile.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$ROOT/tools/with-scratch-profile.sh" node "$ROOT/tools/verify-mount.mjs"
