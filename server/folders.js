'use strict'
// Source: any folder, watched directly (fs.watch). Works with every agent – or
// with none. Inside git repos, git decides what changed (and .gitignore keeps
// the noise out); elsewhere a snapshot taken when watching starts is the base.
// Like the git fallback, only changes from the moment it starts are shown.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { DATA_DIR, MAX_AFTER } = require('./config')
const { findRepos } = require('./git')
const { IGNORE_DIRS, IGNORE_FILES, ignored } = require('./ignore')
const { repoFor } = require('./repos')
const { sessions, nextSeq, rememberBase, emitChanges, snapshotV2 } = require('./sessions')
const { gitScan } = require('./shellwatch')
const { readText, same, displayPath } = require('./text')
const { lineDiff } = require('./diff')
const { broadcast } = require('./bus')

const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json')
const SNAP_MAX_FILES = 5000 // snapshot outside git: at most this many files ...
const SNAP_MAX_BYTES = 64 * 1024 * 1024 // ... and this much text
const SETTLE_MS = 300 // wait this long after the last event for a file
const GIT_SETTLE_MS = 400 // ... and for a git rescan

const folderId = dir => 'folder-' + crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12)

/** Is this a folder we can and should watch? Returns an error text or ''. */
function checkFolder(dir) {
  if (!dir || !path.isAbsolute(dir)) return 'Please give a full path.'
  if (dir === os.homedir() || path.dirname(dir) === dir) return 'That folder is too big to watch – pick a project folder.'
  try {
    if (!fs.statSync(dir).isDirectory()) return 'That is not a folder.'
    fs.readdirSync(dir)
  } catch (e) {
    return e.code === 'ENOENT' ? 'That folder does not exist.' : `No access to that folder (${e.code}).`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Watching

function addFolder(dir, save = true) {
  dir = path.resolve(dir)
  const id = folderId(dir)
  if (sessions.has(id)) return sessions.get(id)
  const now = Date.now()
  const s = {
    id,
    kind: 'folder',
    file: null,
    dir: null,
    mtime: now,
    cwd: dir,
    title: path.basename(dir),
    started: now,
    changes: [],
    logs: new Map(),
    contents: new Map(),
    bases: new Map(),
    tools: { edit: 0, shell: 0, mcp: 0 },
    git: { repos: new Map(), roots: [], found: now, busy: false, wanted: false, last: 0, count: 0 },
    watch: { watcher: null, timers: new Map(), gitTimer: null, snap: new Map(), snapDone: false, truncated: false, error: '', closed: false },
  }
  sessions.set(id, s)

  // Git repos in the folder (the one it is in, plus nested ones): first scan only records their state.
  s.git.roots = findRepos(dir)
  if (s.git.roots.length) runGit(s)
  // Outside git: remember every file as it is now, as the base for later diffs.
  if (repoFor(dir)) s.watch.snapDone = true
  else snapshot(s).catch(() => (s.watch.snapDone = true))

  try {
    s.watch.watcher = fs.watch(dir, { recursive: true }, (event, name) => onEvent(s, name))
    s.watch.watcher.on('error', e => (s.watch.error = e.message))
  } catch (e) {
    s.watch.error =
      e.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' ? 'Watching subfolders needs Node.js 20 or newer on this system.' : e.message
  }
  if (save) saveFolders()
  broadcast(2, 'reset', snapshotV2())
  return s
}

function removeFolder(id) {
  const s = sessions.get(id)
  if (!s || s.kind !== 'folder') return false
  s.watch.closed = true
  try {
    s.watch.watcher && s.watch.watcher.close()
  } catch {}
  for (const t of s.watch.timers.values()) clearTimeout(t)
  clearTimeout(s.watch.gitTimer)
  sessions.delete(id)
  saveFolders()
  broadcast(2, 'reset', snapshotV2())
  return true
}

function onEvent(s, name) {
  if (s.watch.closed) return
  if (!name) return scheduleGit(s) // the system didn't say which file: ask git
  const rel = name.toString()
  if (ignored(rel)) return
  const file = path.join(s.cwd, rel)
  const root = repoFor(path.dirname(file))
  if (root) {
    if (!s.git.roots.includes(root)) s.git.roots = findRepos(s.cwd) // e.g. after `git init`
    return scheduleGit(s)
  }
  const w = s.watch
  clearTimeout(w.timers.get(file))
  w.timers.set(
    file,
    setTimeout(() => {
      w.timers.delete(file)
      fileChanged(s, file)
    }, SETTLE_MS),
  )
}

/** Inside git: let git say what changed (debounced). */
function scheduleGit(s, delay = GIT_SETTLE_MS) {
  clearTimeout(s.watch.gitTimer)
  s.watch.gitTimer = setTimeout(() => runGit(s), delay)
}

async function runGit(s) {
  if (s.watch.closed) return
  if (s.git.busy) return scheduleGit(s)
  s.mtime = Date.now()
  s.git.wanted = false
  await gitScan(s, s.git.roots)
  // A file was still being written: look again in a moment.
  if (s.git.wanted && !s.watch.closed) scheduleGit(s, 1300)
}

/** Outside git: diff against the last version we know (or the snapshot). */
function fileChanged(s, file) {
  if (s.watch.closed) return
  const w = s.watch
  const after = readText(file)
  const known = s.contents.has(file)
  const before = known ? s.contents.get(file) : w.snap.has(file) ? w.snap.get(file) : undefined
  if (before === null || after === null) {
    s.contents.set(file, after ?? null) // binary or too large: nothing to show
    return
  }
  if (before === undefined && after === undefined) return
  if (same(before, after) || (before === undefined && after === '')) {
    if (after !== undefined) s.contents.set(file, after)
    return
  }
  const hunks = lineDiff(before ?? '', after ?? '')
  if (!hunks.length) return
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l[0] === '+') added++
      else if (l[0] === '-') removed++
    }
  const change = {
    id: nextSeq(),
    filePath: file,
    rel: displayPath(file, s.cwd),
    kind: before === undefined ? 'create' : 'update',
    hunks,
    added,
    removed,
    after: after ?? '',
    ts: Date.now(),
    repo: null,
    source: after === undefined ? 'watch-deleted' : 'watch',
  }
  rememberBase(s, change, before ?? '')
  if (after === undefined) s.contents.delete(file)
  else s.contents.set(file, after)
  s.mtime = Date.now()
  emitChanges(s, [change])
}

/** Every text file outside git as it is now – the base for later diffs. */
async function snapshot(s) {
  const w = s.watch
  let files = 0
  let bytes = 0
  const walk = async dir => {
    if (w.closed || w.truncated) return
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(e => e.name === '.git')) return // a nested repo: git knows its state
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) await walk(p)
        continue
      }
      if (!e.isFile() || IGNORE_FILES.test(e.name)) continue
      if (files >= SNAP_MAX_FILES || bytes >= SNAP_MAX_BYTES) {
        w.truncated = true
        return
      }
      if (w.snap.has(p) || s.contents.has(p)) continue // changed while we were walking
      let size = 0
      try {
        size = (await fs.promises.stat(p)).size
      } catch {
        continue
      }
      const text = size > MAX_AFTER ? null : readText(p)
      w.snap.set(p, typeof text === 'string' ? text : null)
      files++
      if (typeof text === 'string') bytes += text.length
    }
  }
  await walk(s.cwd)
  w.snapDone = true
}

// ---------------------------------------------------------------------------
// The list of watched folders, kept across restarts

function loadFolders() {
  let list = []
  try {
    list = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'))
  } catch {}
  for (const dir of Array.isArray(list) ? list : []) if (typeof dir === 'string' && !checkFolder(dir)) addFolder(dir, false)
}

function saveFolders() {
  const list = [...sessions.values()].filter(s => s.kind === 'folder').map(s => s.cwd)
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FOLDERS_FILE, JSON.stringify(list, null, 2))
  } catch (e) {
    console.error('Could not save the folder list:', e.message)
  }
}

// ---------------------------------------------------------------------------
// Picking a folder with the system's own dialog (for the browser; the Mac and
// Windows app show their native picker themselves).

function pickFolder() {
  const done = (resolve, err, out) => resolve(err ? '' : String(out || '').trim().replace(/[\\/]$/, '') || '')
  return new Promise(resolve => {
    const opts = { timeout: 10 * 60 * 1000, windowsHide: true }
    if (process.platform === 'darwin')
      execFile('osascript', ['-e', 'try', '-e', 'POSIX path of (choose folder with prompt "Choose a folder to watch")', '-e', 'end try'], opts, (e, o) => done(resolve, e, o))
    else if (process.platform === 'win32')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a folder to watch'; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"],
        opts,
        (e, o) => done(resolve, e, o),
      )
    else execFile('zenity', ['--file-selection', '--directory', '--title=Choose a folder to watch'], opts, (e, o) => done(resolve, e, o))
  })
}

module.exports = { addFolder, removeFolder, loadFolders, checkFolder, pickFolder, folderId }
