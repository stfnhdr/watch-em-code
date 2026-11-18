# Watch Him Code

Ein schlankes Fenster für den zweiten Bildschirm: Du schaust dem Claude-Code-Agenten
beim Coden über die Schulter. Gezeigt werden **nur Code-Änderungen** (neue und
geänderte Dateien), live, sobald sie passieren. Keine Gedanken, keine Kosten, keine
Historie.

## Start

```bash
node server.js
```

Der Browser öffnet sich automatisch unter `http://127.0.0.1:4777`
(ist der Port belegt, wird der nächste freie genommen). Beenden mit `Strg+C`.

Voraussetzung: Node.js 18 oder neuer. Keine `npm install` nötig.

## Bedienung

Die Oberfläche ist an Xcode angelehnt und reine Ansicht – bearbeitet wird nichts.

- **Titelleiste**: alle Sessions der letzten 30 Minuten. Grüner pulsierender Punkt =
  ändert gerade Code. Live folgt der gewählten Session; Änderungen in anderen
  Sessions lassen nur deren Punkt kurz aufblinken.
- **Navigator** (links): Ordnerbaum der geänderten Dateien, **A** = neu, **M** = geändert,
  dazu `+`/`−`.
- **Tabs**: die zuletzt bearbeiteten Dateien (max. 6), ein Punkt zeigt „gerade in Arbeit“.
- **Code**: die ganze Datei mit Zeilennummern. Die letzte Änderung ist im Rand markiert
  (grün = neu, bernstein = geändert, roter Keil = gelöscht, Maus darüber zeigt den alten
  Text). Bei neuen Änderungen scrollt die Ansicht hin, gelöschte Zeilen erscheinen kurz
  durchgestrichen und klappen dann ein.
- **Live**: folgt automatisch der aktuellen Datei. Klick auf Datei/Tab hält fest,
  zurück mit „Live folgen“ oder `Esc`.
- **Pixel-Junior** (unten links, Knopf oben rechts schaltet ihn ab): tippt, wenn Code
  kommt, legt neue Dateien ab, radiert bei Löschungen, schläft nach 2 Minuten Ruhe ein
  und kommentiert ab und zu, was passiert. Taste `d` führt alle Reaktionen vor.
  Die Pixel-Schrift der Sprechblasen kommt von Google Fonts (Pixelify Sans);
  ohne Internet wird eine normale Monospace-Schrift genommen.

## Wie es funktioniert

Claude Code (Terminal wie Desktop-App) schreibt jede Session als Protokoll nach
`~/.claude/projects/<projekt>/<session>.jsonl`. Der Server

1. beobachtet alle Sessions, die in den letzten 30 Minuten geschrieben haben (max. 6),
2. liest neue Zeilen inkrementell (alle 0,6 s),
3. filtert Einträge mit `toolUseResult.filePath` + `structuredPatch` (Edit, Write,
   MultiEdit; NotebookEdit tolerant),
4. schickt sie per Server-Sent Events an die Seite.

Subagenten-Protokolle unter `<session>/subagents/` werden mitgelesen.

Der Server lauscht nur auf `127.0.0.1`, ist also von außen nicht erreichbar.

## Ansichten

- `http://127.0.0.1:4777/` – aktuelle Oberfläche (in Arbeit)
- `http://127.0.0.1:4777/base/` – **Base Mode**: eingefrorener Stand von Schritt 1,
  wird nicht mehr verändert. Zusätzlich im Git-Tag `base` festgehalten.

## Optionen

| Variable       | Wirkung                          |
| -------------- | -------------------------------- |
| `WHC_PORT`     | anderer Startport (Standard 4777) |
| `WHC_NO_OPEN=1`| Browser nicht automatisch öffnen |

## Dateien

- `server.js` – Beobachter + HTTP/SSE-Server (nur Node-Bordmittel)
- `public/index.html`, `style.css` – Oberfläche
- `public/app.js` – Live-Logik, Sessions, Navigator, Tabs, Code-Ansicht
- `public/buddy.js` – der Pixel-Junior
- `public/base/` – eingefrorene Basis-Ansicht
- `public/highlight.js` – kleiner eigener Syntax-Highlighter
