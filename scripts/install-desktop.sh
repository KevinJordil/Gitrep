#!/bin/sh
# Installs a GNOME launcher entry for the packaged app (run `npm run package` first).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/linux-unpacked/gitrep"
[ -x "$APP" ] || { echo "App not found: run 'npm run package' first."; exit 1; }
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$APPS" "$ICONS"
cp "$ROOT/resources/gitrep.svg" "$ICONS/gitrep.svg"
# --no-sandbox: this system restricts unprivileged user namespaces (AppArmor); see README to remove it.
cat > "$APPS/gitrep.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GitRep
Comment=Local multi-repo git client
Exec="$APP" --no-sandbox
Icon=gitrep
Terminal=false
Categories=Development;
StartupWMClass=gitrep
EOF
update-desktop-database "$APPS" 2>/dev/null || true
echo "Installed: look for 'GitRep' in the GNOME launcher."
