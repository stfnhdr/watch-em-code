'use strict'
// The watched sessions and their changes – whatever source they come from.

const path = require('path')
const { MAX_AFTER } = require('./config')
const { repos, repoInfo, repoFor } = require('./repos')
const { textAtSessionStart, headText } = require('./git')
const { readText } = require('./text')
const { broadcast } = require('./bus')

// ---------------------------------------------------------------------------
// Watched sessions

let seq = 0
/** id -> { id, file, dir, mtime, cwd, title, changes[], logs: Map } */
const sessions = new Map()

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

/** Next change id (shared by all sources). */
const nextSeq = () => ++seq

module.exports = { sessions, nextSeq, rememberBase, resolveBases, headContents, sessionInfo, slimChanges, currentContents, snapshotV2, primary, snapshotV1, emitChanges }
