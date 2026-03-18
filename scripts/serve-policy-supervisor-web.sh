#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="$HOME/.config/policy-supervisor-web.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export POLICY_SUPERVISOR_LIVE_ROOT="${POLICY_SUPERVISOR_LIVE_ROOT:-$HOME/.openclaw/workspace}"
cd "$REPO_ROOT"
exec python3 "$REPO_ROOT/scripts/policy-supervisor-web-server.py"
