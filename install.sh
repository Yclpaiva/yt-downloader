#!/bin/sh
# Build the browser-only extension. No native messaging registration is needed.
set -eu
cd "$(dirname "$0")"
command -v bun >/dev/null || { echo "Bun is required to build: https://bun.sh"; exit 1; }
bun install --frozen-lockfile
bun run build
printf '\nLoad the dist/ directory in Chrome extensions, then reload YouTube.\n'
