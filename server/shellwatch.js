'use strict'
// Git fallback: finds files changed through shell commands, scripts or MCP tools.

const fs = require('fs')
const path = require('path')
const { ACTIVE_MS } = require('./config')
const { GIT_IDLE_MS, GIT_BUSY_MS, GIT_SETTLE_MS, getGitVersion, git, findRepos, textAt } = require('./git')
const { sessions, nextSeq, rememberBase, headContents, emitChanges } = require('./sessions')
const { readText, same, displayPath } = require('./text')
const { lineDiff } = require('./diff')
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
      id: nextSeq(),
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
  if (!getGitVersion()) return
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

module.exports = { scanRepo, gitScan, gitFallbackTick }
