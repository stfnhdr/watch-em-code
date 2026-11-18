#!/usr/bin/env node
// Watch Him Code – zeigt live die Code-Änderungen laufender Claude-Code-Sessions.
// Keine Abhängigkeiten, nur Node-Bordmittel.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const HOST = '127.0.0.1'
const START_PORT = Number(process.env.WHC_PORT) || 4777
const POLL_MS = 600 // neue Zeilen lesen
const SCAN_MS = 2000 // Sessions suchen
const ACTIVE_MS = 30 * 60 * 1000 // Session gilt so lange als aktiv
const MAX_SESSIONS = 6
const MAX_AFTER = 2 * 1024 * 1024 // größere Dateien nur als Diff
const PUBLIC = path.join(__dirname, 'public')

// ---------------------------------------------------------------------------
// Protokoll lesen

/** Alle Session-Protokolle: ~/.claude/projects/<projekt>/<session>.jsonl */
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

/** Protokolle von Subagenten liegen in <session>/subagents/*.jsonl. */
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

/** Titel, den der User der Session gegeben hat (falls vorhanden). */
function sessionTitle(s) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(s.dir, s.id, 'custom-title.json'), 'utf8'))
    return typeof o.customTitle === 'string' ? o.customTitle : ''
  } catch {
    return ''
  }
}

/** Wendet einen structuredPatch auf den alten Inhalt an. */
function applyPatch(original, hunks) {
  const src = original.split('\n')
  const out = []
  let i = 0 // Index in src
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1 + (h.oldLines === 0 ? 1 : 0))
    if (start < i) return null // Hunks nicht sortiert oder überlappend
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

/** Erstellt aus einem toolUseResult eine Änderung, oder null. */
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

  // Neue Datei ohne Patch: Inhalt als lauter +-Zeilen.
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

  // Inhalt der Datei nach der Änderung, für die Editor-Ansicht.
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
// Beobachtete Sessions

let seq = 0
/** id -> { id, file, dir, mtime, cwd, title, changes[], logs: Map } */
const sessions = new Map()

function addSession(info) {
  const s = { ...info, cwd: '', title: sessionTitle(info), changes: [], logs: new Map() }
  sessions.set(s.id, s)
  const fresh = []
  for (const file of [s.file, ...subagentLogs(s)]) readNew(s, file, fresh)
  fresh.sort((a, b) => a.ts - b.ts)
  s.changes = fresh
  return s
}

/** Liest neue vollständige Zeilen einer Protokolldatei. */
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
    log.rest = lines.pop() // unvollständige letzte Zeile aufheben
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
      if (change) sink.push(change)
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
    active: s.mtime,
    lastChange: last,
    count: s.changes.length,
  }
}

/** Snapshot ohne Dateiinhalt bei älteren Änderungen (nur der letzte Stand je Datei). */
function slimChanges(changes) {
  const latest = new Map()
  for (const c of changes) latest.set(c.filePath, c.id)
  return changes.map(c => (latest.get(c.filePath) === c.id ? c : { ...c, after: null }))
}

function snapshotV2() {
  return {
    sessions: [...sessions.values()].map(s => ({ ...sessionInfo(s), changes: slimChanges(s.changes) })),
  }
}

// Für die eingefrorene Basis-Ansicht (/base/): nur die zuletzt aktive Session.
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
  if (changed) broadcast(2, 'reset', snapshotV2())

  const p = primary()
  if (p && p !== lastPrimary) {
    lastPrimary = p
    console.log(`Aktivste Session: ${p.id}`)
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
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

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

  // Eingefrorene Ansichten liegen als Unterordner in public/ (z. B. /base/).
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
      res.writeHead(404).end('Nicht gefunden')
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })
})

// Hält die Verbindungen offen.
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n')
}, 20000).unref()

function openBrowser(url) {
  if (process.env.WHC_NO_OPEN) return
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

function listen(port) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && port < START_PORT + 20) listen(port + 1)
    else throw err
  })
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`
    console.log(`Watch Him Code läuft auf ${url}  (Beenden mit Strg+C)`)
    scan()
    setInterval(poll, POLL_MS)
    setInterval(scan, SCAN_MS)
    openBrowser(url)
  })
}

if (require.main === module) listen(START_PORT)
else module.exports = { applyPatch, toChange }
