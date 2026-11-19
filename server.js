#!/usr/bin/env node
// Watch Him Code – shows the code changes of running Claude Code sessions live.
// No dependencies, Node built-ins only.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, execFile, execFileSync } = require('child_process')

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PROJECTS = path.join(CLAUDE_DIR, 'projects')
const HOST = '127.0.0.1'
const START_PORT = Number(process.env.WHC_PORT) || 4777
const POLL_MS = 600 // read new lines
const SCAN_MS = 2000 // look for sessions
const ACTIVE_MS = 60 * 60 * 1000 // a session counts as active for this long (tabs auto-close after it)
const MAX_SESSIONS = 6
const MAX_AFTER = 2 * 1024 * 1024 // larger files only as diff
const PUBLIC = path.join(__dirname, 'public')
// The Mac/Windows app passes its own version; this is the fallback for `node server.js`.
// When releasing, bump it together with app/macos/Info.plist and app/windows/WatchHimCode.csproj.
const VERSION = process.env.WHC_APP_VERSION || '0.3.5'

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

/**
 * One line-ending style everywhere: CRLF/CR -> LF, no BOM. Otherwise a file
 * whose working copy has CRLF (Windows, core.autocrlf, .gitattributes eol=crlf)
 * differs from git's LF version in every line, and the whole file would show
 * up as changed although only a few lines are.
 */
const normText = t => (typeof t === 'string' ? t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : t)
const normLine = l => String(l).replace(/\r$/, '')

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
// Line diff, for changes found through git (those have no patch in the log).
// Returns hunks in the same format as Claude Code's structuredPatch.

const toLines = t => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))

function lcsOps(A, B) {
  const n = A.length
  const m = B.length
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push([' ', A[i++]])
      j++
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(['-', A[i++]])
    else ops.push(['+', B[j++]])
  }
  while (i < n) ops.push(['-', A[i++]])
  while (j < m) ops.push(['+', B[j++]])
  return ops
}

function lineDiff(before, after, ctx = 3) {
  const a = toLines(before)
  const b = toLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  // Very large middle parts: show as replaced block instead of an expensive LCS.
  const mid = A.length * B.length > 4e6 ? [...A.map(l => ['-', l]), ...B.map(l => ['+', l])] : lcsOps(A, B)
  const ops = [...a.slice(0, pre).map(l => [' ', l]), ...mid, ...a.slice(a.length - suf).map(l => [' ', l])]

  const oldNo = []
  const newNo = []
  let o = 1
  let nn = 1
  for (const op of ops) {
    oldNo.push(o)
    newNo.push(nn)
    if (op[0] !== '+') o++
    if (op[0] !== '-') nn++
  }
  const changed = []
  ops.forEach((op, k) => op[0] !== ' ' && changed.push(k))
  const hunks = []
  for (let g = 0; g < changed.length; g++) {
    const first = changed[g]
    let last = first
    while (g + 1 < changed.length && changed[g + 1] - last <= 2 * ctx + 1) last = changed[++g]
    const from = Math.max(0, first - ctx)
    const to = Math.min(ops.length - 1, last + ctx)
    const lines = []
    let ol = 0
    let nl = 0
    for (let k = from; k <= to; k++) {
      lines.push(ops[k][0] + ops[k][1])
      if (ops[k][0] !== '+') ol++
      if (ops[k][0] !== '-') nl++
    }
    hunks.push({
      oldStart: ol ? oldNo[from] : oldNo[from] - 1,
      oldLines: ol,
      newStart: nl ? newNo[from] : newNo[from] - 1,
      newLines: nl,
      lines,
    })
  }
  return hunks
}

// ---------------------------------------------------------------------------
// Watched sessions

let seq = 0
/** id -> { id, file, dir, mtime, cwd, title, changes[], logs: Map } */
const sessions = new Map()

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

/**
 * The committed version of a file (git HEAD), or null. Used when a whole-file
 * write arrives without the old content and we never saw the file before.
 */
function committedText(file) {
  if (!gitVersion) return null
  const root = repoFor(path.dirname(file))
  if (!root) return null
  try {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const buf = execFileSync('git', ['--no-optional-locks', 'show', `HEAD:${rel}`], {
      cwd: root,
      timeout: 3000,
      maxBuffer: MAX_AFTER + 1,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    if (buf.length > MAX_AFTER || buf.includes(0)) return null
    return normText(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * First time a file changes in a session: remember its content before that
 * change. The UI diffs it against the current content to show what changed in
 * the session overall – also edits that never made it into the log.
 */
function rememberBase(s, c, before, live = true) {
  if (s.bases.has(c.filePath)) return
  if (!live) {
    // Reading old history at start: work out the git base later, when the page
    // asks for it – keeps the server responsive while it starts.
    s.bases.set(c.filePath, { lazy: true, before: typeof before === 'string' && before.length <= MAX_AFTER ? before : null })
    return
  }
  // In a git repo: the committed state when the session started (like git diff).
  // Otherwise: the old content from the log or the last version we know.
  let base = textAtSessionStart(s, c.filePath)
  if (base === null) base = typeof before === 'string' && before.length <= MAX_AFTER ? before : null
  s.bases.set(c.filePath, base)
  c.base = base // sent along with this first change
  c.head = headText(c.filePath)
}

/**
 * The file as it was committed when the session started (the last commit
 * before its first log entry): '' if it didn't exist then, null if unknown.
 * Base for the session diff when the log has no old content (large files,
 * shell edits before the app was running).
 */
function textAtSessionStart(s, file) {
  const root = repoFor(path.dirname(file))
  if (!root || !s.started) return null
  const git = args =>
    execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      timeout: 3000,
      maxBuffer: MAX_AFTER + 1,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  try {
    if (!s.startCommit) {
      const sha = git(['rev-list', '-1', `--before=@${Math.floor(s.started / 1000)}`, 'HEAD']).toString().trim()
      s.startCommit = new Map()
      s.startCommit.set(root, sha)
    } else if (!s.startCommit.has(root)) {
      s.startCommit.set(root, git(['rev-list', '-1', `--before=@${Math.floor(s.started / 1000)}`, 'HEAD']).toString().trim())
    }
    const sha = s.startCommit.get(root)
    if (!sha) return null
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (!git(['ls-tree', '--name-only', sha, '--', rel]).toString().trim()) return '' // not there yet
    const buf = git(['show', `${sha}:${rel}`])
    if (buf.length > MAX_AFTER || buf.includes(0)) return null
    return normText(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The file in the repo's current HEAD commit: '' if it isn't committed, null
 * outside git or if unknown. Base for "Compare with: Last commit".
 */
const commitCache = new Map() // "root\0sha\0rel" -> text
function headText(file) {
  const root = repoFor(path.dirname(file))
  if (!root) return null
  const git = args =>
    execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      timeout: 3000,
      maxBuffer: MAX_AFTER + 1,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  try {
    const sha = git(['rev-parse', '--verify', '-q', 'HEAD']).toString().trim()
    const rel = path.relative(root, file).split(path.sep).join('/')
    const key = `${root}\0${sha}\0${rel}`
    if (commitCache.has(key)) return commitCache.get(key)
    let text = ''
    if (git(['ls-tree', '--name-only', sha, '--', rel]).toString().trim()) {
      const buf = git(['show', `${sha}:${rel}`])
      text = buf.length > MAX_AFTER || buf.includes(0) ? null : normText(buf.toString('utf8'))
    }
    if (commitCache.size > 2000) commitCache.clear()
    commitCache.set(key, text)
    return text
  } catch {
    return null
  }
}

/** Turn bases noted while reading old history into real content. */
function resolveBases(s) {
  for (const [file, v] of s.bases) {
    if (!v || typeof v !== 'object' || !v.lazy) continue
    const fromGit = textAtSessionStart(s, file)
    s.bases.set(file, fromGit !== null ? fromGit : v.before)
  }
}

/** HEAD versions of a session's files (all, or only those in one repo). */
function headContents(s, root = null) {
  const out = {}
  for (const file of s.bases.keys()) {
    if (root && repoFor(path.dirname(file)) !== root) continue
    const t = headText(file)
    if (t !== null) out[file] = t
  }
  return out
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
      const change = toChange(entry, ++seq)
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

/**
 * Files of a session whose content on disk differs from the newest version we
 * know (edits that never made it into the log, or unknown content). The UI
 * shows and diffs what's really there now – like git diff.
 */
function currentContents(s) {
  const latest = new Map()
  for (const c of s.changes) latest.set(c.filePath, c)
  const out = {}
  for (const [file, c] of latest) {
    if (!s.bases.has(file)) continue // only needed for the session diff
    const disk = readText(file)
    if (typeof disk === 'string' && disk !== c.after) out[file] = disk
  }
  return out
}

function snapshotV2() {
  return {
    sessions: [...sessions.values()].map(s => (resolveBases(s), {
      ...sessionInfo(s),
      changes: slimChanges(s.changes).map(c => ({ ...c, base: undefined, head: undefined })),
      bases: Object.fromEntries(s.bases),
      heads: headContents(s),
      nows: currentContents(s),
    })),
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

function emitChanges(s, fresh) {
  if (!fresh.length) return
  fresh.sort((a, b) => a.ts - b.ts)
  for (const c of fresh) {
    s.changes.push(c)
    broadcast(2, 'change', { sessionId: s.id, change: c })
    if (primary() === s) broadcast(1, 'change', { ...c, after: undefined })
  }
  broadcast(2, 'session', sessionInfo(s))
}

function poll() {
  for (const s of sessions.values()) {
    const fresh = []
    for (const file of [s.file, ...subagentLogs(s)]) readNew(s, file, fresh, true)
    emitChanges(s, fresh)
  }
}

// ---------------------------------------------------------------------------
// Git fallback: files the agent changes through shell commands, scripts or MCP
// tools leave no diff in the log. For those we ask git which files changed in
// the session's repos and diff them against the last version we know.
// The first scan of a repo only records its state (existing uncommitted work
// is not shown as the agent's change).

const GIT_ENABLED = process.env.WHC_GIT !== '0'
const GIT_IDLE_MS = 8000 // rescan this often while a session is busy
const GIT_BUSY_MS = 3 * 60 * 1000 // ... i.e. had log activity this recently
const GIT_SETTLE_MS = 1200 // files younger than this: wait, an Edit may not be logged yet
const GIT_MAX_REPOS = 25
const SKIP_DIRS = new Set(['node_modules', 'Pods', 'DerivedData', 'build', 'dist', 'target', 'vendor', 'venv', 'Carthage'])
let gitVersion = null // null: unknown yet, '': not available

function git(cwd, args, encoding = 'utf8') {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', ...args], { cwd, encoding, maxBuffer: 64 * 1024 * 1024, timeout: 10000, windowsHide: true }, (err, out) =>
      resolve(err ? null : out),
    )
  })
}

function checkGit() {
  if (!GIT_ENABLED) return
  execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, (err, out) => {
    gitVersion = err ? '' : String(out).trim().replace(/^git version\s*/, '')
  })
}

/** The session's repo plus nested repos below its folder (e.g. a master repo with subrepos). */
function findRepos(cwd) {
  const out = new Set()
  const top = repoFor(cwd)
  if (top) out.add(top)
  if (cwd === os.homedir() || path.dirname(cwd) === cwd) return [...out] // too broad to search
  const walk = (dir, depth) => {
    if (depth > 3 || out.size >= GIT_MAX_REPOS) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (depth > 0 && entries.some(e => e.name === '.git') && repoFor(dir) === dir) out.add(dir)
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1)
  }
  walk(cwd, 0)
  return [...out]
}

/** File content as text: undefined = missing, null = binary or too large. */
function readText(file) {
  let buf
  try {
    if (!fs.statSync(file).isFile()) return undefined
    buf = fs.readFileSync(file)
  } catch {
    return undefined
  }
  if (buf.length > MAX_AFTER || buf.includes(0)) return null
  return normText(buf.toString('utf8'))
}

/** Version of a file in a commit: undefined = not there, null = binary or too large. */
async function textAt(root, commit, rel) {
  if (!commit) return undefined
  const buf = await git(root, ['show', `${commit}:${rel.split(path.sep).join('/')}`], 'buffer')
  if (buf === null) return undefined
  if (buf.length > MAX_AFTER || buf.includes(0)) return null
  return normText(buf.toString('utf8'))
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\n$/, '') === b.replace(/\n$/, '')

async function scanRepo(s, root, sink) {
  let st = s.git.repos.get(root)
  if (!st) s.git.repos.set(root, (st = { head: '', dirty: new Set(), ready: false }))
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status === null) return
  const head = ((await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) || '').trim()

  const dirty = new Set()
  const parts = status.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.length < 4) continue
    if (p[0] === 'R' || p[0] === 'C') i++ // the next field is the old name
    const rel = p.slice(3)
    if (!rel.endsWith('/')) dirty.add(rel) // "dir/" = nested repo, not a file
  }

  // Files to look at: dirty now, dirty before (maybe reverted), or touched by a new commit.
  const look = new Set([...dirty, ...st.dirty])
  if (st.ready && st.head && head && st.head !== head) {
    const d = await git(root, ['diff', '--name-only', '-z', st.head, head])
    if (d) for (const rel of d.split('\0')) if (rel) look.add(rel)
  }

  const now = Date.now()
  for (const rel of look) {
    const file = path.join(root, rel)
    if (!st.ready) {
      if (dirty.has(rel)) s.contents.set(file, readText(file) ?? null) // baseline only
      continue
    }
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {}
    if (mtime && now - mtime < GIT_SETTLE_MS) {
      dirty.add(rel) // check again next round
      s.git.wanted = true
      continue
    }
    const after = readText(file)
    const known = s.contents.has(file)
    let before = known ? s.contents.get(file) : await textAt(root, st.head || head, rel)
    if (!known && s.changes.some(c => c.filePath === file)) {
      // Edited through the log already, but without a known version: just remember it.
      s.contents.set(file, after ?? null)
      continue
    }
    if (before === null || after === null) {
      s.contents.set(file, after ?? null) // binary or too large: nothing to show
      continue
    }
    if (before === undefined && after === undefined) continue
    if (same(before, after) || (before === undefined && after === '')) {
      if (after !== undefined) s.contents.set(file, after)
      continue
    }
    const hunks = lineDiff(before ?? '', after ?? '')
    if (!hunks.length) continue
    let added = 0
    let removed = 0
    for (const h of hunks)
      for (const l of h.lines) {
        if (l[0] === '+') added++
        else if (l[0] === '-') removed++
      }
    const gitChange = {
      id: ++seq,
      filePath: file,
      rel: displayPath(file, s.cwd),
      kind: before === undefined ? 'create' : 'update',
      hunks,
      added,
      removed,
      after: after ?? '',
      ts: mtime || now,
      repo: root,
      source: after === undefined ? 'git-deleted' : 'git',
    }
    rememberBase(s, gitChange, before ?? '')
    sink.push(gitChange)
    if (after === undefined) s.contents.delete(file)
    else s.contents.set(file, after)
    s.git.count++
  }
  const committed = st.ready && st.head && head && st.head !== head
  st.dirty = dirty
  st.head = head
  st.ready = true
  if (committed) broadcast(2, 'heads', { sessionId: s.id, heads: headContents(s, root) })
}

async function gitScan(s, roots) {
  s.git.busy = true
  try {
    const fresh = []
    for (const root of roots) await scanRepo(s, root, fresh)
    emitChanges(s, fresh)
  } catch (e) {
    console.error('git scan failed:', e.message)
  } finally {
    s.git.busy = false
    s.git.last = Date.now()
  }
}

function gitFallbackTick() {
  if (!gitVersion) return
  const now = Date.now()
  // Find each session's repos now and then; a repo belongs to the most recently active session.
  const owner = new Map()
  for (const s of [...sessions.values()].sort((a, b) => a.mtime - b.mtime)) {
    if (!s.cwd || now - s.mtime >= ACTIVE_MS) continue
    if (now - s.git.found > 60000) {
      s.git.roots = findRepos(s.cwd)
      s.git.found = now
    }
    for (const r of s.git.roots) owner.set(r, s)
  }
  for (const s of sessions.values()) {
    if (s.git.busy || !s.cwd) continue
    const roots = s.git.roots.filter(r => owner.get(r) === s)
    if (!roots.length) continue
    const fresh = roots.some(r => !(s.git.repos.get(r) || {}).ready)
    const busy = now - s.mtime < GIT_BUSY_MS && now - s.git.last > GIT_IDLE_MS
    if (s.git.wanted || fresh || busy) {
      s.git.wanted = false
      gitScan(s, roots)
    }
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

// ---------------------------------------------------------------------------
// Status: does this machine have everything Watch Him Code needs?
// state: ok | warn | fail | idle (nothing wrong, just nothing to show yet)

const home = p => displayPath(p, '')

// ---------------------------------------------------------------------------
// Update check: asks GitHub for the latest release now and then. Installing is
// up to the Mac/Windows app, and only when the user clicks.

// New repo name first; the old one still works (GitHub redirects renamed repos).
const RELEASES = [
  'https://api.github.com/repos/stfnhdr/watch-em-code/releases/latest',
  'https://api.github.com/repos/stfnhdr/watch-him-code/releases/latest',
]
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
const UPDATE_CHECK = process.env.WHC_UPDATE_CHECK !== '0'
let update = { checked: 0, latest: '', name: '', page: '', assets: {}, error: '' }

const parseVersion = v => (String(v).replace(/^v/, '').match(/\d+/g) || []).slice(0, 3).map(Number)
function newer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

async function checkUpdate() {
  if (!UPDATE_CHECK || typeof fetch !== 'function') return
  try {
    let res
    for (const url of RELEASES) {
      res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'watch-him-code' },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status !== 404) break
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const r = await res.json()
    const assets = {}
    for (const a of r.assets || []) {
      if (/macos\.zip$/i.test(a.name)) assets.mac = a.browser_download_url
      if (/windows\.zip$/i.test(a.name)) assets.windows = a.browser_download_url
    }
    update = { checked: Date.now(), latest: String(r.tag_name || '').replace(/^v/, ''), name: r.name || '', page: r.html_url || '', assets, error: '' }
  } catch (e) {
    update = { ...update, checked: Date.now(), error: e.message }
  }
}

function updateInfo() {
  return {
    current: VERSION,
    latest: update.latest,
    available: !!update.latest && newer(update.latest, VERSION),
    name: update.name,
    page: update.page,
    assets: update.assets,
    enabled: UPDATE_CHECK,
    error: update.error,
  }
}

function statusReport() {
  const checks = []
  const add = (label, state, detail, fix) => checks.push({ label, state, detail, fix: fix || '' })
  const now = Date.now()

  const major = Number(process.versions.node.split('.')[0])
  add('Node.js', major >= 18 ? 'ok' : 'fail', `Version ${process.versions.node}`, major >= 18 ? '' : 'Install Node.js 18 or newer from nodejs.org.')

  // The only hard requirement: read access to Claude Code's session logs.
  let logsOk = false
  try {
    fs.readdirSync(PROJECTS)
    logsOk = true
    add('Claude Code logs', 'ok', home(PROJECTS))
  } catch (e) {
    const missing = e.code === 'ENOENT'
    add(
      'Claude Code logs',
      'fail',
      missing ? `${home(PROJECTS)} does not exist` : `${home(PROJECTS)} is not readable (${e.code})`,
      missing
        ? 'Run Claude Code at least once with this user account. If you use CLAUDE_CONFIG_DIR, start Watch Him Code with the same variable.'
        : 'Give your user read access to this folder.',
    )
  }

  if (!GIT_ENABLED) add('git', 'idle', 'Turned off (WHC_GIT=0) – only Edit/Write changes are shown')
  else if (gitVersion === '')
    add(
      'git',
      'warn',
      'Not found – only Edit/Write changes are shown',
      process.platform === 'darwin'
        ? 'Install git (e.g. run `xcode-select --install` in Terminal) so changes made through shell commands show up too.'
        : 'Install git from git-scm.com so changes made through shell commands show up too.',
    )
  else if (gitVersion) add('git', 'ok', `Version ${gitVersion} – also picks up shell and script edits`)

  if (logsOk) {
    const files = listSessionFiles()
    const active = files.filter(f => now - f.mtime < ACTIVE_MS).length
    if (!files.length) add('Sessions', 'fail', 'No session logs found yet', 'Start a Claude Code session on this machine.')
    else if (!active) add('Sessions', 'idle', `${files.length} logs, none active in the last hour`, 'Start or continue a Claude Code session – it shows up automatically.')
    else add('Sessions', 'ok', `${active} active, ${files.length} in total`)
  }

  // Per watched session: can we read its project, and does the agent edit in a visible way?
  const app = process.env.WHC_PARENT_PID ? 'Watch Him Code' : 'your terminal app'
  const list = []
  for (const s of [...sessions.values()].sort((a, b) => b.mtime - a.mtime)) {
    if (now - s.mtime >= ACTIVE_MS) continue
    const name = s.title || (s.cwd ? path.basename(s.cwd) : s.id.slice(0, 8))
    const items = []
    const item = (label, state, detail, fix) => items.push({ label, state, detail, fix: fix || '' })

    if (!s.cwd) item('Project folder', 'idle', 'Not known yet')
    else
      try {
        fs.readdirSync(s.cwd)
        item('Project folder', 'ok', home(s.cwd))
      } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EACCES')
          item(
            'Project folder',
            'warn',
            `${home(s.cwd)}: access denied by the system`,
            process.platform === 'darwin'
              ? `System Settings → Privacy & Security → Files and Folders (or Full Disk Access) → allow ${app}. Without it, branch names and some full-file views are missing; diffs still work.`
              : 'Give your user read access to this folder.',
          )
        else item('Project folder', 'warn', `${home(s.cwd)} not found on this machine (remote or deleted?)`, 'Branch names and full-file views need the project on this machine.')
      }

    const roots = new Set([...s.git.roots, ...s.changes.map(c => c.repo).filter(Boolean)])
    const names = [...roots].map(r => path.basename(r))
    if (roots.size)
      item('Git repos', 'ok', roots.size > 1 ? `${roots.size} watched: ${names.join(', ')}` : names[0])
    else item('Git repos', 'idle', 'No git repo found – branch names and shell edits are not shown')

    const t = s.tools
    const hidden = t.shell + t.mcp
    const viaLog = s.changes.length - s.git.count
    const gitCovers = !!gitVersion && s.git.roots.length > 0
    if (gitCovers)
      item(
        'Visible edits',
        s.changes.length ? 'ok' : 'idle',
        `${viaLog} via Edit/Write · ${s.git.count} found by git (shell, scripts, MCP)`,
      )
    else if (s.changes.length)
      item(
        'Visible edits',
        hidden > 2 * t.edit && hidden > 10 ? 'warn' : 'ok',
        `${s.changes.length} via Edit/Write` + (hidden ? ` · ~${hidden} likely file writes via shell/MCP` : ''),
        hidden > 2 * t.edit && hidden > 10 ? 'Files changed through shell commands or MCP tools are only picked up inside git repos.' : '',
      )
    else if (hidden >= 3)
      item(
        'Visible edits',
        'warn',
        `None via Edit/Write, but ~${hidden} likely file writes via shell/MCP`,
        gitVersion
          ? 'The agent changes files through shell commands or MCP tools. Those are picked up through git – but this project is not a git repo. Ask the agent to use its Edit/Write tools.'
          : 'The agent changes files through shell commands or MCP tools. Install git so Watch Him Code can pick those up, or ask the agent to use its Edit/Write tools.',
      )
    else item('Visible edits', 'idle', 'No edits yet')

    list.push({ id: s.id, name, items })
  }

  const rank = { ok: 0, idle: 1, warn: 2, fail: 3 }
  const all = [...checks, ...list.flatMap(s => s.items)]
  const worst = all.reduce((w, c) => (rank[c.state] > rank[w] ? c.state : w), 'ok')
  return { state: worst, checks, sessions: list, platform: process.platform, update: updateInfo() }
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

  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(sessionList()))
    return
  }

  // Open (pin) or close (unpin) a session tab. Ids are checked against the logs on disk.
  if (url.pathname === '/open' || url.pathname === '/close') {
    const id = url.searchParams.get('id') || ''
    const known = /^[\w-]{1,100}$/.test(id) && listSessionFiles().some(f => f.id === id)
    if (!known) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false}')
      return
    }
    if (url.pathname === '/open') pinned.add(id)
    else pinned.delete(id)
    scan()
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
    return
  }

  // "Check now" in the settings: ask GitHub right away (at most every 10 s)
  if (url.pathname === '/check-update') {
    const run = Date.now() - update.checked > 10000 ? checkUpdate() : Promise.resolve()
    run.then(() => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(updateInfo())))
    return
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(statusReport()))
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
    // Read the session logs a moment later: the window first gets the page
    // (instantly), the data follows over the live connection.
    setTimeout(() => {
      scan()
      setInterval(poll, POLL_MS)
      setInterval(scan, SCAN_MS)
    }, 250)
    checkGit()
    setTimeout(checkUpdate, 5000).unref()
    setInterval(checkUpdate, UPDATE_EVERY_MS).unref()
    setInterval(gitFallbackTick, 1000)
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
else module.exports = { applyPatch, toChange, lineDiff }
