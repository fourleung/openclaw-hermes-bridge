#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm install
npm run build

has_package_ref=false
for arg in "$@"; do
  if [[ "$arg" == "--package-ref" ]]; then
    has_package_ref=true
    break
  fi
done

if [[ "$has_package_ref" == true ]]; then
  node dist/cli.js setup "$@"
else
  package_tgz="$(npm pack --silent | tail -n 1)"
  cleanup() {
    rm -f "$SCRIPT_DIR/$package_tgz"
  }
  trap cleanup EXIT
  node dist/cli.js setup --package-ref "file:$SCRIPT_DIR/$package_tgz" "$@"
fi
