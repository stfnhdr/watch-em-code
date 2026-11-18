#!/usr/bin/env node
// Watch Him Code – zeigt live die Code-Änderungen der zuletzt aktiven
// Claude-Code-Session. Keine Abhängigkeiten, nur Node-Bordmittel.
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
const SCAN_MS = 2000 // nach einer aktiveren Session suchen
const PUBLIC = path.join(__dirname, 'public')

// ---------------------------------------------------------------------------
// Protokoll lesen

/** Alle Session-Protokolle: ~/.claude/projects/<projekt>/<session>.jsonl */
function listSessions() {
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
        const st = fs.statSync(file)
        out.push({ file, mtime: st.mtimeMs, id: name.slice(0, -6), dir })
      } catch {}
    }
  }
  return out
}

/** Protokolle von Subagenten liegen in <session>/subagents/*.jsonl. */
function subagentLogs(session) {
  const dir = path.join(session.dir, session.id, 'subagents')
  try {
    return fs
      .readdirSync(dir)
      .filter(n => n.endsWith('.jsonl'))
      .map(n => path.join(dir, n))
  } catch {
    return []
  }
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

  const isCreate =
    r.type === 'create' || (r.originalFile === null && 'content' in r)

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
    const lines = text.replace(/\n$/, '').split('\n')
    if (text === '') lines.length = 0
    hunks = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => '+' + l) },
    ]
  }

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
    notebook: Boolean(r.notebook_path),
    hunks,
    added,
    removed,
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
// Zustand der beobachteten Session

let seq = 0
const state = {
  session: null, // { file, id, dir }
  cwd: '',
  changes: [],
  logs: new Map(), // file -> { offset, rest }
}

function resetTo(session) {
  state.session = session
  state.cwd = ''
  state.changes = []
  state.logs = new Map()
  const fresh = []
  for (const file of [session.file, ...subagentLogs(session)]) readNew(file, fresh)
  fresh.sort((a, b) => a.ts - b.ts)
  state.changes = fresh
  broadcast('reset', snapshot())
}

function snapshot() {
  const s = state.session
  return {
    sessionId: s ? s.id : null,
    cwd: state.cwd,
    project: state.cwd ? path.basename(state.cwd) : '',
    changes: state.changes,
  }
}

/** Liest neue vollständige Zeilen einer Protokolldatei. */
function readNew(file, sink) {
  let log = state.logs.get(file)
  if (!log) {
    log = { offset: 0, rest: '' }
    state.logs.set(file, log)
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
    const text = log.rest + buf.toString('utf8')
    const lines = text.split('\n')
    log.rest = lines.pop() // unvollständige letzte Zeile aufheben
    for (const line of lines) {
      if (!line.includes('toolUseResult') && !line.includes('"cwd"')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof entry.cwd === 'string' && !entry.isSidechain) state.cwd = entry.cwd
      else if (!state.cwd && typeof entry.cwd === 'string') state.cwd = entry.cwd
      const change = toChange(entry, ++seq)
      if (change) sink.push(change)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function poll() {
  const s = state.session
  if (!s) return
  const fresh = []
  const files = [s.file, ...subagentLogs(s)]
  for (const file of files) readNew(file, fresh)
  fresh.sort((a, b) => a.ts - b.ts)
  for (const c of fresh) {
    state.changes.push(c)
    broadcast('change', c)
  }
}

function scan() {
  const sessions = listSessions()
  if (sessions.length === 0) return
  sessions.sort((a, b) => b.mtime - a.mtime)
  const newest = sessions[0]
  if (!state.session || newest.file !== state.session.file) {
    console.log(`Beobachte Session ${newest.id}`)
    resetTo(newest)
  }
}

// ---------------------------------------------------------------------------
// HTTP + Server-Sent Events

const clients = new Set()

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(msg)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`event: reset\ndata: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
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

// Hält die Verbindungen hinter Proxys und Energiesparmodi offen.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 20000)

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

listen(START_PORT)
