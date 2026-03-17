#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export POLICY_SUPERVISOR_LIVE_ROOT="${POLICY_SUPERVISOR_LIVE_ROOT:-$HOME/.openclaw/workspace}"
cd "$REPO_ROOT"
exec python3 "$REPO_ROOT/scripts/policy-supervisor-web-server.py"
