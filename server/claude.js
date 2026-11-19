'use strict'
// Source: Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).

const fs = require('fs')
const path = require('path')
const { PROJECTS, ACTIVE_MS, MAX_SESSIONS, MAX_AFTER } = require('./config')
const { applyPatch, lineDiff } = require('./diff')
const { normText, normLine, displayPath } = require('./text')
const { repoFor, checkRepos } = require('./repos')
const { committedText } = require('./git')
const { sessions, nextSeq, rememberBase, sessionInfo, snapshotV2, primary, snapshotV1, emitChanges } = require('./sessions')
const { broadcast } = require('./bus')

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
        lines: h.lines.map(normLine),
      }))
  }

  // "update" means the file existed, even if the log has no old content
  const isCreate = r.type === 'create' || (r.type !== 'update' && r.originalFile === null && 'content' in r)
  let needsBase = false

  // Whole-file write (Write tool) without a patch: compute the real diff from
  // the old content instead of showing every line as added.
  if (hunks.length === 0 && typeof r.originalFile === 'string' && typeof r.content === 'string') {
    hunks = lineDiff(normText(r.originalFile), normText(r.content))
    if (!hunks.length) return null // nothing actually changed
  }

  // New file (or old content unknown): content as all-"+" lines.
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
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => '+' + normLine(l)) }]
    needsBase = !isCreate // existed before: readNew diffs against the last version it knows
  }

  // File content after the change, for the editor view.
  let after = null
  if (typeof r.content === 'string' && (r.type === 'create' || r.type === 'update')) after = normText(r.content)
  else if (typeof r.originalFile === 'string' && Array.isArray(r.structuredPatch)) after = applyPatch(normText(r.originalFile), hunks)
  if (after !== null && after.length > MAX_AFTER) after = null

  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l[0] === '+') added++
      else if (l[0] === '-') removed++
    }

  // Content before this change: empty for a new file, else the log's old content.
  const before = isCreate ? '' : typeof r.originalFile === 'string' ? normText(r.originalFile) : null

  const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
  return {
    before,
    id: seq,
    filePath,
    rel: displayPath(filePath, cwd),
    kind: isCreate ? 'create' : 'update',
    needsBase,
    hunks,
    added,
    removed,
    after,
    ts: Date.parse(entry.timestamp) || Date.now(),
  }
}

function addSession(info) {
  const s = {
    ...info,
    cwd: '',
    title: sessionTitle(info),
    changes: [],
    logs: new Map(),
    contents: new Map(),
    bases: new Map(), // file -> content when it first changed in this session (for the session diff)
    tools: { edit: 0, shell: 0, mcp: 0 }, // tool calls seen, for the status view
    // git fallback: repo root -> { head, dirty: Set<rel>, ready }
    git: { repos: new Map(), roots: [], found: 0, busy: false, wanted: true, last: 0, count: 0 },
  }
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
        const disk = normText(fs.readFileSync(c.filePath, 'utf8'))
        if (matches(disk, c.hunks)) c.after = disk
      }
    } catch {}
  }
  if (c.after !== null) s.contents.set(c.filePath, c.after)
  else s.contents.delete(c.filePath)
}

/**
 * Counts the agent's tool calls. Only Edit/Write/NotebookEdit leave a diff in
 * the log; files changed through the shell or MCP tools stay invisible.
 */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
// Shell commands that probably write files (a heuristic, not a parser).
const SHELL_WRITE =
  /\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-\w*i|\btee\b|<<-?\s*['"]?\w|(^|[^\d&2])>{1,2}\s*(?!\/dev\/null|&)[\w./~$"']|\bgit\s+(apply|am|checkout\s+--|restore)\b|\bpatch\b|\b(mv|cp|rm|touch|truncate)\s|Set-Content|Out-File|Add-Content/
// MCP tools whose name sounds like changing something and that get a file path.
const MCP_WRITE = /write|update|edit|create|replace|patch|insert|move|\bmv\b|delete|rm$|remove|save/i
const hasPathArg = input =>
  !!input && typeof input === 'object' && Object.keys(input).some(k => /^(file_?path|path|file_?name|source_?path|target_?path|uri)$/i.test(k))
function countTools(s, entry) {
  const content = entry.message && entry.message.content
  if (entry.type !== 'assistant' || !Array.isArray(content)) return
  for (const c of content) {
    if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue
    if (EDIT_TOOLS.has(c.name)) s.tools.edit++
    else if (c.name === 'Bash' || c.name === 'PowerShell') {
      const cmd = c.input && typeof c.input.command === 'string' ? c.input.command : ''
      if (SHELL_WRITE.test(cmd)) s.tools.shell++
    } else if (c.name.startsWith('mcp__') && MCP_WRITE.test(c.name.split('__').pop()) && hasPathArg(c.input)) s.tools.mcp++
  }
}

/** Reads new complete lines of a log file. */
function readNew(s, file, sink, live = false) {
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
      if (!s.started && entry.timestamp) s.started = Date.parse(entry.timestamp) || 0
      countTools(s, entry)
      const change = toChange(entry, nextSeq())
      if (change) {
        let prev = s.contents.get(change.filePath)
        // git HEAD only for changes happening now – for old history HEAD may already be newer
        if (change.needsBase && typeof prev !== 'string' && live) prev = committedText(change.filePath)
        if (change.needsBase && typeof prev === 'string' && typeof change.after === 'string') {
          change.hunks = lineDiff(prev, change.after)
          change.added = change.removed = 0
          for (const h of change.hunks)
            for (const l of h.lines) {
              if (l[0] === '+') change.added++
              else if (l[0] === '-') change.removed++
            }
        }
        delete change.needsBase
        rememberBase(s, change, change.before ?? (typeof prev === 'string' ? prev : null), live)
        delete change.before
        fillAfter(s, change)
        change.repo = repoFor(path.dirname(change.filePath))
        sink.push(change)
      } else if (entry.toolUseResult) s.git.wanted = true // a tool finished that may have changed files
    }
  } finally {
    fs.closeSync(fd)
  }
}

function poll() {
  for (const s of sessions.values()) {
    const fresh = []
    for (const file of [s.file, ...subagentLogs(s)]) readNew(s, file, fresh, true)
    emitChanges(s, fresh)
  }
}

/** Sessions the user opened by hand ("+" in the tab bar): watched even when old. */
const pinned = new Set()

let lastPrimary = null
function scan() {
  const now = Date.now()
  const files = listSessionFiles().sort((a, b) => b.mtime - a.mtime)
  const wanted = files.filter((f, i) => i === 0 || now - f.mtime < ACTIVE_MS).slice(0, MAX_SESSIONS)
  for (const f of files) if (pinned.has(f.id) && !wanted.includes(f)) wanted.push(f)
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
// Session list for the "+" menu: the most recent sessions, open or not.

const LIST_MAX = 40
const headCache = new Map() // id -> { cwd, prompt }

/** Project folder and first prompt, read from the start of a log (cached). */
function sessionHead(f) {
  if (headCache.has(f.id)) return headCache.get(f.id)
  const head = { cwd: '', prompt: '' }
  let fd
  try {
    fd = fs.openSync(f.file, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (head.cwd && head.prompt) break
      if (!line.includes('"cwd"') && !line.includes('"type":"user"')) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (!head.cwd && typeof e.cwd === 'string') head.cwd = e.cwd
      if (!head.prompt && e.type === 'user' && !e.isMeta && e.message) {
        const c = e.message.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x && x.type === 'text') || {}).text : ''
        if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) head.prompt = text.replace(/\s+/g, ' ').trim().slice(0, 90)
      }
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  if (head.cwd) headCache.set(f.id, head) // retry later if the log is still empty
  return head
}

function sessionList() {
  return listSessionFiles()
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LIST_MAX)
    .map(f => {
      const head = sessionHead(f)
      return {
        id: f.id,
        title: sessionTitle(f),
        project: head.cwd ? path.basename(head.cwd) : '',
        cwd: head.cwd,
        prompt: head.prompt,
        active: f.mtime,
        watched: sessions.has(f.id),
      }
    })
}

module.exports = { listSessionFiles, subagentLogs, sessionTitle, toChange, addSession, readNew, poll, pinned, scan, sessionList }
