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

Reine Ansicht – bearbeitet wird nichts. Über das Regler-Symbol oben rechts
(Einstellungen) lässt sich umschalten, alles bleibt im Browser gespeichert:

- **Ansicht**: *Editor* (Xcode-artig: Ordnerbaum, ganze Datei, Änderungen im Rand)
  oder *Karten* (Dateikarten mit Balken, Diff-Blöcke aller Änderungen einer Datei).
  Beide haben denselben Funktionsumfang. Taste `v`.
- **Diff**: *Neu* (nur der neue Stand, Änderungen markiert), *Inline* (alt und neu
  untereinander) oder *Nebeneinander* (links alt, rechts neu, Lücken schraffiert).
  Gilt für beide Ansichten. Neue Dateien haben keinen alten Stand und werden dann
  wie *Neu* gezeigt; ist das Fenster zu schmal (unter ca. 900 px Inhaltsbreite),
  wird *Inline* genommen. Ein Hinweis in der Pfadzeile sagt dann Bescheid. Taste `s`.
- **Farben**: Hell, Dunkel oder System. Taste `t`.
- **Pixel-Junior**: an/aus.

- **Titelleiste**: alle Sessions der letzten 30 Minuten. Grüner pulsierender Punkt =
  ändert gerade Code. Live folgt der gewählten Session; Änderungen in anderen
  Sessions lassen nur deren Punkt kurz aufblinken.
- **Navigator** (links): Ordnerbaum der geänderten Dateien, **A** = neu, **M** = geändert,
  dazu `+`/`−`.
- **Code** (Editor-Ansicht): die ganze Datei mit Zeilennummern. Die letzte Änderung ist im Rand markiert
  (grün = neu, bernstein = geändert, roter Keil = gelöscht, Maus darüber zeigt den alten
  Text). Bei neuen Änderungen scrollt die Ansicht hin, gelöschte Zeilen erscheinen kurz
  durchgestrichen und klappen dann ein.
- **Branch**: rechts in der Pfadzeile der Branch des Repos, in dem die Datei liegt.
  Bei Unter-Repos (nächstes `.git` oberhalb der Datei, auch Submodule/Worktrees)
  steht der Repo-Name davor. Gelesen wird direkt `.git/HEAD`, ohne `git`-Aufruf.
- **Karten-Ansicht**: Karten leuchten bei Änderungen auf, der Balken wächst; in der
  Mitte alle Änderungen der Datei als Diff, die neueste oben.
- **Hinweisleiste**: Ändert sich eine andere als die angezeigte Datei, erscheint unten
  kurz ein Hinweis.
- **Live**: folgt automatisch der aktuellen Datei. Klick auf eine Datei hält fest,
  zurück mit „Live folgen“ oder `Esc`.
- **Pixel-Junior** (unten links): tippt, wenn Code
  kommt, legt neue Dateien ab, radiert bei Löschungen, schläft nach 2 Minuten Ruhe ein
  und kommentiert ab und zu, was passiert. Taste `d` führt alle Reaktionen vor.
  Die Pixel-Schrift (Pixelify Sans, SIL Open Font License) liegt lokal in
  `public/fonts/`, es wird nichts aus dem Internet geladen.

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
- `public/app.js` – Live-Logik, Sessions, Navigator, Code-Ansicht
- `public/buddy.js` – der Pixel-Junior
- `public/logo.js` – das Pixel-Logo (eigene 5×7-Buchstaben als SVG)
- `public/base/` – eingefrorene Basis-Ansicht
- `public/highlight.js` – kleiner eigener Syntax-Highlighter
