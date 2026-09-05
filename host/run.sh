#!/bin/sh
# Entry point registered with Chrome. Chrome gives hosts a bare PATH, so bun is
# resolved from the usual install locations instead of relying on the shell.
DIR="$(cd "$(dirname "$0")" && pwd)"
for BUN in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -x "$BUN" ] && exec "$BUN" "$DIR/ytdl-host.ts"
done
echo "bun não encontrado" >&2
exit 1
