'use strict'
// Read-only view: shows files the way the agent is changing them right now.
// Editing is deliberately not possible. Two views with the same features:
//   Editor – folder tree + whole file, changes marked in the gutter (Xcode-like)
//   Cards  – file cards + diff blocks of all changes to a file

const BUSY_MS = 4000 // a session counts as "busy" for this long
const GHOST_MS = 2600 // deleted lines stay visible for this long
const STAGGER_MS = 20
const STAGGER_MAX = 50
const MAX_ROWS = 20000
const MAX_DIFF_LINES = 1500

const $ = id => document.getElementById(id)
const els = {
  sessions: $('sessions'),
  list: $('list'),
  jumpbar: $('jumpbar'),
  view: $('view'),
  live: $('live'),
  liveLabel: $('live-label'),
  settingsBtn: $('settings-btn'),
  settings: $('settings'),
  statusBtn: $('status-btn'),
  updatePill: $('update-pill'),
  freshBtn: $('fresh-btn'),
  sessionMenu: $('session-menu'),
  dwell: $('dwell'),
  dwellLabel: $('dwell-label'),
  layout: $('layout'),
  resizer: $('resizer'),
  status: $('status'),
  toast: $('toast'),
  buddy: $('buddy'),
}
const esc = Highlight.esc

// ---------------------------------------------------------------------------
// Settings (stored in the browser)

const DEFAULTS = { view: 'editor', theme: 'system', buddy: true, diff: 'inline', avatar: 'junior', dwell: 3, autoClose: false, marks: 'session', compare: 'session' }
const settings = { ...DEFAULTS }
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('whc.settings') || '{}'))
  if (localStorage.getItem('whc.buddy') === 'off') settings.buddy = false
} catch {}

function saveSettings() {
  try {
    localStorage.setItem('whc.settings', JSON.stringify(settings))
  } catch {}
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const t = settings.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme
  document.documentElement.dataset.theme = t
  // In the Mac/Windows app: tint the window title bar to match
  try {
    window.webkit?.messageHandlers?.whc?.postMessage({ theme: t })
    window.chrome?.webview?.postMessage({ theme: t })
  } catch {}
}
darkQuery.addEventListener('change', applyTheme)

function setSetting(key, value) {
  if (settings[key] === value) return
  settings[key] = value
  saveSettings()
  applySettings(key)
}

function applySettings(changed) {
  applyTheme()
  document.body.classList.toggle('view-editor', settings.view === 'editor')
  document.body.classList.toggle('view-cards', settings.view === 'cards')
  els.buddy.classList.toggle('hidden', !settings.buddy)
  buddy.setCharacter(settings.avatar)
  for (const b of els.settings.querySelectorAll('button[data-key]')) {
    b.classList.toggle('on', String(settings[b.dataset.key]) === b.dataset.value)
  }
  els.dwell.value = settings.dwell
  els.dwellLabel.textContent = settings.dwell ? `${settings.dwell} s` : 'instant'
  if (changed === 'dwell' && !settings.dwell) playNext() // flush what's waiting
  if (changed === 'autoClose') applyAutoClose()
  if (!changed || changed === 'view') els.list.innerHTML = ''
  if (!changed || changed === 'view' || changed === 'diff' || changed === 'marks' || changed === 'compare') renderAll()
}

els.settings.addEventListener('click', e => {
  const b = e.target.closest('button[data-key]')
  if (!b) return
  const raw = b.dataset.value
  setSetting(b.dataset.key, raw === 'true' ? true : raw === 'false' ? false : raw)
})
els.settings.addEventListener('input', e => {
  if (e.target === els.dwell) setSetting('dwell', Number(els.dwell.value))
})
function toggleSettings(open = els.settings.hidden) {
  els.settings.hidden = !open
  els.settingsBtn.classList.toggle('open', open)
  if (open) {
    toggleStatus(false)
    loadStatus() // fresh version line
  }
}
els.settingsBtn.addEventListener('click', e => {
  e.stopPropagation()
  toggleSettings()
})
document.addEventListener('click', e => {
  if (!els.settings.hidden && !els.settings.parentNode.contains(e.target)) toggleSettings(false)
  if (!els.status.hidden && !els.status.parentNode.contains(e.target)) toggleStatus(false)
  if (!els.sessionMenu.hidden && !els.sessionMenu.contains(e.target)) els.sessionMenu.hidden = true
})

// ---------------------------------------------------------------------------
// Status: does this machine have everything it needs? Opens by itself at
// start when something is wrong.

let statusTimer = null
let statusChecked = false

function toggleStatus(open = els.status.hidden) {
  els.status.hidden = !open
  els.statusBtn.classList.toggle('open', open)
  clearInterval(statusTimer)
  if (open) {
    toggleSettings(false)
    loadStatus()
    statusTimer = setInterval(loadStatus, 3000)
  }
}
els.statusBtn.addEventListener('click', e => {
  e.stopPropagation()
  toggleStatus()
})

const STATUS_TEXT = {
  ok: 'Everything Watch Him Code needs is in place.',
  idle: 'All set – waiting for an active session.',
  warn: 'It works, but something limits what you see.',
  fail: 'Something is missing – nothing can be shown yet.',
}

function checkHtml(c) {
  return (
    `<div class="check ${c.state}"><span class="mark"></span><span class="what">${esc(c.label)}</span>` +
    `<span class="detail">${esc(c.detail)}</span>` +
    (c.fix && c.state !== 'ok' ? `<span class="fix">${esc(c.fix)}</span>` : '') +
    `</div>`
  )
}

// ---------------------------------------------------------------------------
// Updates: the server checks GitHub; the Mac/Windows app installs on click.

const host = window.webkit?.messageHandlers?.whc
  ? m => window.webkit.messageHandlers.whc.postMessage(m)
  : window.chrome?.webview
    ? m => window.chrome.webview.postMessage(m)
    : null
const hostKind = window.webkit?.messageHandlers?.whc ? 'mac' : window.chrome?.webview ? 'windows' : ''
let updateInfo = null
let installState = null // { state: downloading | installing | error, message }

/** Called by the Mac/Windows app while it installs an update. */
window.whcUpdateState = s => {
  installState = s
  if (s.state === 'error') toggleStatus(true)
  renderUpdateBox()
}

function openExternal(url) {
  if (host) host({ open: url })
  else window.open(url, '_blank', 'noopener')
}

function renderUpdatePill(u) {
  const show = !!(u && u.available)
  els.updatePill.hidden = !show
  if (!show) return
  els.updatePill.innerHTML = `<span class="arrow">↑</span> ${esc(u.latest)}`
  els.updatePill.title = `Version ${u.latest} is available – you have ${u.current}`
  // Mention it once per version.
  try {
    if (localStorage.getItem('whc.updateSeen') !== u.latest) {
      localStorage.setItem('whc.updateSeen', u.latest)
      toast(`↑ Watch Him Code ${esc(u.latest)} is available – click the ↑ button to update`)
    }
  } catch {}
}

function updateBoxHtml() {
  const u = updateInfo
  if (!u || !u.available) return ''
  const asset = hostKind && u.assets ? u.assets[hostKind] : null
  let action
  if (installState && installState.state === 'downloading') action = `<span class="busy">Downloading …</span>`
  else if (installState && installState.state === 'installing') action = `<span class="busy">Installing – restarting in a moment …</span>`
  else if (host && asset) action = `<button class="primary" data-act="install">Install &amp; restart</button>`
  else action = `<button class="primary" data-act="page">Download</button>`
  const err = installState && installState.state === 'error' ? `<div class="fix">${esc(installState.message || 'Update failed.')}</div>` : ''
  return `<div class="update-box">
      <div class="what">Version ${esc(u.latest)} is available</div>
      <div class="detail">You have ${esc(u.current)}${u.name ? ` · ${esc(u.name)}` : ''}</div>
      ${err}
      <div class="actions">${action}<button data-act="page">What's new</button></div>
    </div>`
}

function renderUpdateBox() {
  const box = els.status.querySelector('.update-box')
  if (box) box.outerHTML = updateBoxHtml()
}

els.updatePill.addEventListener('click', e => {
  e.stopPropagation()
  toggleStatus(true)
})

els.status.addEventListener('click', e => {
  const b = e.target.closest('[data-act]')
  if (!b || !updateInfo) return
  if (b.dataset.act === 'page') openExternal(updateInfo.page)
  if (b.dataset.act === 'install') {
    installState = { state: 'downloading' }
    renderUpdateBox()
    host({ update: { url: updateInfo.assets[hostKind], version: updateInfo.latest } })
  }
})

/** Version line at the bottom of the settings, with "Check now". */
function renderAbout(u, checking = false) {
  const el = document.getElementById('about-version')
  const btn = document.getElementById('check-update')
  const box = document.getElementById('about')
  box.classList.toggle('newer', !!(u && u.available))
  btn.disabled = checking
  if (!u) {
    el.textContent = 'Watch Him Code'
    btn.textContent = 'Check now'
    return
  }
  const v = `Watch Him Code ${u.current}`
  if (checking) el.textContent = `${v} · checking …`
  else if (!u.enabled) el.textContent = `${v} · update check off`
  else if (u.available) el.textContent = `${v} · ${u.latest} available`
  else if (u.error) el.textContent = `${v} · couldn't check`
  else if (u.latest) el.textContent = `${v} · up to date`
  else el.textContent = v
  btn.textContent = u.available ? 'Update' : 'Check now'
  btn.hidden = !u.enabled
}
document.getElementById('check-update').addEventListener('click', async e => {
  e.stopPropagation()
  if (updateInfo && updateInfo.available) return toggleStatus(true) // shows the install box
  renderAbout(updateInfo, true)
  try {
    updateInfo = await (await fetch('/check-update', { cache: 'no-store' })).json()
  } catch {}
  renderAbout(updateInfo)
  renderUpdatePill(updateInfo)
})

function renderStatus(r) {
  els.statusBtn.dataset.state = r.state
  els.statusBtn.title = 'Status – ' + STATUS_TEXT[r.state]
  updateInfo = r.update || null
  renderUpdatePill(updateInfo)
  renderAbout(updateInfo)
  if (els.status.hidden) return
  let html = `<h4>Status</h4><div class="summary">${STATUS_TEXT[r.state]}</div>` + updateBoxHtml()
  html += r.checks.map(checkHtml).join('')
  for (const s of r.sessions) html += `<div class="group">${esc(s.name)}</div>` + s.items.map(checkHtml).join('')
  const u = r.update
  const ver = !u
    ? ''
    : !u.enabled
      ? ` · Version ${esc(u.current)}, update check off`
      : u.available
        ? ` · Version ${esc(u.current)}`
        : u.latest
          ? ` · Version ${esc(u.current)}, up to date`
          : ` · Version ${esc(u.current)}`
  html += `<div class="foot">Updates every few seconds while open${ver}.</div>`
  els.status.innerHTML = html
}

function statusOffline() {
  return {
    state: 'fail',
    checks: [
      {
        label: 'Server',
        state: 'fail',
        detail: 'No connection to the Watch Him Code server',
        fix: 'Restart the app, or run `node server.js` in a terminal.',
      },
    ],
    sessions: [],
  }
}

async function loadStatus() {
  let r
  try {
    const res = await fetch('/status', { cache: 'no-store' })
    r = await res.json()
  } catch {
    r = statusOffline()
  }
  // First check after start: open by itself if something needs attention.
  if (!statusChecked) {
    statusChecked = true
    if (r.state === 'warn' || r.state === 'fail') toggleStatus(true)
  }
  renderStatus(r)
}

// ---------------------------------------------------------------------------
// State

/** id -> { info, files: Map<path, File>, last: change } */
let sessions = new Map()
let sessionId = null // selected session
let selected = null // selected file (filePath)
let follow = true
let connected = false
/** repo root -> { name, branch } */
let repos = new Map()

function newSession(info) {
  return { info, files: new Map(), last: null, all: [], latest: new Map(), bases: new Map(), nows: new Map(), heads: new Map() }
}

// Memory: the app may run for days in the background. Keep the full file
// content only on the newest change of each file (like the server's snapshot)
// and at most ALL_MAX changes per session.
const ALL_MAX = 4000
function remember(s, c) {
  const prev = s.latest.get(c.filePath)
  if (prev && prev !== c) prev.after = null
  s.latest.set(c.filePath, c)
  s.all.push(c)
  if (s.all.length > ALL_MAX) s.all.splice(0, s.all.length - ALL_MAX)
}

// ---------------------------------------------------------------------------
// Fresh start: hide a session's earlier changes and show only what comes next
// (e.g. working in PR comments after a long session). Per session, remembered.

const clearedAt = new Map() // session id -> time of the fresh start
try {
  for (const [id, t] of JSON.parse(localStorage.getItem('whc.clearedAt') || '[]')) clearedAt.set(id, t)
} catch {}
function saveCleared() {
  try {
    localStorage.setItem('whc.clearedAt', JSON.stringify([...clearedAt].slice(-100)))
  } catch {}
}
const shownChange = (sid, c) => !clearedAt.has(sid) || c.ts > clearedAt.get(sid)
const clockTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Rebuild a session's visible files from all its changes. */
function rebuild(s) {
  s.files = new Map()
  s.last = null
  for (const c of s.all) if (shownChange(s.info.id, c)) addChange(s, c)
  // What's on disk now, where it differs from the newest logged version
  for (const [file, text] of s.nows) {
    const f = s.files.get(file)
    if (f) f.content = text
  }
}

function freshStart() {
  const s = cur()
  if (!s) return
  clearedAt.set(s.info.id, Date.now())
  saveCleared()
  rebuild(s)
  clearQueue()
  follow = true
  selected = null
  els.list.innerHTML = ''
  renderAll()
  toast(`↺ Reset – only changes from now on show up (<kbd>c</kbd>)`)
}

function showEarlier() {
  const s = cur()
  if (!s) return
  clearedAt.delete(s.info.id)
  saveCleared()
  rebuild(s)
  follow = true
  selected = s.last?.filePath ?? null
  els.list.innerHTML = ''
  renderAll()
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-act="show-earlier"]')) showEarlier()
})

/** File: { filePath, rel, kind, added, removed, changes[], content, last, repo } */
function addChange(s, c) {
  let f = s.files.get(c.filePath)
  if (!f) {
    f = { filePath: c.filePath, rel: c.rel, kind: c.kind, added: 0, removed: 0, changes: [], content: null, last: 0 }
    s.files.set(c.filePath, f)
  }
  f.changes.push(c)
  f.added += c.added
  f.removed += c.removed
  f.last = Math.max(f.last, c.ts)
  f.rel = c.rel
  if (c.repo !== undefined) f.repo = c.repo
  f.content = c.after // null if unknown: then only the changed parts are shown
  if (!s.last || c.ts >= s.last.ts) s.last = c
  return f
}

const cur = () => sessions.get(sessionId)
const curFile = () => {
  const s = cur()
  return s && selected ? s.files.get(selected) : null
}

function label(info) {
  return info.title || info.project || info.id.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Tabs: closing hides a session until it gets busy again; "+" opens older ones.

/** id -> time the tab was closed */
const closedTabs = new Map()
/** sessions opened by hand via "+" (the server watches them even when old) */
let pinnedTabs = []
try {
  for (const [id, t] of JSON.parse(localStorage.getItem('whc.closedTabs') || '[]')) closedTabs.set(id, t)
  pinnedTabs = JSON.parse(localStorage.getItem('whc.pinnedTabs') || '[]')
} catch {}
function saveTabs() {
  try {
    localStorage.setItem('whc.closedTabs', JSON.stringify([...closedTabs].slice(-200)))
    localStorage.setItem('whc.pinnedTabs', JSON.stringify(pinnedTabs))
  } catch {}
}

/** Is the tab shown? A closed session comes back as soon as it continues. */
function tabOpen(s) {
  const closedAt = closedTabs.get(s.info.id)
  if (closedAt === undefined) return true
  const activity = Math.max(s.info.active || 0, s.last ? s.last.ts : 0)
  if (activity > closedAt + 2000) {
    closedTabs.delete(s.info.id)
    saveTabs()
    return true
  }
  return false
}
const openSessions = () => [...sessions.values()].filter(tabOpen)

function closeTab(id) {
  if (id === Demo.ID) {
    Demo.toggle()
    return
  }
  closedTabs.set(id, Date.now())
  if (pinnedTabs.includes(id) || autoPinned.includes(id)) {
    pinnedTabs = pinnedTabs.filter(x => x !== id)
    autoPinned = autoPinned.filter(x => x !== id)
    saveAutoPinned()
    fetch(`/close?id=${encodeURIComponent(id)}`).catch(() => {})
  }
  saveTabs()
  if (sessionId === id) {
    sessionId = pickDefaultSession()
    follow = true
    selected = cur()?.last?.filePath ?? null
    els.list.innerHTML = ''
  }
  renderAll()
}

let pendingSelect = null // opened via "+", waiting for the server to send it

/** Nothing (open) selected but a tab is there again? Select it. */
function ensureSelection() {
  if (cur() && tabOpen(cur())) return
  const id = pickDefaultSession()
  if (id && id !== sessionId) selectTab(id)
}
function selectTab(id) {
  clearQueue()
  sessionId = id
  follow = true
  selected = cur()?.last?.filePath ?? null
  els.list.innerHTML = ''
  renderAll()
}

async function openTab(id) {
  closedTabs.delete(id)
  saveTabs()
  if (sessions.has(id)) {
    selectTab(id)
    return
  }
  if (!pinnedTabs.includes(id)) pinnedTabs.push(id)
  saveTabs()
  pendingSelect = id
  try {
    await fetch(`/open?id=${encodeURIComponent(id)}`)
  } catch {}
}

// "Close idle tabs: Never" – the server would drop a session after an hour
// without activity, so every tab that shows up gets pinned there as well.
let autoPinned = []
try {
  autoPinned = JSON.parse(localStorage.getItem('whc.autoPinned') || '[]')
} catch {}
function saveAutoPinned() {
  try {
    localStorage.setItem('whc.autoPinned', JSON.stringify(autoPinned))
  } catch {}
}
function keepTabsOpen() {
  if (settings.autoClose) return
  for (const s of openSessions()) {
    const id = s.info.id
    if (id === Demo.ID || pinnedTabs.includes(id) || autoPinned.includes(id)) continue
    autoPinned.push(id)
    fetch(`/open?id=${encodeURIComponent(id)}`).catch(() => {})
  }
  saveAutoPinned()
}
/** Setting switched: pin all open tabs, or let the server drop idle ones again. */
function applyAutoClose() {
  if (!settings.autoClose) return keepTabsOpen()
  for (const id of autoPinned) if (!pinnedTabs.includes(id)) fetch(`/close?id=${encodeURIComponent(id)}`).catch(() => {})
  autoPinned = []
  saveAutoPinned()
}

/** After (re)connecting: ask the server to watch the tabs opened by hand again. */
function restorePinned() {
  for (const id of settings.autoClose ? pinnedTabs : [...new Set([...pinnedTabs, ...autoPinned])])
    fetch(`/open?id=${encodeURIComponent(id)}`)
      .then(r => {
        if (r.status === 404) {
          pinnedTabs = pinnedTabs.filter(x => x !== id)
          autoPinned = autoPinned.filter(x => x !== id)
          saveTabs()
          saveAutoPinned()
        }
      })
      .catch(() => {})
}

function pickDefaultSession() {
  let best = null
  for (const s of openSessions()) {
    const t = s.last ? s.last.ts : 0
    const bt = best ? (best.last ? best.last.ts : 0) : -1
    if (t > bt || (t === bt && s.info.active > best.info.active)) best = s
  }
  return best ? best.info.id : null
}

// ---------------------------------------------------------------------------
// Helpers

function split(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i), name: rel.slice(i + 1) }
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ts).toLocaleDateString()
}

const kindWord = (f, c) =>
  c.source === 'git-deleted' ? 'deleted' : c.kind === 'create' && f.changes[0] === c ? 'created' : 'modified'
// Changes found through git (shell commands, scripts, MCP tools) instead of the log.
const viaGit = c => !!c && typeof c.source === 'string' && c.source.startsWith('git')
const GIT_TIP = 'Changed outside the Edit/Write tools (shell, script or MCP tool) – picked up through git'

const ICON_COLORS = {
  js: '#d6b35a', mjs: '#d6b35a', cjs: '#d6b35a', jsx: '#d6b35a',
  ts: '#6aa5d8', tsx: '#6aa5d8', mts: '#6aa5d8',
  py: '#7fa6d6', swift: '#e08a5f', go: '#6fc3d0', rs: '#d08a6a', java: '#d08a6a', kt: '#b48ad8',
  css: '#b48ad8', scss: '#c48ab8', html: '#e08a5f', vue: '#7fbf90', svelte: '#e0805f',
  json: '#a3a3ab', yml: '#a3a3ab', yaml: '#a3a3ab', toml: '#a3a3ab',
  md: '#8fb8a8', txt: '#8e8e96', sh: '#8fc28f', zsh: '#8fc28f',
}
function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const c = ICON_COLORS[ext] || '#8e8e96'
  return `<svg class="icon" width="13" height="15" viewBox="0 0 13 15">
    <path d="M2 .5h6l4.5 4.5v8a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 13V2A1.5 1.5 0 0 1 2 .5z" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-opacity=".8"/>
    <path d="M8 .8V5h4.2" fill="none" stroke="${c}" stroke-opacity=".8"/></svg>`
}
const folderIcon = `<svg class="icon" width="15" height="12" viewBox="0 0 15 12">
  <path d="M1.5.5h4l1.5 1.5h6.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V1.5a1 1 0 0 1 1-1z" fill="#7a9cc6" fill-opacity=".35" stroke="#7a9cc6" stroke-opacity=".7"/></svg>`

// ---------------------------------------------------------------------------
// Title bar: session tabs and live

function renderSessions(pingId) {
  const now = Date.now()
  const list = openSessions().sort((a, b) => a.info.id.localeCompare(b.info.id))
  els.sessions.innerHTML =
    list
    .map(s => {
      const lastTs = s.last ? s.last.ts : 0
      const cls = [
        'session',
        s.info.id === sessionId ? 'selected' : '',
        now - lastTs < BUSY_MS * 2 ? 'busy' : now - s.info.active < 120000 ? 'recent' : '',
        s.info.id === pingId ? 'ping' : '',
      ].join(' ')
      const r = s.info.repo && repos.get(s.info.repo)
      const title = [s.info.cwd, r && r.branch ? `Branch: ${r.branch}` : '', `${s.files.size} ${s.files.size === 1 ? 'file' : 'files'} changed`]
        .filter(Boolean)
        .join('\n')
      const proj = s.info.title && s.info.project ? `<span class="proj">${esc(s.info.project)}</span>` : ''
      return (
        `<button class="${cls}" data-id="${esc(s.info.id)}" title="${esc(title)}"><span class="dot"></span>` +
        `<span class="label">${esc(label(s.info))}</span>${proj}` +
        `<span class="close" data-close="${esc(s.info.id)}" title="Close tab – it comes back when the session continues">×</span></button>`
      )
    })
    .join('')
  els.sessions.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  keepTabsOpen()
}
document.getElementById('session-add').addEventListener('click', e => {
  e.stopPropagation()
  toggleSessionMenu()
})

els.sessions.addEventListener('click', e => {
  const x = e.target.closest('[data-close]')
  if (x) {
    e.stopPropagation()
    closeTab(x.dataset.close)
    return
  }
  const b = e.target.closest('.session')
  if (b) selectTab(b.dataset.id)
})
// middle click closes a tab, like in a browser
els.sessions.addEventListener('auxclick', e => {
  const b = e.target.closest('.session')
  if (b && e.button === 1) closeTab(b.dataset.id)
})

// "+" menu: recent sessions, open or not
async function toggleSessionMenu(open = els.sessionMenu.hidden) {
  els.sessionMenu.hidden = !open
  if (!open) return
  toggleSettings(false)
  toggleStatus(false)
  const btn = document.getElementById('session-add')
  if (btn) {
    const r = btn.getBoundingClientRect()
    els.sessionMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 400))}px`
  }
  els.sessionMenu.innerHTML = `<div class="menu-empty">Loading …</div>`
  let list = []
  try {
    list = await (await fetch('/sessions', { cache: 'no-store' })).json()
  } catch {}
  const now = Date.now()
  const rows = list.map(x => {
    const s = sessions.get(x.id)
    const shown = s && tabOpen(s)
    const name = x.title || x.prompt || x.id.slice(0, 8)
    const state = now - x.active < 120000 ? 'busy' : now - x.active < 30 * 60000 ? 'recent' : ''
    return (
      `<button class="menu-row ${shown ? 'shown' : ''}" data-open="${esc(x.id)}" title="${esc(x.cwd)}">` +
      `<span class="dot ${state}"></span><span class="name">${esc(name)}</span>` +
      `<span class="meta">${esc(x.project)} · ${ago(x.active)}${shown ? ' · open' : ''}</span></button>`
    )
  })
  els.sessionMenu.innerHTML =
    `<div class="menu-head">Recent sessions</div>` +
    (rows.length ? rows.join('') : `<div class="menu-empty">No sessions found.</div>`) +
    `<div class="menu-sep"></div><button class="menu-row demo" data-open="${Demo.ID}"><span class="dot"></span><span class="name">Demo session</span><span class="meta">a made-up session to show the app</span></button>`
}
els.sessionMenu.addEventListener('click', e => {
  const r = e.target.closest('[data-open]')
  if (!r) return
  toggleSessionMenu(false)
  if (r.dataset.open === Demo.ID) {
    if (sessions.has(Demo.ID)) selectTab(Demo.ID)
    else Demo.toggle()
  } else openTab(r.dataset.open)
})

function renderLive() {
  // The Reset button lights up while the selected tab has an active reset
  const sid = cur()?.info.id
  const active = !!sid && clearedAt.has(sid)
  els.freshBtn.classList.toggle('on', active)
  els.freshBtn.title = active
    ? `Reset at ${clockTime(clearedAt.get(sid))} – click to reset again (c). The “since” pill above the file shows everything again.`
    : "Reset: hide this session's changes so far and show only what changes from now on (c). Nothing is deleted."
  els.live.classList.toggle('on', follow && connected)
  els.live.classList.toggle('offline', !connected)
  els.liveLabel.textContent = !connected ? 'Disconnected' : follow ? 'Live' : 'Follow live'
}

// ---------------------------------------------------------------------------
// Navigator on the left: folder tree (editor) or cards

function renderList(flashPath) {
  const s = cur()
  if (!s || s.files.size === 0) {
    els.list.innerHTML =
      s && clearedAt.has(s.info.id)
        ? `<div class="empty-list">No new changes since ${clockTime(clearedAt.get(s.info.id))}.<br><button class="link" data-act="show-earlier">Show earlier changes</button></div>`
        : `<div class="empty-list">No changes in this session yet.</div>`
    return
  }
  els.list.querySelector('.empty-list')?.remove()
  if (settings.view === 'cards') renderCards(s, flashPath)
  else renderTree(s, flashPath)
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.rel.split('/')
    let node = root
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] })
      node = node.dirs.get(p)
    }
    node.files.push(f)
  }
  return root
}

function renderTree(s, flashPath) {
  const rows = []
  const walk = (node, depth) => {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (let [name, child] of dirs) {
      // Collapse folder chains with a single subfolder (src/components)
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [n2, c2] = [...child.dirs.entries()][0]
        name += '/' + n2
        child = c2
      }
      rows.push(
        `<div class="node folder" style="padding-left:${8 + depth * 14}px"><span class="chev">▾</span>${folderIcon}<span class="name">${esc(name)}</span></div>`,
      )
      walk(child, depth + 1)
    }
    for (const f of [...node.files].sort((a, b) => a.rel.localeCompare(b.rel))) {
      const st = f.kind === 'create' ? 'A' : 'M'
      const name = split(f.rel).name
      const n = net(f)
      const cls = ['node', 'file', st, f.filePath === selected ? 'selected' : '', f.filePath === flashPath ? 'flash' : ''].join(' ')
      rows.push(
        `<button class="${cls}" data-path="${esc(f.filePath)}" style="padding-left:${8 + depth * 14 + 16}px" title="${esc(f.rel)}">` +
          `${fileIcon(name)}<span class="name">${esc(name)}</span>` +
          `<span class="counts"><span class="plus">+${n.added}</span> <span class="minus">−${n.removed}</span></span>` +
          `<span class="status ${st}">${st}</span></button>`,
      )
    }
  }
  walk(buildTree(s.files.values()), 0)
  els.list.innerHTML = rows.join('')
}

function cardHtml(f, width) {
  const { dir, name } = split(f.rel)
  return `
    <div class="row1">
      <span class="name">${esc(name)}</span>
      <span class="badge">${f.kind === 'create' ? 'new' : 'modified'}</span>
    </div>
    <div class="dir"><span dir="ltr">${dir ? esc(dir + '/') : '&nbsp;'}</span></div>
    <div class="stats">
      <span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span>
      <span class="bar"><span class="fill" style="width:${width}%">
        <span class="a" style="flex-grow:${f.added}"></span><span class="d" style="flex-grow:${f.removed}"></span>
      </span></span>
      <span class="when" data-ts="${f.last}">${ago(f.last)}</span>
    </div>`
}

/** Cards are kept as elements so bars can grow and cards can light up. */
function renderCards(s, flashPath) {
  for (const n of els.list.querySelectorAll(':scope > :not(.card)')) n.remove()
  const list = [...s.files.values()].sort((a, b) => b.last - a.last)
  const nets = new Map(list.map(f => [f, net(f)]))
  const biggest = Math.max(1, ...list.map(f => nets.get(f).added + nets.get(f).removed))
  const existing = new Map([...els.list.querySelectorAll('.card')].map(el => [el.dataset.path, el]))

  list.forEach((f, i) => {
    const n = nets.get(f)
    const total = n.added + n.removed
    const width = total ? Math.max(8, Math.round((total / biggest) * 100)) : 0
    let el = existing.get(f.filePath)
    if (!el) {
      el = document.createElement('button')
      el.className = 'card'
      el.dataset.path = f.filePath
      el.title = f.rel
      el.innerHTML = cardHtml({ ...f, added: 0, removed: 0 }, 0) // bar grows from 0
    }
    existing.delete(f.filePath)
    el.classList.toggle('create', f.kind === 'create')
    el.classList.toggle('active', f.filePath === selected)
    if (els.list.children[i] !== el) els.list.insertBefore(el, els.list.children[i] || null)
    requestAnimationFrame(() => {
      const fill = el.querySelector('.fill')
      fill.style.width = width + '%'
      fill.querySelector('.a').style.flexGrow = n.added
      fill.querySelector('.d').style.flexGrow = n.removed
      el.querySelector('.plus').textContent = `+${n.added}`
      el.querySelector('.minus').textContent = `−${n.removed}`
      const when = el.querySelector('.when')
      when.dataset.ts = f.last
      when.textContent = ago(f.last)
    })
    if (f.filePath === flashPath) {
      el.classList.remove('flash')
      void el.offsetWidth // restart animation
      el.classList.add('flash')
    }
  })
  for (const el of existing.values()) el.remove()
}

els.list.addEventListener('click', e => {
  const b = e.target.closest('.node.file, .card')
  if (b) pick(b.dataset.path)
})

// ---------------------------------------------------------------------------
// Path bar with branch

const BRANCH_ICON = `<svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" stroke-width="1.3">
  <circle cx="3" cy="2.5" r="1.6"/><circle cx="3" cy="10.5" r="1.6"/><circle cx="8.5" cy="4.5" r="1.6"/>
  <path d="M3 4.1v4.8M8.5 6.1c0 2-2 2.4-5.2 2.9"/></svg>`

/** Branch of the repo the file lives in; nested repos also show the repo name. */
function branchHtml(s, f) {
  const r = f.repo && repos.get(f.repo)
  if (!r || !r.branch) return ''
  const sub = f.repo !== s.info.repo ? `<span class="repo">${esc(r.name)}</span>` : ''
  return `<span class="branch" title="${esc(r.root)}">${sub}${BRANCH_ICON}<span>${esc(r.branch)}</span></span>`
}

function hintHtml(c) {
  const { note } = diffMode(c)
  return (
    (viaGit(c) ? `<span class="hint" title="${GIT_TIP}">via shell</span>` : '') +
    (note ? `<span class="hint">${esc(note)}</span>` : '')
  )
}

function renderJumpbar() {
  const s = cur()
  const f = curFile()
  if (!f) {
    els.jumpbar.innerHTML = s ? `<span>${esc(label(s.info))}</span>` : ''
    return
  }
  const parts = [label(s.info), ...f.rel.split('/')]
  const last = f.changes[f.changes.length - 1]
  els.jumpbar.innerHTML =
    parts.map((p, i) => `<span class="${i === parts.length - 1 ? 'cur' : ''}">${esc(p)}</span>`).join('<span class="sep">›</span>') +
    `<span class="spacer"></span>${
      clearedAt.has(s.info.id)
        ? `<span class="hint fresh" data-act="show-earlier" title="Earlier changes are hidden – click to show them">since ${clockTime(clearedAt.get(s.info.id))} ✕</span>`
        : ''
    }${hintHtml(last)}${branchHtml(s, f)}<span class="meta">${
      f.changes.length === 1 ? (f.kind === 'create' ? 'created' : '1 change') : `${f.changes.length} changes`
    } · ` +
    `<span class="when" data-ts="${last.ts}">${ago(last.ts)}</span> · ` +
    netHtml(f, last) +
    `</span>`
}

/** +/- in the jump bar: net for the file when edits are combined, else the newest edit. */
function netHtml(f, last) {
  const combinedView = combined(f)
  const n = combinedView ? net(f) : last
  const title = combinedView
    ? `Net change ${clearedAt.has(cur()?.info.id) ? 'since the reset' : settings.compare === 'commit' ? 'since the last commit' : 'in this session'} · newest edit: +${last.added} −${last.removed}`
    : 'Newest edit'
  return `<span title="${esc(title)}"><span class="plus">+${n.added}</span> <span class="minus">−${n.removed}</span></span>`
}

// ---------------------------------------------------------------------------
// Diff mode: new, inline or side by side

const SPLIT_MIN_WIDTH = 900

/** Actual mode for a change, with a note if it differs from the setting. */
function diffMode(c) {
  const m = settings.diff
  if (m !== 'split') return { mode: m }
  if (c.kind === 'create') return { mode: 'new', note: 'new file – no previous version' }
  if (els.view.clientWidth < SPLIT_MIN_WIDTH) return { mode: 'inline', note: 'too narrow for side by side' }
  return { mode: 'split' }
}

/** Reconstruct the old content from the new content and the hunks. */
function unpatch(after, hunks) {
  const src = after.split('\n')
  const out = []
  let j = 0
  for (const h of hunks) {
    const start = Math.max(0, h.newStart - 1 + (h.newLines === 0 ? 1 : 0))
    while (j < start && j < src.length) out.push(src[j++])
    for (const l of h.lines) {
      if (l[0] === '-') out.push(l.slice(1))
      else if (l[0] === ' ') {
        out.push(l.slice(1))
        j++
      } else if (l[0] === '+') j++
    }
  }
  while (j < src.length) out.push(src[j++])
  return out.join('\n')
}

/** Line diff old -> new as hunks (same format as the log's structuredPatch). */
function diffLines(before, after, ctx = 3) {
  const toLines = t => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))
  const a = toLines(before)
  const b = toLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  let mid
  if (A.length * B.length > 4e6) mid = [...A.map(l => ['-', l]), ...B.map(l => ['+', l])]
  else {
    const n = A.length
    const m = B.length
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    mid = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        mid.push([' ', A[i++]])
        j++
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) mid.push(['-', A[i++]])
      else mid.push(['+', B[j++]])
    }
    while (i < n) mid.push(['-', A[i++]])
    while (j < m) mid.push(['+', B[j++]])
  }
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
    hunks.push({ oldStart: ol ? oldNo[from] : oldNo[from] - 1, oldLines: ol, newStart: nl ? newNo[from] : newNo[from] - 1, newLines: nl, lines })
  }
  return hunks
}

/**
 * What actually changed in a file during this session (or since its fresh
 * start), like `git diff`: all edits combined into one. Null when marks are set
 * to "latest edit", there is only one edit, or the whole content is unknown.
 */
function combined(f) {
  if (settings.marks === 'latest' || f.content === null) return null
  const s = cur()
  const fresh = !!s && clearedAt.has(s.info.id)
  // Base: the fresh start, or the last commit, or the start of the session
  const base = fresh || !s ? undefined : settings.compare === 'commit' && s.heads.has(f.filePath) ? s.heads.get(f.filePath) : s.bases.get(f.filePath)
  if (f.cum && f.cum.n === f.changes.length && f.cum.content === f.content && f.cum.fresh === fresh && f.cum.base === base) return f.cum.change

  // Whole session: the content before the session first touched the file
  // against now – like git diff, also catches edits missing from the log.
  if (typeof base === 'string') {
    const change = { kind: base === '' ? 'create' : 'update', hunks: diffLines(base, f.content) }
    f.cum = { n: f.changes.length, content: f.content, fresh, base, change }
    return change
  }
  if (f.changes.length < 2) return null
  // Walk back from the current content through the edits since the fresh start.
  let prior = f.content
  for (let i = f.changes.length - 1; i >= 0; i--) {
    const c = f.changes[i]
    if (i === 0 && c.kind === 'create') {
      prior = ''
      break
    }
    prior = unpatch(prior, c.hunks)
  }
  let change = { kind: prior === '' ? 'create' : 'update', hunks: diffLines(prior, f.content) }
  // Plausibility: the net change can't be bigger than all edits together.
  // If it is, the chain of edits has a gap – show the newest edit instead.
  let size = 0
  for (const h of change.hunks) for (const l of h.lines) if (l[0] !== ' ') size++
  if (size > f.added + f.removed) change = null
  f.cum = { n: f.changes.length, content: f.content, fresh, base, change }
  return change
}

/** Net +/- of a file: combined when possible, else the sum of its edits. */
function net(f) {
  const c = combined(f) || (f.changes.length === 1 ? f.changes[0] : null)
  if (!c) return { added: f.added, removed: f.removed }
  if (c.added !== undefined) return { added: c.added, removed: c.removed }
  let added = 0
  let removed = 0
  for (const h of c.hunks)
    for (const l of h.lines) {
      if (l[0] === '+') added++
      else if (l[0] === '-') removed++
    }
  return { added, removed }
}

/** Lines of a hunk aligned in pairs: ctx | mod | del | add. */
function alignHunk(h) {
  const rows = []
  let o = h.oldStart
  let n = h.newStart
  const L = h.lines
  let i = 0
  while (i < L.length) {
    const ch = L[i][0]
    if (ch === ' ') {
      rows.push({ t: 'ctx', o: o++, n: n++, ol: L[i].slice(1), nl: L[i].slice(1) })
      i++
      continue
    }
    if (ch !== '+' && ch !== '-') {
      i++
      continue
    }
    const dels = []
    const adds = []
    while (i < L.length && (L[i][0] === '+' || L[i][0] === '-')) {
      ;(L[i][0] === '-' ? dels : adds).push(L[i].slice(1))
      i++
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = k < dels.length
      const a = k < adds.length
      rows.push({ t: d && a ? 'mod' : d ? 'del' : 'add', o: d ? o++ : '', n: a ? n++ : '', ol: d ? dels[k] : null, nl: a ? adds[k] : null })
    }
  }
  return rows
}

/** Whole file, old against new, aligned line by line. */
function alignFile(oldLines, newLines, hunks) {
  const rows = []
  let oi = 1
  let ni = 1
  const pair = () => rows.push({ t: 'ctx', o: oi, n: ni, ol: oldLines[oi - 1], nl: newLines[ni - 1] })
  for (const h of hunks) {
    const os = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart
    while (oi < os && oi <= oldLines.length && ni <= newLines.length) {
      pair()
      oi++
      ni++
    }
    rows.push(...alignHunk(h))
    let oc = 0
    let nc = 0
    for (const l of h.lines) {
      if (l[0] === ' ' || l[0] === '-') oc++
      if (l[0] === ' ' || l[0] === '+') nc++
    }
    oi = os + oc
    ni = (h.newLines === 0 ? h.newStart + 1 : h.newStart) + nc
  }
  while (oi <= oldLines.length && ni <= newLines.length) {
    pair()
    oi++
    ni++
  }
  return rows
}

/** Table for the side-by-side view. rows may contain gaps { gap: line }. */
function splitTable(rows, lang, animate) {
  const sl = { block: null }
  const sr = { block: null }
  let k = 0
  const out = ['<table class="code split"><colgroup><col class="cl"><col><col class="cl"><col></colgroup>']
  for (const r of rows) {
    if (r.gap) {
      out.push(`<tr class="gap"><td colspan="4">⋯ from line ${r.gap}</td></tr>`)
      continue
    }
    const changed = r.t !== 'ctx'
    const delay = animate && changed && k < STAGGER_MAX ? ` style="animation-delay:${k++ * STAGGER_MS}ms"` : ''
    const left =
      r.ol === null
        ? '<td class="ln"></td><td class="src cfill"></td>'
        : `<td class="ln">${r.o}</td><td class="src${r.t === 'del' || r.t === 'mod' ? ' cdel' : ''}">${Highlight.line(r.ol, lang, sl) || ' '}</td>`
    const right =
      r.nl === null
        ? '<td class="ln lnr"></td><td class="src cfill"></td>'
        : `<td class="ln lnr">${r.n}</td><td class="src${r.t === 'add' || r.t === 'mod' ? ' cadd' : ''}">${Highlight.line(r.nl, lang, sr) || ' '}</td>`
    out.push(`<tr class="sx-${r.t}${animate && changed ? ' in' : ''}"${delay}>${left}${right}</tr>`)
  }
  out.push('</table>')
  return out.join('')
}

// ---------------------------------------------------------------------------
// Content: whole file (editor) or diff blocks (cards)

function renderMain(animate, changeId) {
  const f = curFile()
  if (!f) {
    const s = cur()
    els.view.innerHTML =
      s && clearedAt.has(s.info.id)
        ? `<div class="waiting"><b>Reset at ${clockTime(clearedAt.get(s.info.id))}</b><span>Only changes from now on show up here.</span><span><button class="link" data-act="show-earlier">Show earlier changes</button></span></div>`
        : `<div class="waiting"><b>Waiting for code …</b><span>As soon as Claude creates or changes a file, it shows up here.</span><span>Nothing running? Press <kbd>d</kbd> for a demo.</span></div>`
    return
  }
  if (settings.view === 'cards') return renderDiff(f, animate ? changeId : null)
  const c = f.changes[f.changes.length - 1]
  const cum = combined(f) // all edits of this session (or since the fresh start) as one
  const { mode } = diffMode(cum || c)
  if (mode === 'split') renderEditorSplit(f, cum || c, animate)
  else renderEditor(f, animate, mode === 'inline', cum)
}

function renderEditorSplit(f, c, animate) {
  const lang = Highlight.langOf(f.filePath)
  if (f.content === null) {
    // Whole content unknown: show only the changed parts side by side
    els.view.innerHTML =
      `<div class="notice">Only the changed parts – the log doesn't contain the whole file here.</div>` +
      `<div class="split-wrap">${splitTable(hunkRows(c), lang, animate)}</div>`
    return
  }
  const strip = t => {
    const l = t.split('\n')
    if (l.length > 1 && l[l.length - 1] === '') l.pop()
    return l
  }
  const newLines = strip(f.content)
  const oldLines = strip(unpatch(f.content, c.hunks))
  els.view.innerHTML = `<div class="split-wrap">${splitTable(alignFile(oldLines, newLines, c.hunks), lang, animate)}</div>`
  const first = els.view.querySelector('tr:not(.sx-ctx):not(.gap)')
  if (first) {
    const top = first.offsetTop - els.view.clientHeight * 0.3
    els.view.scrollTo({ top: Math.max(0, top), behavior: animate ? 'smooth' : 'auto' })
  }
}

/** Hunks of a change as aligned rows with gaps in between. */
function hunkRows(c) {
  const rows = []
  c.hunks.forEach((h, hi) => {
    if (hi > 0 || h.newStart > 1) rows.push({ gap: h.newStart })
    rows.push(...alignHunk(h))
  })
  return rows
}

/** Markers for the new file content, from the hunks of the latest change. */
function markers(c) {
  const marks = new Map() // line (1-based) -> 'add' | 'mod'
  const ghosts = new Map() // line -> deleted lines before it
  let first = null
  for (const h of c.hunks) {
    let n = h.newStart || 1
    let i = 0
    const L = h.lines
    while (i < L.length) {
      const ch = L[i][0]
      if (ch !== '+' && ch !== '-') {
        if (ch === ' ') n++
        i++
        continue
      }
      const dels = []
      let adds = 0
      const start = n
      while (i < L.length && (L[i][0] === '+' || L[i][0] === '-')) {
        if (L[i][0] === '-') dels.push(L[i].slice(1))
        else {
          adds++
          n++
        }
        i++
      }
      for (let k = 0; k < adds; k++) marks.set(start + k, dels.length && c.kind !== 'create' ? 'mod' : 'add')
      if (dels.length) ghosts.set(start, (ghosts.get(start) || []).concat(dels))
      if (first === null) first = start
    }
  }
  return { marks, ghosts, first }
}

function rowHtml(num, cls, code, delay) {
  const style = delay !== undefined ? ` style="--d:${delay}"` : ''
  return `<div class="row ${cls}"${style}><span class="gut">${num}</span><span class="code">${code || ' '}</span></div>`
}

function applyStagger() {
  for (const r of els.view.querySelectorAll('.row[style*="--d"]')) {
    r.querySelector('.code').style.animationDelay = `${Number(r.style.getPropertyValue('--d')) * STAGGER_MS}ms`
  }
}

function renderEditor(f, animate, showGhosts = true, cum = null) {
  const c = f.changes[f.changes.length - 1]
  const lang = Highlight.langOf(f.filePath)
  const state = { block: null }
  const out = []

  if (f.content === null) {
    // No full content known: show only the changed parts.
    out.push(`<div class="notice">Only the changed parts – the log doesn't contain the whole file here.</div>`)
    let count = 0
    c.hunks.forEach((h, hi) => {
      if (hi > 0) out.push(`<div class="hunkgap">⋯</div>`)
      let n = h.newStart
      for (const raw of h.lines) {
        const sign = raw[0]
        const code = Highlight.line(raw.slice(1), lang, state)
        if (sign === '-') {
          if (showGhosts) out.push(rowHtml('', 'ghost', code))
        }
        else if (sign === '+') out.push(rowHtml(n++, animate ? 'add fresh' : 'add', code, animate && count < STAGGER_MAX ? count : undefined))
        else out.push(rowHtml(n++, '', code))
        count++
      }
    })
    els.view.innerHTML = out.join('')
    applyStagger()
    if (animate) els.view.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }

  // Marks: everything since the fresh start (cum) or the newest edit.
  // Animation and flying-out ghosts: only the newest edit.
  const latest = markers(c)
  const { marks, ghosts: delmarks } = cum ? markers(cum) : latest
  const { ghosts, first } = latest
  const lines = f.content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let staggered = 0
  const total = Math.min(lines.length, MAX_ROWS)
  for (let i = 1; i <= total + 1; i++) {
    const del = ghosts.get(i)
    if (del && animate && showGhosts) {
      const dstate = { block: null }
      for (const d of del) out.push(rowHtml('', 'ghost', Highlight.line(d, lang, dstate)))
    }
    const wedge = delmarks.get(i)
    if (wedge) out.push(`<i data-delmark="${esc(wedge.join('\n'))}"></i>`) // wedge on the following line
    if (i > total) break
    const mark = marks.get(i)
    let cls = mark || ''
    let delay
    if (mark && animate && latest.marks.has(i)) {
      cls += ' fresh'
      if (staggered < STAGGER_MAX) delay = staggered++
    }
    out.push(rowHtml(i, cls, Highlight.line(lines[i - 1], lang, state), delay))
  }
  if (lines.length > MAX_ROWS) out.push(`<div class="notice">… ${lines.length - MAX_ROWS} more lines</div>`)
  els.view.innerHTML = out.join('')

  for (const m of els.view.querySelectorAll('i[data-delmark]')) {
    const next = m.nextElementSibling
    const target = next && next.classList.contains('row') ? next : m.previousElementSibling
    if (target) {
      target.classList.add('delmark')
      target.querySelector('.gut').title = 'Deleted:\n' + m.dataset.delmark
    }
    m.remove()
  }
  applyStagger()

  if (animate) {
    const ghostEls = els.view.querySelectorAll('.row.ghost')
    if (ghostEls.length) setTimeout(() => ghostEls.forEach(g => g.classList.add('gone')), GHOST_MS)
  }
  if (first !== null) {
    const row = els.view.querySelectorAll('.row:not(.ghost)')[Math.max(0, first - 1)]
    const target = (animate && els.view.querySelector('.row.ghost')) || row
    if (target) {
      const top = target.offsetTop - els.view.clientHeight * 0.3
      els.view.scrollTo({ top: Math.max(0, top), behavior: animate ? 'smooth' : 'auto' })
    }
  }
}

function changeHtml(c, f, isNewest, animate) {
  const { mode } = diffMode(c)
  const meta = `
      <div class="meta">
        <span class="first">${kindWord(f, c)}</span>${viaGit(c) ? `<span class="via" title="${GIT_TIP}">via shell</span>` : ''}<span>${new Date(c.ts).toLocaleTimeString()}</span>
        <span class="when" data-ts="${c.ts}">${ago(c.ts)}</span>
        <span><span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>
      </div>`
  if (mode === 'split') {
    return `<div class="change${isNewest ? '' : ' old'}">${meta}${splitTable(hunkRows(c), Highlight.langOf(c.filePath), animate)}</div>`
  }
  const onlyNew = mode === 'new'
  const lang = Highlight.langOf(c.filePath)
  const state = { block: null }
  const rows = []
  let count = 0
  let hidden = 0

  c.hunks.forEach((h, hi) => {
    if (hi > 0 || (h.newStart > 1 && c.kind !== 'create')) {
      rows.push(`<tr class="gap"><td colspan="${onlyNew ? 3 : 4}">⋯ from line ${h.newStart}</td></tr>`)
    }
    let o = h.oldStart
    let n = h.newStart
    for (const raw of h.lines) {
      if (count >= MAX_DIFF_LINES) {
        hidden++
        continue
      }
      const sign = raw[0]
      if (onlyNew && sign === '-') {
        o++
        continue
      }
      let cls = ''
      let lo = ''
      let ln = ''
      if (sign === '+') {
        cls = 'add'
        ln = n++
      } else if (sign === '-') {
        cls = 'del'
        lo = o++
      } else if (sign === '\\') {
        cls = 'note'
      } else {
        lo = o++
        ln = n++
      }
      const delay = animate && count < STAGGER_MAX ? ` style="animation-delay:${count * STAGGER_MS}ms"` : ''
      const code = cls === 'note' ? esc(raw) : Highlight.line(raw.slice(1), lang, state)
      rows.push(
        `<tr class="${cls}${animate ? ' in' : ''}"${delay}>` +
          (onlyNew ? '' : `<td class="ln">${lo}</td>`) +
          `<td class="ln">${ln}</td>` +
          `<td class="sign">${sign === '+' ? '+' : sign === '-' ? '−' : ''}</td>` +
          `<td class="src">${code || ' '}</td></tr>`,
      )
      count++
    }
  })

  return `
    <div class="change${isNewest ? '' : ' old'}">${meta}
      <table class="code">${rows.join('')}</table>
      ${hidden ? `<div class="more">… ${hidden} more lines hidden</div>` : ''}
    </div>`
}

function renderDiff(f, animateId) {
  const newestFirst = [...f.changes].reverse()
  els.view.innerHTML = newestFirst.map((c, i) => changeHtml(c, f, i === 0, c.id === animateId)).join('')
  if (animateId) els.view.scrollTo({ top: 0, behavior: 'smooth' })
}

// ---------------------------------------------------------------------------
// Toast

let toastTimer
function toast(html) {
  els.toast.innerHTML = html
  els.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600)
}

// ---------------------------------------------------------------------------
// Interaction

function renderAll(opts = {}) {
  renderSessions(opts.ping)
  renderList(opts.flash)
  renderJumpbar()
  renderMain(opts.animate, opts.changeId)
  renderLive()
}

// ---------------------------------------------------------------------------
// Change queue: in live mode every file stays on screen for at least
// settings.dwell seconds. Files changed meanwhile wait their turn (the tree,
// toasts and the buddy react right away). A file that changes again while
// waiting keeps its place and shows its newest state when it's up.

const QUEUE_MAX = 8 // longer backlog: drop the oldest (still in the tree)
let queue = []
let queueTimer = null
let shownAt = 0

function clearQueue() {
  queue = []
  clearTimeout(queueTimer)
  queueTimer = null
}

function showFile(path) {
  selected = path
  shownAt = Date.now()
  const f = curFile()
  renderAll({ flash: path, animate: true, changeId: f ? f.changes[f.changes.length - 1].id : null })
}

function playNext() {
  queueTimer = null
  if (!follow) return clearQueue()
  while (queue.length && !cur()?.files.has(queue[0])) queue.shift()
  if (!queue.length) return
  showFile(queue.shift())
  scheduleQueue()
}

function scheduleQueue() {
  if (queueTimer || !queue.length) return
  const wait = Math.max(0, shownAt + settings.dwell * 1000 - Date.now())
  queueTimer = setTimeout(playNext, wait)
}

/** Live mode, selected session: show now or queue up. Returns true if it was shown now. */
function queueChange(c) {
  if (!settings.dwell || selected === null || Date.now() - shownAt >= settings.dwell * 1000 && !queue.length) {
    showFile(c.filePath)
    return true
  }
  if (c.filePath === selected) return false
  if (!queue.includes(c.filePath)) queue.push(c.filePath)
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX)
  scheduleQueue()
  return false
}

function pick(path) {
  follow = false
  clearQueue()
  selected = path
  renderAll()
}

function goLive() {
  follow = true
  clearQueue()
  selected = cur()?.last?.filePath ?? null
  shownAt = Date.now()
  renderAll()
}

els.live.addEventListener('click', goLive)
els.freshBtn.addEventListener('click', freshStart)

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Escape') {
    if (!els.sessionMenu.hidden) els.sessionMenu.hidden = true
    else if (!els.settings.hidden) toggleSettings(false)
    else if (!els.status.hidden) toggleStatus(false)
    else goLive()
  } else if (e.key === 'v') setSetting('view', settings.view === 'editor' ? 'cards' : 'editor')
  else if (e.key === 's') {
    const order = ['new', 'inline', 'split']
    setSetting('diff', order[(order.indexOf(settings.diff) + 1) % order.length])
  }
  else if (e.key === 't') {
    const order = ['light', 'dark', 'system']
    setSetting('theme', order[(order.indexOf(settings.theme) + 1) % order.length])
  } else if (e.key === 'd') Demo.toggle()
  else if (e.key === 'i') toggleStatus()
  else if (e.key === 'c') freshStart()
})

// File tree width: drag the edge, double-click resets. Remembered per browser.
const NAV_MIN = 180
function setNavWidth(px) {
  if (px === null) els.layout.style.removeProperty('--nav-w')
  else els.layout.style.setProperty('--nav-w', `${px}px`)
}
try {
  const w = Number(localStorage.getItem('whc.navWidth'))
  if (w >= NAV_MIN) setNavWidth(w)
} catch {}
els.resizer.addEventListener('pointerdown', e => {
  e.preventDefault()
  els.resizer.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const left = els.layout.getBoundingClientRect().left
  const move = ev => {
    const max = Math.min(720, window.innerWidth * 0.6)
    setNavWidth(Math.round(Math.max(NAV_MIN, Math.min(max, ev.clientX - left))))
  }
  const up = () => {
    document.body.classList.remove('resizing')
    els.resizer.removeEventListener('pointermove', move)
    els.resizer.removeEventListener('pointerup', up)
    try {
      localStorage.setItem('whc.navWidth', parseInt(els.layout.style.getPropertyValue('--nav-w')) || '')
    } catch {}
    window.dispatchEvent(new Event('resize')) // side by side depends on the width
  }
  els.resizer.addEventListener('pointermove', move)
  els.resizer.addEventListener('pointerup', up)
})
els.resizer.addEventListener('dblclick', () => {
  setNavWidth(null)
  try {
    localStorage.removeItem('whc.navWidth')
  } catch {}
  window.dispatchEvent(new Event('resize'))
})

// Double-click on an empty spot of the title bar behaves like the native one (Mac/Windows app).
document.querySelector('.titlebar').addEventListener('dblclick', e => {
  if (e.target.closest('button, .session, .settings-wrap, .session-menu, a')) return
  if (host) host({ titlebar: 'dblclick' })
})

// Side by side depends on the width: redraw on resize
let resizeTimer
let lastWide = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const wide = els.view.clientWidth >= SPLIT_MIN_WIDTH
    if (settings.diff === 'split' && wide !== lastWide) {
      renderJumpbar()
      renderMain()
    }
    lastWide = wide
  }, 150)
})

// Refresh times and session dots regularly
setInterval(() => {
  for (const el of document.querySelectorAll('.when[data-ts]')) el.textContent = ago(Number(el.dataset.ts))
  renderSessions()
}, 2000)

$('logo').innerHTML = PixelLogo.svg('Watch Him Code', { cell: 3, edge: 1, drop: 2 })
const buddy = Buddy.create(els.buddy)
applySettings()
// Check at start (opens the panel if needed), then keep the badge current.
setTimeout(loadStatus, 1500)
setInterval(() => els.status.hidden && loadStatus(), 15000)

// ---------------------------------------------------------------------------
// Live connection

const events = new EventSource('/events?v=2')

events.addEventListener('open', () => {
  connected = true
  renderLive()
  restorePinned()
})
events.addEventListener('error', () => {
  connected = false
  renderLive()
})

events.addEventListener('reset', e => {
  const snap = JSON.parse(e.data)
  const next = new Map()
  for (const si of snap.sessions) {
    const { changes, bases, nows, heads, ...info } = si
    const s = newSession(info)
    s.bases = new Map(Object.entries(bases || {}))
    s.heads = new Map(Object.entries(heads || {}))
    s.nows = new Map(Object.entries(nows || {}))
    s.all = []
    for (const c of changes) remember(s, c)
    rebuild(s)
    next.set(info.id, s)
  }
  sessions = next
  repos = new Map((snap.repos || []).map(r => [r.root, r]))
  Demo.keep(sessions, repos) // the demo tab survives server resets
  if (pendingSelect && sessions.has(pendingSelect)) {
    sessionId = pendingSelect
    pendingSelect = null
    follow = true
  } else if (!sessions.has(sessionId) || !tabOpen(cur())) {
    sessionId = pickDefaultSession()
    follow = true
  }
  const s = cur()
  if (follow || !s || !s.files.has(selected)) {
    follow = true
    selected = s?.last?.filePath ?? null
  }
  connected = true
  els.list.innerHTML = ''
  renderAll()
  buddy.wake(s && s.last ? s.last.ts : 0)
})

// A commit happened: new HEAD versions for that repo's files
events.addEventListener('heads', e => {
  const { sessionId: sid, heads } = JSON.parse(e.data)
  const s = sessions.get(sid)
  if (!s) return
  for (const [file, text] of Object.entries(heads)) s.heads.set(file, text)
  if (settings.compare === 'commit' && sid === sessionId) {
    renderList()
    renderJumpbar()
    renderMain()
  }
})

events.addEventListener('repo', e => {
  const r = JSON.parse(e.data)
  repos.set(r.root, r)
  renderJumpbar()
})

events.addEventListener('session', e => {
  const info = JSON.parse(e.data)
  const s = sessions.get(info.id)
  if (s) s.info = info
  else sessions.set(info.id, newSession(info))
  renderSessions()
  if (info.id === sessionId) renderJumpbar()
  ensureSelection()
})

events.addEventListener('change', e => {
  const { sessionId: sid, change: c } = JSON.parse(e.data)
  receive(sid, c)
})

/** A new change for a session – from the server or from the demo. */
function receive(sid, c) {
  let s = sessions.get(sid)
  if (!s) {
    s = newSession({ id: sid, project: '', cwd: '', title: '', active: Date.now() })
    sessions.set(sid, s)
  }
  if ('base' in c && !s.bases.has(c.filePath)) s.bases.set(c.filePath, c.base)
  if (typeof c.head === 'string' && !s.heads.has(c.filePath)) s.heads.set(c.filePath, c.head)
  s.nows.delete(c.filePath) // a live change brings the current content
  remember(s, c)
  if (!shownChange(sid, c)) return // before this session's fresh start
  const f = addChange(s, c)

  // Selected session has no changes of its own? Switch to the active one
  // (not when it's empty because of a fresh start).
  if (follow && (!cur() || (cur().files.size === 0 && !clearedAt.has(sessionId)))) {
    sessionId = sid
    els.list.innerHTML = ''
  }
  if (sid !== sessionId) {
    renderSessions(sid) // only the other session's dot blinks
    return
  }
  if (!follow) renderAll({ flash: c.filePath, animate: selected === c.filePath, changeId: c.id })
  else if (!queueChange(c)) {
    // waiting its turn: tree and tabs update right away; same file on screen gets the new state
    renderSessions()
    renderList(c.filePath)
    renderJumpbar()
    if (c.filePath === selected) renderMain(true, c.id)
  }
  if (selected !== c.filePath) {
    toast(
      `✎ ${esc(split(c.rel).name)} ${kindWord(f, c)} ` +
        `<span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span>`,
    )
  }
  buddy.onChange(c, f, s)
}
