#!/bin/bash
# Builds the Windows app into dist/ (on Mac, Linux or Windows with the .NET SDK).
# Output: dist/Watch Him Code (Windows)/ and dist/WatchHimCode-windows.zip
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
OUT="$ROOT/dist/Watch Him Code (Windows)"
ZIP="$ROOT/dist/WatchHimCode-windows.zip"

rm -rf "$OUT" "$ZIP" bin obj
echo "• Building WatchHimCode.exe …"
dotnet build -c Release -o "$OUT" -nologo -v quiet

echo "• Copying server and UI …"
mkdir -p "$OUT/server"
cp "$ROOT/server.js" "$OUT/server/"
cp -R "$ROOT/public" "$OUT/server/"
rm -f "$OUT"/*.pdb "$OUT"/*.xml
# Also put WebView2Loader.dll next to the .exe so it is always found
cp "$OUT/runtimes/win-x64/native/WebView2Loader.dll" "$OUT/"

echo "• Creating ZIP …"
(cd "$ROOT/dist" && zip -qr "$(basename "$ZIP")" "$(basename "$OUT")")
rm -rf bin obj

echo "Done: $ZIP"
