#!/bin/sh
# Starts the hub at login, restarts it if it stops, and keeps the Mac awake.
# Usage: DASHBOARD_PASSWORD=... scripts/install-service.sh
set -eu
: "${DASHBOARD_PASSWORD:?Set DASHBOARD_PASSWORD so the dashboard can be opened from other devices.}"
root=$(cd "$(dirname "$0")/.." && pwd)
label=club.samsungwall.hub
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$root/data" "$(dirname "$plist")"
umask 077
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$(command -v node)</string><string>$root/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$root</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$(command -v ffmpeg)"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DASHBOARD_PASSWORD</key><string>$DASHBOARD_PASSWORD</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$root/data/hub.log</string>
  <key>StandardErrorPath</key><string>$root/data/hub.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Hub installed. Dashboard: http://$(ipconfig getifaddr en0 2>/dev/null || hostname):8787"
