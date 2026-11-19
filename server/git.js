'use strict'
// Asking git: file versions in commits, nested repos, availability.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, execFileSync } = require('child_process')
const { MAX_AFTER } = require('./config')
const { normText } = require('./text')
const { repoFor } = require('./repos')

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


/** Version of a file in a commit: undefined = not there, null = binary or too large. */
async function textAt(root, commit, rel) {
  if (!commit) return undefined
  const buf = await git(root, ['show', `${commit}:${rel.split(path.sep).join('/')}`], 'buffer')
  if (buf === null) return undefined
  if (buf.length > MAX_AFTER || buf.includes(0)) return null
  return normText(buf.toString('utf8'))
}

const getGitVersion = () => gitVersion

module.exports = { GIT_ENABLED, GIT_IDLE_MS, GIT_BUSY_MS, GIT_SETTLE_MS, GIT_MAX_REPOS, SKIP_DIRS, getGitVersion, git, checkGit, findRepos, textAt, committedText, textAtSessionStart, headText }
