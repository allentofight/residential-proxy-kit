#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.claude/residential-proxy"
RES_HOST=""
RES_PORT=""
RES_USER=""
RES_PASS=""
EXPECTED_IP=""
WIFI_SERVICE="Wi-Fi"
CLASH_PORT="7897"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-on-mac.sh \
    --res-host <host> \
    --res-port <port> \
    --res-user <username> \
    --res-pass <password> \
    [--expected-ip <ip>] \
    [--wifi-service <service>] \
    [--clash-port <port>]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --res-host) RES_HOST="${2:-}"; shift 2 ;;
    --res-port) RES_PORT="${2:-}"; shift 2 ;;
    --res-user) RES_USER="${2:-}"; shift 2 ;;
    --res-pass) RES_PASS="${2:-}"; shift 2 ;;
    --expected-ip) EXPECTED_IP="${2:-}"; shift 2 ;;
    --wifi-service) WIFI_SERVICE="${2:-}"; shift 2 ;;
    --clash-port) CLASH_PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$RES_HOST" ]] || { echo "Missing --res-host" >&2; usage; exit 1; }
[[ -n "$RES_PORT" ]] || { echo "Missing --res-port" >&2; usage; exit 1; }
[[ -n "$RES_USER" ]] || { echo "Missing --res-user" >&2; usage; exit 1; }
[[ -n "$RES_PASS" ]] || { echo "Missing --res-pass" >&2; usage; exit 1; }

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "node not found. Install Node.js first." >&2; exit 1; }

ASSET_PROXY="$SCRIPT_DIR/proxy-router.js"
ASSET_PREFLIGHT="$SCRIPT_DIR/preflight.sh"
ASSET_HEALTH_SERVER="$SCRIPT_DIR/healthcheck-server.js"
ASSET_HEALTH_HTML="$SCRIPT_DIR/../ui/healthcheck.html"

[[ -f "$ASSET_PROXY" ]] || { echo "Missing $ASSET_PROXY" >&2; exit 1; }
[[ -f "$ASSET_PREFLIGHT" ]] || { echo "Missing $ASSET_PREFLIGHT" >&2; exit 1; }
[[ -f "$ASSET_HEALTH_SERVER" ]] || { echo "Missing $ASSET_HEALTH_SERVER" >&2; exit 1; }
[[ -f "$ASSET_HEALTH_HTML" ]] || { echo "Missing $ASSET_HEALTH_HTML" >&2; exit 1; }

echo "[1/9] Installing scripts to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp "$ASSET_PROXY" "$INSTALL_DIR/proxy.js"
cp "$ASSET_PREFLIGHT" "$INSTALL_DIR/preflight.sh"
cp "$ASSET_HEALTH_SERVER" "$INSTALL_DIR/healthcheck-server.js"
cp "$ASSET_HEALTH_HTML" "$INSTALL_DIR/healthcheck.html"

echo "[2/9] Writing upstream settings ..."
RES_HOST="$RES_HOST" RES_PORT="$RES_PORT" RES_USER="$RES_USER" RES_PASS="$RES_PASS" CLASH_PORT="$CLASH_PORT" perl -0777 -i -pe '
  s/host:\s*'\''RESIDENTIAL_HOST'\''/host: '\''$ENV{RES_HOST}'\''/g;
  s/port:\s*1080,/port: $ENV{RES_PORT},/g;
  s/username:\s*'\''RESIDENTIAL_USERNAME'\''/username: '\''$ENV{RES_USER}'\''/g;
  s/password:\s*'\''RESIDENTIAL_PASSWORD'\''/password: '\''$ENV{RES_PASS}'\''/g;
  s#(clash:\s*\{\s*host:\s*'\''127\.0\.0\.1'\''\s*,\s*port:\s*)\d+#$1$ENV{CLASH_PORT}#s;
' "$INSTALL_DIR/proxy.js"

echo "[3/9] Writing launch agents ..."
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$HOME/Library/LaunchAgents/com.residential.proxy-router.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.residential.proxy-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/proxy.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/launchd.stderr.log</string>
</dict>
</plist>
EOF

cat > "$HOME/Library/LaunchAgents/com.residential.proxy-healthcheck-ui.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.residential.proxy-healthcheck-ui</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/healthcheck-server.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/healthcheck.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/healthcheck.stderr.log</string>
</dict>
</plist>
EOF

echo "[4/9] Loading launch agents ..."
launchctl unload "$HOME/Library/LaunchAgents/com.residential.proxy-router.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.residential.proxy-healthcheck-ui.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.residential.proxy-router.plist"
launchctl load "$HOME/Library/LaunchAgents/com.residential.proxy-healthcheck-ui.plist"

echo "[5/9] Updating Claude Code env proxy ..."
mkdir -p "$HOME/.claude"
ENV_FILE="$HOME/.claude/.env"
if [[ -L "$ENV_FILE" ]]; then
  LINK_TARGET="$(readlink "$ENV_FILE")"
  if [[ "$LINK_TARGET" = /* ]]; then
    ENV_FILE="$LINK_TARGET"
  else
    ENV_FILE="$(cd "$(dirname "$HOME/.claude/.env")" && cd "$(dirname "$LINK_TARGET")" && pwd)/$(basename "$LINK_TARGET")"
  fi
fi
touch "$ENV_FILE"

TMP_ENV="$(mktemp)"
grep -Ev '^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=' "$ENV_FILE" > "$TMP_ENV" || true
{
  cat "$TMP_ENV"
  echo "HTTP_PROXY=http://127.0.0.1:18080"
  echo "HTTPS_PROXY=http://127.0.0.1:18080"
  echo "NO_PROXY=127.0.0.1,localhost"
} > "$ENV_FILE"
rm -f "$TMP_ENV"

echo "[6/9] Setting macOS system proxy on ${WIFI_SERVICE} ..."
networksetup -setwebproxy "$WIFI_SERVICE" 127.0.0.1 18080
networksetup -setsecurewebproxy "$WIFI_SERVICE" 127.0.0.1 18080
networksetup -setsocksfirewallproxy "$WIFI_SERVICE" 127.0.0.1 18081
networksetup -setwebproxystate "$WIFI_SERVICE" on
networksetup -setsecurewebproxystate "$WIFI_SERVICE" on
networksetup -setsocksfirewallproxystate "$WIFI_SERVICE" on

echo "[7/9] Disabling Clash Verge system proxy takeover (if present) ..."
VERGE_YAML="$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge.yaml"
if [[ -f "$VERGE_YAML" ]]; then
  perl -0777 -i -pe 's/enable_system_proxy:\s*true/enable_system_proxy: false/g' "$VERGE_YAML"
fi

echo "[8/9] Tightening file permissions ..."
chmod 700 "$INSTALL_DIR/proxy.js" "$INSTALL_DIR/preflight.sh" "$INSTALL_DIR/healthcheck-server.js"
chmod 600 "$ENV_FILE" \
  "$HOME/Library/LaunchAgents/com.residential.proxy-router.plist" \
  "$HOME/Library/LaunchAgents/com.residential.proxy-healthcheck-ui.plist"

echo "[9/9] Running preflight ..."
if [[ -n "$EXPECTED_IP" ]]; then
  "$INSTALL_DIR/preflight.sh" "$EXPECTED_IP"
else
  echo "[INFO] --expected-ip was not provided. Skipping strict preflight."
  echo "[INFO] Open http://127.0.0.1:18100 and run the check manually."
fi

echo
echo "Install complete."
echo "Healthcheck UI: http://127.0.0.1:18100"

