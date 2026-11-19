#!/bin/bash
# Baut die Windows-App nach dist/ (auf Mac, Linux oder Windows mit .NET SDK).
# Ergebnis: dist/Watch Him Code (Windows)/ und dist/WatchHimCode-windows.zip
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
OUT="$ROOT/dist/Watch Him Code (Windows)"
ZIP="$ROOT/dist/WatchHimCode-windows.zip"

rm -rf "$OUT" "$ZIP" bin obj
echo "• Baue WatchHimCode.exe …"
dotnet build -c Release -o "$OUT" -nologo -v quiet

echo "• Kopiere Server und Oberfläche …"
mkdir -p "$OUT/server"
cp "$ROOT/server.js" "$OUT/server/"
cp -R "$ROOT/public" "$OUT/server/"
rm -f "$OUT"/*.pdb "$OUT"/*.xml
# WebView2Loader.dll zusätzlich neben die .exe, damit sie in jedem Fall gefunden wird
cp "$OUT/runtimes/win-x64/native/WebView2Loader.dll" "$OUT/"

echo "• Packe ZIP …"
(cd "$ROOT/dist" && zip -qr "$(basename "$ZIP")" "$(basename "$OUT")")
rm -rf bin obj

echo "Fertig: $ZIP"
