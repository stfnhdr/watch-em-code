'use strict'
// Status check: does this machine have everything it needs?

const fs = require('fs')
const path = require('path')
const { PROJECTS, ACTIVE_MS } = require('./config')
const { displayPath } = require('./text')
const { listSessionFiles } = require('./claude')
const { sessions } = require('./sessions')
const { GIT_ENABLED, getGitVersion } = require('./git')
const { updateInfo } = require('./update')

// ---------------------------------------------------------------------------
// Status: does this machine have everything Watch Him Code needs?
// state: ok | warn | fail | idle (nothing wrong, just nothing to show yet)

const home = p => displayPath(p, '')

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
  else if (getGitVersion() === '')
    add(
      'git',
      'warn',
      'Not found – only Edit/Write changes are shown',
      process.platform === 'darwin'
        ? 'Install git (e.g. run `xcode-select --install` in Terminal) so changes made through shell commands show up too.'
        : 'Install git from git-scm.com so changes made through shell commands show up too.',
    )
  else if (getGitVersion()) add('git', 'ok', `Version ${getGitVersion()} – also picks up shell and script edits`)

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
    const gitCovers = !!getGitVersion() && s.git.roots.length > 0
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
        getGitVersion()
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

module.exports = { statusReport }
