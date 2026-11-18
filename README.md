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

- **Links** die Dateiliste: grün = neu angelegt, bernstein = geändert, mit `+`/`−`
  und Balken. Die Karte leuchtet bei jeder Änderung kurz auf.
- **Mitte** der Diff mit Zeilennummern (alt | neu) und Syntax-Hervorhebung.
  Neueste Änderung oben, ältere darunter.
- **Live**: Die Ansicht folgt automatisch der aktuellen Änderung.
  Klick auf eine Datei hält die Ansicht dort fest; neue Änderungen anderer Dateien
  erscheinen dann als kurze Hinweisleiste. Zurück mit dem Knopf „Live folgen“ oder `Esc`.

## Wie es funktioniert

Claude Code (Terminal wie Desktop-App) schreibt jede Session als Protokoll nach
`~/.claude/projects/<projekt>/<session>.jsonl`. Der Server

1. nimmt die zuletzt geschriebene Session (wechselt automatisch, wenn eine andere aktiv wird),
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
- `public/app.js` – Live-Logik, Dateiliste, Diff
- `public/highlight.js` – kleiner eigener Syntax-Highlighter
