# Watch Him Code

A lean window for your second screen: look over the Claude Code agent's shoulder while it
codes. It shows **only code changes** (new and modified files), live, the moment they
happen. No thoughts, no costs, no history.

## Mac app

A real app you double-click: `dist/Watch Him Code.app`. It starts the server invisibly,
shows the UI in its own window (system WebView, no browser needed) and stops the server
again when you quit – even if the app crashes. Window size and position are remembered,
the title bar follows light/dark.

Build it (requires Xcode or the Command Line Tools; about 1 MB plus the UI):

```bash
./app/macos/build.sh
```

Then drag `dist/Watch Him Code.app` into your Applications folder, for example. Node.js 18+
must be installed; the app finds it the way the Terminal does (login shell) or in the
usual places (Homebrew, nvm, Volta). Server and UI are copied into the app at build time –
rebuild after changing the code.

## Windows app

Same idea as on the Mac: `WatchHimCode.exe` starts the server invisibly, shows the UI in
its own window (WebView2, the Edge engine) and stops the server when closed. It is built
on .NET Framework 4.8, which ships with Windows 10/11, so nothing besides Node.js needs to
be installed. The WebView2 runtime comes with Windows 11 and current Windows 10 versions;
if it's missing, the app offers to open the download page.

Build it (works on the Mac too, requires the .NET SDK):

```bash
./app/windows/build.sh
```

Output: `dist/WatchHimCode-windows.zip` (about 360 KB). Unzip it on the Windows machine and
double-click `WatchHimCode.exe`; create a shortcut for the Start menu or taskbar. On first
launch Windows SmartScreen may say "Unknown publisher" → "More info" → "Run anyway" (the
app is not signed).

## Running without the apps

```bash
node server.js
```

This opens **its own app window** (no address bar or tabs) at `http://127.0.0.1:4777`,
using Chrome, Edge, Brave or Chromium in app mode (`--app=…`); if none of them is
installed, your default browser opens instead. Edge is always available on Windows.

If Watch Him Code is already running, a second start only opens another window, not a
second server. If the port is taken by something else, the next free one is used.
Stop it with `Ctrl+C`.

**Install as an app (optional):** in the app window or in Chrome/Edge via the menu
"Install" / "Install as app". Watch Him Code then shows up in Launchpad or the Start menu
with the Pixel Junior as its icon (the server has to be running). With Safari on macOS
Sonoma or later: File → Add to Dock.

Requirement: Node.js 18 or newer. No `npm install` needed.

## Using it

Read-only – nothing gets edited. The slider icon at the top right (settings) lets you
switch the following; everything is stored in the browser:

- **View**: *Editor* (Xcode-like: folder tree, whole file, changes in the gutter) or
  *Cards* (file cards with bars, diff blocks of all changes to a file). Both have the
  same features. Key `v`.
- **Diff**: *New* (only the new version, changes marked), *Inline* (old and new stacked)
  or *Side by side* (old on the left, new on the right, gaps hatched). Applies to both
  views. New files have no previous version and are shown as *New*; if the window is too
  narrow (content area under about 900 px), *Inline* is used. A note in the path bar
  tells you when that happens. Key `s`.
- **Theme**: Light, Dark or System. Key `t`.
- **Pixel Junior**: on/off.

What you see:

- **Title bar**: all sessions from the last 30 minutes as tabs. A pulsing green dot means
  that session is changing code right now. Live follows the selected session; changes in
  other sessions only make their dot blink briefly.
- **Navigator** (left): folder tree of changed files, **A** = added, **M** = modified,
  plus `+`/`−`.
- **Code** (editor view): the whole file with line numbers. The latest change is marked in
  the gutter (green = new, amber = modified, red wedge = deleted; hover to see the old
  text). On new changes the view scrolls there; deleted lines briefly appear struck
  through and then collapse.
- **Cards view**: cards light up on changes and their bar grows; in the middle, all
  changes to the file as diffs, newest first.
- **Branch**: on the right of the path bar, the branch of the repo the file lives in. For
  nested repos (nearest `.git` above the file, also submodules/worktrees) the repo name is
  shown in front. Read straight from `.git/HEAD`, no `git` call.
- **Toast**: when a file other than the one shown changes, a short note pops up at the
  bottom.
- **Live**: automatically follows the current file. Clicking a file pins it; go back with
  "Follow live" or `Esc`.
- **Pixel Junior** (bottom left): types when code comes in, drops new files, erases on
  deletions, falls asleep after 2 minutes of quiet and now and then comments on what's
  happening. Key `d` plays all reactions. The pixel font (Pixelify Sans, SIL Open Font
  License) is bundled in `public/fonts/`; nothing is loaded from the internet.

## How it works

Claude Code (terminal and desktop app alike) writes every session as a log to
`~/.claude/projects/<project>/<session>.jsonl`. The server

1. watches all sessions written to in the last 30 minutes (max. 6),
2. reads new lines incrementally (every 0.6 s),
3. picks entries with `toolUseResult.filePath` + `structuredPatch` (Edit, Write,
   MultiEdit; NotebookEdit tolerated),
4. sends them to the page via Server-Sent Events.

Subagent logs under `<session>/subagents/` are read as well. Only changes made through
Claude's file tools show up – edits made by shell commands are not in the log.

The server listens on `127.0.0.1` only, so it's not reachable from outside.

## Views

- `http://127.0.0.1:4777/` – current UI
- `http://127.0.0.1:4777/base/` – **base mode**: frozen state of step 1 (German), no longer
  changed. Also kept in the git tag `base`.

## Options

| Variable              | Effect                              |
| --------------------- | ----------------------------------- |
| `WHC_PORT`            | different start port (default 4777) |
| `WHC_NO_OPEN=1`       | don't open a window                 |
| `WHC_BROWSER=default` | default browser instead of app window |

## Files

- `server.js` – watcher + HTTP/SSE server (Node built-ins only)
- `public/index.html`, `style.css` – UI
- `public/app.js` – live logic, sessions, navigator, code view
- `public/buddy.js` – the Pixel Junior
- `public/logo.js` – the pixel logo (custom 5×7 letters as SVG)
- `public/highlight.js` – small home-made syntax highlighter
- `public/manifest.webmanifest`, `icon*.png`, `icon.svg` – app icon and web app metadata
- `public/base/` – frozen base view
- `app/macos/` – Mac app: `main.swift` (window + server start), `Info.plist`, icon, `build.sh`
- `app/windows/` – Windows app: `Program.cs` (window + server start), project, icon, `build.sh`
