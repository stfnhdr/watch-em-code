#!/bin/bash
# Builds "Watch 'Em Code.app" into dist/. Requires Xcode or the Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
APP="$ROOT/dist/Watch 'Em Code.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server"

echo "• Compiling (Apple Silicon + Intel) …"
swiftc -O -target arm64-apple-macos12 main.swift -o "$TMP/arm64"
swiftc -O -target x86_64-apple-macos12 main.swift -o "$TMP/x86_64"
lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$APP/Contents/MacOS/WatchEmCode"

echo "• Copying server and UI …"
cp Info.plist "$APP/Contents/"
cp "$ROOT/server.js" "$APP/Contents/Resources/server/"
cp -R "$ROOT/server" "$APP/Contents/Resources/server/"
cp -R "$ROOT/public" "$APP/Contents/Resources/server/"

echo "• Creating app icon …"
ICONSET="$TMP/AppIcon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "• Signing locally (ad hoc) …"
codesign --force --deep -s - "$APP" >/dev/null

# ZIP: what the in-app updater downloads (keep this name, the updater looks for it)
echo "• Creating ZIP …"
ZIP="$ROOT/dist/WatchEmCode-macOS.zip"
rm -f "$ZIP"
(cd "$ROOT/dist" && ditto -c -k --sequesterRsrc --keepParent "Watch 'Em Code.app" "$(basename "$ZIP")")

# DMG: for people – open it, drag the app onto "Applications", done.
# Starting it from Applications (not from Downloads) also avoids macOS running
# it from a temporary, read-only copy ("App Translocation").
echo "• Creating DMG …"
DMG="$ROOT/dist/WatchEmCode-macOS.dmg"
STAGE="$TMP/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Watch 'Em Code.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Watch 'Em Code" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

echo "Done: $APP"
echo "      $ZIP"
echo "      $DMG"
