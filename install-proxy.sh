#!/usr/bin/env bash
#
# Network Planner – one-time satellite tile-proxy installer (macOS)
# ================================================================
# Satellite imagery is OPTIONAL. The core mod (Planning + Efficiency) needs none of this.
# The game blocks external tile domains, so satellite tiles are served from a tiny local
# proxy on 127.0.0.1. This script registers that proxy as a macOS launch agent so it
# starts automatically at login – run it ONCE and you never think about it again.
#
# Usage:  bash install-proxy.sh          (from this mod folder)
# Remove: bash install-proxy.sh --uninstall
#
# Requires Node.js (https://nodejs.org). Windows/Linux: see README.

set -e

LABEL="com.networkplanner.satproxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MOD_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "--uninstall" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	rm -f "$PLIST"
	echo "✓ Satellite proxy removed."
	exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
	echo "✗ Node.js not found. Install it from https://nodejs.org, then re-run this script."
	exit 1
fi
if [ ! -f "$MOD_DIR/proxy.js" ]; then
	echo "✗ proxy.js not found next to this script. Run it from inside the catchment-pro mod folder."
	exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$MOD_DIR/proxy.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$MOD_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$MOD_DIR/proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$MOD_DIR/proxy.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "✓ Satellite proxy installed and running (auto-starts at login)."
echo "  node:    $NODE"
echo "  mod dir: $MOD_DIR"
echo "  Toggle Satellite on in the mod's Setup tab to use it."
echo "  To remove: bash install-proxy.sh --uninstall"
