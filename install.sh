#!/bin/sh
# Builds the extension and registers the native messaging host with Chrome.
set -e
cd "$(dirname "$0")"

for tool in yt-dlp ffmpeg bun; do
  command -v "$tool" >/dev/null || { echo "falta $tool (brew install $tool)"; exit 1; }
done

bun install --silent
bun run build

KEY=$(grep '"key"' manifest.json | sed 's/.*"key": *"\([^"]*\)".*/\1/')
EXT_ID=$(printf '%s' "$KEY" | base64 -d | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p')
HOST_NAME="dev.yclpaiva.ytdl"

for DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
  [ -d "$(dirname "$DIR")" ] || continue
  mkdir -p "$DIR"
  cat > "$DIR/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "yt-dlp bridge for YT Downloader",
  "path": "$PWD/host/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "host registrado em $DIR"
done

echo
echo "Extension ID: $EXT_ID"
echo "Agora: chrome://extensions → Modo do desenvolvedor → Carregar sem compactação → $PWD/dist"
