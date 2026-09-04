#!/usr/bin/env bash
# Toggle AI Gateway between this local checkout and its published package.
# Usage: ./scripts/switch.sh {dev|prod|status}

set -euo pipefail
mode="${1:-status}"
settings="$HOME/.pi/agent/settings.json"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
dev_path="$repo_root"
prod_path="npm:pi-ai-gateway"

has() { jq -e --arg value "$1" '.packages | index($value)' "$settings" >/dev/null 2>&1; }

case "$mode" in
status)
	if has "$dev_path"; then echo "dev (local: $dev_path)"; fi
	if has "$prod_path"; then echo "prod ($prod_path)"; fi
	;;
dev)
	pi remove "$prod_path" 2>/dev/null || true
	has "$dev_path" || pi install "$dev_path"
	echo "switched to dev. Start a new Pi session to load it."
	;;
prod)
	pi remove "$dev_path" 2>/dev/null || true
	has "$prod_path" || pi install "$prod_path"
	echo "switched to prod. Start a new Pi session to load it."
	;;
*)
	echo "usage: $0 {dev|prod|status}" >&2
	exit 2
	;;
esac
