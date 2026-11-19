'use strict'
// Git repos and branches, read straight from .git/HEAD (no git call needed).

const fs = require('fs')
const path = require('path')
const { broadcast } = require('./bus')

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

module.exports = { repos, dirRepo, readBranch, repoInfo, repoFor, checkRepos }
