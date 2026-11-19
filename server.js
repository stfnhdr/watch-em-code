#!/usr/bin/env node
// Watch Him Code – shows the code changes of running Claude Code sessions live.
// No dependencies, Node built-ins only.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const HOST = '127.0.0.1'
const START_PORT = Number(process.env.WHC_PORT) || 4777
const POLL_MS = 600 // read new lines
const SCAN_MS = 2000 // look for sessions
const ACTIVE_MS = 30 * 60 * 1000 // a session counts as active for this long
const MAX_SESSIONS = 6
const MAX_AFTER = 2 * 1024 * 1024 // larger files only as diff
const PUBLIC = path.join(__dirname, 'public')

// ---------------------------------------------------------------------------
// Reading the logs

/** All session logs: ~/.claude/projects/<project>/<session>.jsonl */
function listSessionFiles() {
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(PROJECTS, { withFileTypes: true })
  } catch {
    return out
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const dir = path.join(PROJECTS, p.name)
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      try {
        out.push({ file, dir, id: name.slice(0, -6), mtime: fs.statSync(file).mtimeMs })
      } catch {}
    }
  }
  return out
}

/** Subagent logs live in <session>/subagents/*.jsonl. */
function subagentLogs(s) {
  const dir = path.join(s.dir, s.id, 'subagents')
  try {
    return fs
      .readdirSync(dir)
      .filter(n => n.endsWith('.jsonl'))
      .map(n => path.join(dir, n))
  } catch {
    return []
  }
}

/** Title the user gave the session (if any). */
function sessionTitle(s) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(s.dir, s.id, 'custom-title.json'), 'utf8'))
    return typeof o.customTitle === 'string' ? o.customTitle : ''
  } catch {
    return ''
  }
}

/** Applies a structuredPatch to the old content. */
function applyPatch(original, hunks) {
  const src = original.split('\n')
  const out = []
  let i = 0 // index into src
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1 + (h.oldLines === 0 ? 1 : 0))
    if (start < i) return null // hunks unsorted or overlapping
    while (i < start && i < src.length) out.push(src[i++])
    for (const l of h.lines) {
      if (l[0] === '+') out.push(l.slice(1))
      else if (l[0] === ' ') {
        out.push(l.slice(1))
        i++
      } else if (l[0] === '-') i++
    }
  }
  while (i < src.length) out.push(src[i++])
  return out.join('\n')
}

/** Turns a toolUseResult into a change, or null. */
function toChange(entry, seq) {
  const r = entry && entry.toolUseResult
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const filePath = r.filePath || r.notebook_path || r.file_path
  if (typeof filePath !== 'string' || !filePath) return null

  let hunks = []
  if (Array.isArray(r.structuredPatch)) {
    hunks = r.structuredPatch
      .filter(h => h && Array.isArray(h.lines))
      .map(h => ({
        oldStart: Number(h.oldStart) || 0,
        oldLines: Number(h.oldLines) || 0,
        newStart: Number(h.newStart) || 0,
        newLines: Number(h.newLines) || 0,
        lines: h.lines.map(String),
      }))
  }

  const isCreate = r.type === 'create' || (r.originalFile === null && 'content' in r)

  // New file without a patch: content as all-"+" lines.
  if (hunks.length === 0) {
    const text =
      typeof r.content === 'string'
        ? r.content
        : typeof r.new_source === 'string'
          ? r.new_source
          : typeof r.newString === 'string'
            ? r.newString
            : null
    if (text === null) return null
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => '+' + l) }]
  }

  // File content after the change, for the editor view.
  let after = null
  if (typeof r.content === 'string' && (r.type === 'create' || r.type === 'update')) after = r.content
  else if (typeof r.originalFile === 'string' && Array.isArray(r.structuredPatch)) after = applyPatch(r.originalFile, hunks)
  if (after !== null && after.length > MAX_AFTER) after = null

  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l[0] === '+') added++
      else if (l[0] === '-') removed++
    }

  const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
  return {
    id: seq,
    filePath,
    rel: displayPath(filePath, cwd),
    kind: isCreate ? 'create' : 'update',
    hunks,
    added,
    removed,
    after,
    ts: Date.parse(entry.timestamp) || Date.now(),
  }
}

function displayPath(file, cwd) {
  if (cwd) {
    const rel = path.relative(cwd, file)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  }
  const home = os.homedir()
  if (file.startsWith(home)) return '~' + file.slice(home.length).split(path.sep).join('/')
  return file.split(path.sep).join('/')
}

// ---------------------------------------------------------------------------
// Git: branch per repo, read straight from .git/HEAD (no git call needed).
// We search upwards from the file's folder for the nearest .git – for
// nested repos and submodules that is automatically the innermost one.

const repos = new Map() // root folder -> { root, name, headFile, branch }
const dirRepo = new Map() // folder -> root folder | null (cache)

function readBranch(headFile) {
  try {
    const head = fs.readFileSync(headFile, 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : head.slice(0, 7) // detached: short commit
  } catch {
    return ''
  }
}

const repoInfo = r => ({ root: r.root, name: r.name, branch: r.branch })

function repoFor(dir) {
  if (!dir) return null
  if (dirRepo.has(dir)) return dirRepo.get(dir)
  let root = null
  for (let d = dir; ; d = path.dirname(d)) {
    const g = path.join(d, '.git')
    let st = null
    try {
      st = fs.statSync(g)
    } catch {}
    if (st) {
      let gitdir = g
      if (st.isFile()) {
        // submodule or worktree: .git is a file pointing elsewhere
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'))
          gitdir = m ? path.resolve(d, m[1].trim()) : null
        } catch {
          gitdir = null
        }
      }
      if (gitdir) {
        root = d
        if (!repos.has(d)) {
          const headFile = path.join(gitdir, 'HEAD')
          const r = { root: d, name: path.basename(d), headFile, branch: readBranch(headFile) }
          repos.set(d, r)
          broadcast(2, 'repo', repoInfo(r))
        }
      }
      break
    }
    if (path.dirname(d) === d) break
  }
  dirRepo.set(dir, root)
  return root
}

/** Detect branch switches; occasionally look for new .git folders. */
let gitTick = 0
function checkRepos() {
  for (const r of repos.values()) {
    const branch = readBranch(r.headFile)
    if (branch !== r.branch) {
      r.branch = branch
      broadcast(2, 'repo', repoInfo(r))
    }
  }
  if (++gitTick % 15 === 0) dirRepo.clear()
}

// ---------------------------------------------------------------------------
// Watched sessions

let seq = 0
/** id -> { id, file, dir, mtime, cwd, title, changes[], logs: Map } */
const sessions = new Map()

function addSession(info) {
  const s = { ...info, cwd: '', title: sessionTitle(info), changes: [], logs: new Map(), contents: new Map() }
  sessions.set(s.id, s)
  const fresh = []
  for (const file of [s.file, ...subagentLogs(s)]) readNew(s, file, fresh)
  fresh.sort((a, b) => a.ts - b.ts)
  s.changes = fresh
  return s
}

/** Does a file content match the new lines of the hunks? */
function matches(text, hunks) {
  const lines = text.split('\n')
  for (const h of hunks) {
    let n = h.newStart - 1
    for (const l of h.lines) {
      if (l[0] !== ' ' && l[0] !== '+') continue
      if (lines[n] !== l.slice(1)) return false
      n++
    }
  }
  return true
}

/**
 * Some entries don't contain the old content (originalFile = null).
 * Then carry the last known version forward or, as a last resort,
 * read the file from disk – but only if it matches the change.
 */
function fillAfter(s, c) {
  if (c.after === null) {
    const prev = s.contents.get(c.filePath)
    if (typeof prev === 'string') {
      const next = applyPatch(prev, c.hunks)
      if (next !== null && matches(next, c.hunks)) c.after = next
    }
  }
  if (c.after === null) {
    try {
      if (fs.statSync(c.filePath).size <= MAX_AFTER) {
        const disk = fs.readFileSync(c.filePath, 'utf8')
        if (matches(disk, c.hunks)) c.after = disk
      }
    } catch {}
  }
  if (c.after !== null) s.contents.set(c.filePath, c.after)
  else s.contents.delete(c.filePath)
}

/** Reads new complete lines of a log file. */
function readNew(s, file, sink) {
  let log = s.logs.get(file)
  if (!log) {
    log = { offset: 0, rest: '' }
    s.logs.set(file, log)
  }
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (size < log.offset) {
    log.offset = 0
    log.rest = ''
  }
  if (size === log.offset) return

  const fd = fs.openSync(file, 'r')
  try {
    const len = size - log.offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, log.offset)
    log.offset = size
    const lines = (log.rest + buf.toString('utf8')).split('\n')
    log.rest = lines.pop() // keep the incomplete last line
    for (const line of lines) {
      if (!line.includes('toolUseResult') && !line.includes('"cwd"')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof entry.cwd === 'string' && (!entry.isSidechain || !s.cwd)) s.cwd = entry.cwd
      const change = toChange(entry, ++seq)
      if (change) {
        fillAfter(s, change)
        change.repo = repoFor(path.dirname(change.filePath))
        sink.push(change)
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

function sessionInfo(s) {
  const last = s.changes.length ? s.changes[s.changes.length - 1].ts : 0
  return {
    id: s.id,
    project: s.cwd ? path.basename(s.cwd) : '',
    cwd: s.cwd,
    title: s.title,
    repo: repoFor(s.cwd),
    active: s.mtime,
    lastChange: last,
    count: s.changes.length,
  }
}

/** Snapshot without file content for older changes (only the latest version per file). */
function slimChanges(changes) {
  const latest = new Map()
  for (const c of changes) latest.set(c.filePath, c.id)
  return changes.map(c => (latest.get(c.filePath) === c.id ? c : { ...c, after: null }))
}

function snapshotV2() {
  return {
    sessions: [...sessions.values()].map(s => ({ ...sessionInfo(s), changes: slimChanges(s.changes) })),
    repos: [...repos.values()].map(repoInfo),
  }
}

// For the frozen base view (/base/): only the most recently active session.
function primary() {
  let best = null
  for (const s of sessions.values()) if (!best || s.mtime > best.mtime) best = s
  return best
}
function snapshotV1() {
  const s = primary()
  return {
    sessionId: s ? s.id : null,
    cwd: s ? s.cwd : '',
    project: s && s.cwd ? path.basename(s.cwd) : '',
    changes: s ? s.changes.map(c => ({ ...c, after: undefined })) : [],
  }
}

function poll() {
  for (const s of sessions.values()) {
    const fresh = []
    for (const file of [s.file, ...subagentLogs(s)]) readNew(s, file, fresh)
    if (!fresh.length) continue
    fresh.sort((a, b) => a.ts - b.ts)
    for (const c of fresh) {
      s.changes.push(c)
      broadcast(2, 'change', { sessionId: s.id, change: c })
      if (primary() === s) broadcast(1, 'change', { ...c, after: undefined })
    }
    broadcast(2, 'session', sessionInfo(s))
  }
}

let lastPrimary = null
function scan() {
  const now = Date.now()
  const files = listSessionFiles().sort((a, b) => b.mtime - a.mtime)
  const wanted = files.filter((f, i) => i === 0 || now - f.mtime < ACTIVE_MS).slice(0, MAX_SESSIONS)
  const wantedIds = new Set(wanted.map(f => f.id))
  let changed = false

  for (const id of [...sessions.keys()])
    if (!wantedIds.has(id)) {
      sessions.delete(id)
      changed = true
    }
  for (const f of wanted) {
    const s = sessions.get(f.id)
    if (!s) {
      addSession(f)
      changed = true
    } else {
      if (s.mtime !== f.mtime) {
        s.mtime = f.mtime
        broadcast(2, 'session', sessionInfo(s))
      }
      const title = sessionTitle(s)
      if (title !== s.title) {
        s.title = title
        broadcast(2, 'session', sessionInfo(s))
      }
    }
  }
  checkRepos()
  if (changed) broadcast(2, 'reset', snapshotV2())

  const p = primary()
  if (p && p !== lastPrimary) {
    lastPrimary = p
    console.log(`Most active session: ${p.id}`)
    broadcast(1, 'reset', snapshotV1())
  }
}

// ---------------------------------------------------------------------------
// HTTP + Server-Sent Events

const clients = new Set() // { res, v }

function broadcast(v, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) if (c.v === v) c.res.write(msg)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/whc') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"watch-him-code"}')
    return
  }

  if (url.pathname === '/events') {
    const v = url.searchParams.get('v') === '2' ? 2 : 1
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`event: reset\ndata: ${JSON.stringify(v === 2 ? snapshotV2() : snapshotV1())}\n\n`)
    const client = { res, v }
    clients.add(client)
    req.on('close', () => clients.delete(client))
    return
  }

  // Frozen views live as subfolders in public/ (e.g. /base/).
  if (/^\/[\w-]+$/.test(url.pathname) && fs.existsSync(path.join(PUBLIC, url.pathname, 'index.html'))) {
    res.writeHead(301, { Location: url.pathname + '/' }).end()
    return
  }
  let name = url.pathname.slice(1)
  if (name === '' || name.endsWith('/')) name += 'index.html'
  const file = path.join(PUBLIC, path.normalize(name))
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end()
    return
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })
})

// Keeps the connections open.
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n')
}, 20000).unref()

// ---------------------------------------------------------------------------
// Opening a window: if possible as its own app window (Chrome, Edge, Brave,
// Chromium in --app mode, no address bar or tabs), otherwise the default browser.

const exists = p => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function findAppBrowser() {
  if (process.platform === 'darwin') {
    const names = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')])
      for (const n of names) {
        const p = path.join(dir, n + '.app')
        if (exists(p)) return { mac: p }
      }
  } else if (process.platform === 'win32') {
    const env = process.env
    const candidates = [
      [env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'],
      [env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'],
      [env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
      [env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env.ProgramFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ]
    for (const [base, rel] of candidates) {
      if (!base) continue
      const p = path.join(base, rel)
      if (exists(p)) return { exe: p }
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    for (const n of names)
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        const p = path.join(dir, n)
        if (exists(p)) return { exe: p }
      }
  }
  return null
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

function openWindow(url) {
  if (process.env.WHC_NO_OPEN) return
  const b = process.env.WHC_BROWSER === 'default' ? null : findAppBrowser()
  const args = [`--app=${url}`, '--window-size=1400,900']
  try {
    if (b && b.mac) {
      spawn('open', ['-na', b.mac, '--args', ...args], { stdio: 'ignore', detached: true }).unref()
      return
    }
    if (b && b.exe) {
      spawn(b.exe, args, { stdio: 'ignore', detached: true }).unref()
      return
    }
  } catch {}
  openBrowser(url)
}

/** Is Watch Him Code already running on this port? */
function isOurs(port) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: '/whc', timeout: 800 }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve(body.includes('watch-him-code')))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function listen(port) {
  server.once('error', async err => {
    if (err.code !== 'EADDRINUSE') throw err
    if (await isOurs(port)) {
      // Already running: just open a window, no second server.
      const url = `http://${HOST}:${port}`
      console.log(`Watch Him Code is already running at ${url} – opening a window only.`)
      openWindow(url)
      setTimeout(() => process.exit(0), 300)
    } else if (port < START_PORT + 20) listen(port + 1)
    else throw err
  })
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`
    console.log(`Watch Him Code is running at ${url}  (stop with Ctrl+C)`)
    scan()
    setInterval(poll, POLL_MS)
    setInterval(scan, SCAN_MS)
    // Started by the Mac/Windows app: exit together with it
    const parent = Number(process.env.WHC_PARENT_PID) || 0
    if (parent)
      setInterval(() => {
        try {
          process.kill(parent, 0)
        } catch {
          process.exit(0)
        }
      }, 3000)
    openWindow(url)
  })
}

if (require.main === module) listen(START_PORT)
else module.exports = { applyPatch, toChange }
