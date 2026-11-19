'use strict'
// Git fallback: finds files changed through shell commands, scripts or MCP tools.

const fs = require('fs')
const path = require('path')
const { ACTIVE_MS } = require('./config')
const { GIT_IDLE_MS, GIT_BUSY_MS, GIT_SETTLE_MS, getGitVersion, git, findRepos, textAt } = require('./git')
const { sessions, diffChange, headContents, emitChanges } = require('./sessions')
const { readText } = require('./text')
const { ignored } = require('./ignore')
const { broadcast } = require('./bus')

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
    // Watched folders: only files inside the folder (it may be part of a bigger
    // repo), and leave out what .gitignore misses (.DS_Store, node_modules …)
    if (s.kind === 'folder' && (ignored(rel) || !file.startsWith(s.cwd + path.sep))) continue
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
    const gitChange = diffChange(s, file, before, after, {
      ts: mtime || now,
      repo: root,
      // In a watched folder every change is just a change; in a Claude session
      // it means the agent went around its Edit/Write tools ("via shell").
      source: s.kind === 'folder' ? 'watch' : 'git',
    })
    if (!gitChange) continue
    sink.push(gitChange)
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
  if (!getGitVersion()) return
  const now = Date.now()
  // Find each session's repos now and then; a repo belongs to the most recently active session.
  const owner = new Map()
  // Watched folders run their own git scans (driven by file events, see folders.js).
  const logSessions = [...sessions.values()].filter(s => s.kind !== 'folder')
  for (const s of logSessions.sort((a, b) => a.mtime - b.mtime)) {
    if (!s.cwd || now - s.mtime >= ACTIVE_MS) continue
    if (now - s.git.found > 60000) {
      s.git.roots = findRepos(s.cwd)
      s.git.found = now
    }
    for (const r of s.git.roots) owner.set(r, s)
  }
  for (const s of logSessions) {
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

module.exports = { scanRepo, gitScan, gitFallbackTick }
