'use strict'
// Reine Ansicht: zeigt die Dateien so, wie der Agent sie gerade verändert.
// Bearbeiten ist bewusst nicht möglich.

const MAX_TABS = 6
const BUSY_MS = 4000 // so lange gilt eine Datei/Session als „gerade in Arbeit“
const GHOST_MS = 2600 // gelöschte Zeilen bleiben so lange sichtbar
const STAGGER_MS = 22
const STAGGER_MAX = 40
const MAX_ROWS = 20000

const $ = id => document.getElementById(id)
const els = {
  sessions: $('sessions'),
  tree: $('tree'),
  tabs: $('tabs'),
  jumpbar: $('jumpbar'),
  editor: $('editor'),
  live: $('live'),
  liveLabel: $('live-label'),
  buddyToggle: $('buddy-toggle'),
}
const esc = Highlight.esc

// ---------------------------------------------------------------------------
// Zustand

/** id -> { info, files: Map<path, File>, tabs: path[], order: change[] } */
let sessions = new Map()
let sessionId = null // gewählte Session
let selected = null // gewählte Datei (filePath)
let follow = true
let connected = false

function newSession(info) {
  return { info, files: new Map(), tabs: [], last: null }
}

/** Datei: { filePath, rel, kind, added, removed, changes[], content, last } */
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
  f.content = c.after // null, wenn unbekannt: dann Diff-Ansicht
  if (!s.last || c.ts >= s.last.ts) s.last = c
  openTab(s, c.filePath)
  return f
}

function openTab(s, path) {
  if (s.tabs.includes(path)) return
  s.tabs.push(path)
  if (s.tabs.length > MAX_TABS) s.tabs.shift()
}

const cur = () => sessions.get(sessionId)

function label(info) {
  return info.title || info.project || info.id.slice(0, 8)
}

function pickDefaultSession() {
  let best = null
  for (const s of sessions.values()) {
    const t = s.last ? s.last.ts : 0
    const bt = best ? (best.last ? best.last.ts : 0) : -1
    if (t > bt || (t === bt && s.info.active > best.info.active)) best = s
  }
  return best ? best.info.id : null
}

// ---------------------------------------------------------------------------
// Hilfen

function split(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i), name: rel.slice(i + 1) }
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 10) return 'gerade eben'
  if (s < 60) return `vor ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `vor ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `vor ${h} h`
  return new Date(ts).toLocaleDateString('de-DE')
}

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
    <path d="M2 .5h6l4.5 4.5v8a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 13V2A1.5 1.5 0 0 1 2 .5z" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-opacity=".75"/>
    <path d="M8 .8V5h4.2" fill="none" stroke="${c}" stroke-opacity=".75"/></svg>`
}
const folderIcon = `<svg class="icon" width="15" height="12" viewBox="0 0 15 12">
  <path d="M1.5.5h4l1.5 1.5h6.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V1.5a1 1 0 0 1 1-1z" fill="#7a9cc6" fill-opacity=".35" stroke="#7a9cc6" stroke-opacity=".6"/></svg>`

// ---------------------------------------------------------------------------
// Titelleiste: Sessions

function renderSessions(pingId) {
  const now = Date.now()
  const list = [...sessions.values()].sort((a, b) => a.info.id.localeCompare(b.info.id))
  els.sessions.innerHTML = list
    .map(s => {
      const lastTs = s.last ? s.last.ts : 0
      const cls = [
        'session',
        s.info.id === sessionId ? 'selected' : '',
        now - lastTs < BUSY_MS * 2 ? 'busy' : now - s.info.active < 120000 ? 'recent' : '',
        s.info.id === pingId ? 'ping' : '',
      ].join(' ')
      const title = `${s.info.cwd || ''}${s.info.cwd ? '\n' : ''}${s.files.size} Dateien geändert`
      return `<button class="${cls}" data-id="${s.info.id}" title="${esc(title)}"><span class="dot"></span><span class="label">${esc(label(s.info))}</span></button>`
    })
    .join('')
  // Bei nur einer Session reicht der Name, ohne Auswahl-Optik.
  els.sessions.style.opacity = list.length ? 1 : 0
}

els.sessions.addEventListener('click', e => {
  const b = e.target.closest('.session')
  if (!b) return
  sessionId = b.dataset.id
  follow = true
  selected = cur()?.last?.filePath ?? null
  renderAll()
})

function renderLive() {
  els.live.classList.toggle('on', follow && connected)
  els.live.classList.toggle('offline', !connected)
  els.liveLabel.textContent = !connected ? 'Getrennt' : follow ? 'Live' : 'Live folgen'
}

// ---------------------------------------------------------------------------
// Navigator: Ordnerbaum

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

function renderTree(flashPath) {
  const s = cur()
  if (!s || s.files.size === 0) {
    els.tree.innerHTML = `<div class="empty-tree">Noch keine Änderungen in dieser Session.</div>`
    return
  }
  const rows = []
  const walk = (node, depth) => {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (let [name, child] of dirs) {
      // Ordnerketten mit nur einem Unterordner zusammenfassen (src/components)
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
      const cls = ['node', 'file', st, f.filePath === selected ? 'selected' : '', f.filePath === flashPath ? 'flash' : ''].join(' ')
      rows.push(
        `<button class="${cls}" data-path="${esc(f.filePath)}" style="padding-left:${8 + depth * 14 + 16}px" title="${esc(f.rel)}">` +
          `${fileIcon(name)}<span class="name">${esc(name)}</span>` +
          `<span class="counts"><span class="plus">+${f.added}</span> <span class="minus">−${f.removed}</span></span>` +
          `<span class="status ${st}">${st}</span></button>`,
      )
    }
  }
  walk(buildTree(s.files.values()), 0)
  els.tree.innerHTML = rows.join('')
}

els.tree.addEventListener('click', e => {
  const b = e.target.closest('.node.file')
  if (b) pick(b.dataset.path)
})

// ---------------------------------------------------------------------------
// Tabs + Jump Bar

function renderTabs(enterPath) {
  const s = cur()
  if (!s) {
    els.tabs.innerHTML = ''
    return
  }
  const now = Date.now()
  els.tabs.innerHTML = s.tabs
    .map(p => {
      const f = s.files.get(p)
      if (!f) return ''
      const st = f.kind === 'create' ? 'A' : 'M'
      const name = split(f.rel).name
      const cls = ['tab', st, p === selected ? 'selected' : '', now - f.last < BUSY_MS ? 'busy' : '', p === enterPath ? 'enter' : ''].join(' ')
      return `<button class="${cls}" data-path="${esc(p)}" title="${esc(f.rel)}">${fileIcon(name)}<span class="name">${esc(name)}</span><span class="pip"></span></button>`
    })
    .join('')
}

els.tabs.addEventListener('click', e => {
  const b = e.target.closest('.tab')
  if (b) pick(b.dataset.path)
})

function renderJumpbar() {
  const s = cur()
  const f = s && selected && s.files.get(selected)
  if (!f) {
    els.jumpbar.innerHTML = s ? `<span>${esc(label(s.info))}</span>` : ''
    return
  }
  const parts = [label(s.info), ...f.rel.split('/')]
  const last = f.changes[f.changes.length - 1]
  els.jumpbar.innerHTML =
    parts.map((p, i) => `<span class="${i === parts.length - 1 ? 'cur' : ''}">${esc(p)}</span>`).join('<span class="sep">›</span>') +
    `<span class="spacer"></span><span class="meta">${f.changes.length === 1 ? (f.kind === 'create' ? 'angelegt' : '1 Änderung') : `${f.changes.length} Änderungen`} · ` +
    `<span class="when" data-ts="${last.ts}">${ago(last.ts)}</span> · ` +
    `<span class="plus">+${last.added}</span> <span class="minus">−${last.removed}</span></span>`
}

// ---------------------------------------------------------------------------
// Code-Ansicht

/** Markierungen für den neuen Dateiinhalt aus den Hunks der letzten Änderung. */
function markers(c) {
  const marks = new Map() // Zeile (1-basiert) -> 'add' | 'mod'
  const ghosts = new Map() // Zeile -> gelöschte Zeilen davor
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

function rowHtml(num, cls, code, extra = '') {
  return `<div class="row ${cls}"${extra}><span class="gut">${num}</span><span class="code">${code || ' '}</span></div>`
}

function renderEditor(animate) {
  const s = cur()
  const f = s && selected && s.files.get(selected)
  if (!f) {
    els.editor.innerHTML = `<div class="waiting"><b>Warte auf Code …</b><span>Sobald Claude eine Datei anlegt oder ändert, erscheint sie hier.</span></div>`
    return
  }
  const c = f.changes[f.changes.length - 1]
  const lang = Highlight.langOf(f.filePath)
  const state = { block: null }
  const out = []

  if (f.content === null) {
    // Kein vollständiger Inhalt bekannt: nur die geänderten Stellen zeigen.
    out.push(`<div class="notice">Nur die geänderten Stellen – den ganzen Inhalt kennt das Protokoll hier nicht.</div>`)
    let count = 0
    c.hunks.forEach((h, hi) => {
      if (hi > 0) out.push(`<div class="hunkgap">⋯</div>`)
      let n = h.newStart
      for (const raw of h.lines) {
        const sign = raw[0]
        const text = raw.slice(1)
        const delay = animate && count < STAGGER_MAX ? ` style="--d:${count}"` : ''
        if (sign === '-') out.push(rowHtml('', 'ghost', Highlight.line(text, lang, state)))
        else {
          const cls = sign === '+' ? `add${animate ? ' fresh' : ''}` : ''
          out.push(rowHtml(n++, cls, Highlight.line(text, lang, state), delay))
        }
        count++
      }
    })
    els.editor.innerHTML = out.join('')
    applyStagger()
    if (animate) els.editor.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }

  const { marks, ghosts, first } = markers(c)
  const lines = f.content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let staggered = 0
  const total = Math.min(lines.length, MAX_ROWS)
  for (let i = 1; i <= total + 1; i++) {
    const del = ghosts.get(i)
    if (del) {
      const dstate = { block: null }
      const title = esc(del.join('\n'))
      if (animate) for (const d of del) out.push(rowHtml('', 'ghost', Highlight.line(d, lang, dstate)))
      // Keil am Folgezeilen-Rand merken
      out.push(`<i data-delmark="${title}"></i>`)
    }
    if (i > total) break
    const mark = marks.get(i)
    let cls = mark || ''
    let extra = ''
    if (mark && animate) {
      cls += ' fresh'
      if (staggered < STAGGER_MAX) extra = ` style="--d:${staggered++}"`
    }
    out.push(rowHtml(i, cls, Highlight.line(lines[i - 1], lang, state), extra))
  }
  if (lines.length > MAX_ROWS) out.push(`<div class="notice">… ${lines.length - MAX_ROWS} weitere Zeilen</div>`)
  els.editor.innerHTML = out.join('')

  // Platzhalter für gelöschte Stellen in Keil-Markierungen umwandeln
  for (const m of els.editor.querySelectorAll('i[data-delmark]')) {
    const next = m.nextElementSibling
    const target = next && next.classList.contains('row') ? next : m.previousElementSibling
    if (target) {
      target.classList.add('delmark')
      target.querySelector('.gut').title = 'Gelöscht:\n' + m.dataset.delmark
    }
    m.remove()
  }
  applyStagger()

  if (animate) {
    const ghostsEls = els.editor.querySelectorAll('.row.ghost')
    if (ghostsEls.length) setTimeout(() => ghostsEls.forEach(g => g.classList.add('gone')), GHOST_MS)
  }
  // Zur geänderten Stelle scrollen
  if (first !== null) {
    const row = els.editor.querySelectorAll('.row:not(.ghost)')[Math.max(0, first - 1)]
    const target = (animate && els.editor.querySelector('.row.ghost')) || row
    if (target) {
      const top = target.offsetTop - els.editor.clientHeight * 0.3
      els.editor.scrollTo({ top: Math.max(0, top), behavior: animate ? 'smooth' : 'auto' })
    }
  }
}

function applyStagger() {
  for (const r of els.editor.querySelectorAll('.row[style*="--d"]')) {
    r.querySelector('.code').style.animationDelay = `${Number(r.style.getPropertyValue('--d')) * STAGGER_MS}ms`
  }
}

// ---------------------------------------------------------------------------
// Bedienung

function renderAll(opts = {}) {
  renderSessions(opts.ping)
  renderTree(opts.flash)
  renderTabs(opts.enter)
  renderJumpbar()
  renderEditor(opts.animate)
  renderLive()
}

function pick(path) {
  follow = false
  selected = path
  renderAll()
}

function goLive() {
  follow = true
  selected = cur()?.last?.filePath ?? null
  renderAll()
}

els.live.addEventListener('click', goLive)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') goLive()
})

// Zeiten und „in Arbeit“-Punkte regelmäßig auffrischen
setInterval(() => {
  for (const el of document.querySelectorAll('.when[data-ts]')) el.textContent = ago(Number(el.dataset.ts))
  renderSessions()
  renderTabs()
}, 2000)

// Pixel-Junior
const buddy = Buddy.create($('buddy'))
let buddyOn = true
try {
  buddyOn = localStorage.getItem('whc.buddy') !== 'off'
} catch {}
function applyBuddy() {
  $('buddy').classList.toggle('hidden', !buddyOn)
  els.buddyToggle.classList.toggle('on', buddyOn)
}
els.buddyToggle.addEventListener('click', () => {
  buddyOn = !buddyOn
  try {
    localStorage.setItem('whc.buddy', buddyOn ? 'on' : 'off')
  } catch {}
  applyBuddy()
})
applyBuddy()

// ---------------------------------------------------------------------------
// Live-Verbindung

const events = new EventSource('/events?v=2')

events.addEventListener('open', () => {
  connected = true
  renderLive()
})
events.addEventListener('error', () => {
  connected = false
  renderLive()
})

events.addEventListener('reset', e => {
  const snap = JSON.parse(e.data)
  const next = new Map()
  for (const si of snap.sessions) {
    const { changes, ...info } = si
    const s = newSession(info)
    for (const c of changes) addChange(s, c)
    next.set(info.id, s)
  }
  sessions = next
  if (!sessions.has(sessionId)) {
    sessionId = pickDefaultSession()
    follow = true
  }
  const s = cur()
  if (follow || !s || !s.files.has(selected)) {
    follow = true
    selected = s?.last?.filePath ?? null
  }
  connected = true
  renderAll()
  buddy.wake(s && s.last ? s.last.ts : 0)
})

events.addEventListener('session', e => {
  const info = JSON.parse(e.data)
  const s = sessions.get(info.id)
  if (s) s.info = info
  else sessions.set(info.id, newSession(info))
  renderSessions()
  if (info.id === sessionId) renderJumpbar()
})

events.addEventListener('change', e => {
  const { sessionId: sid, change: c } = JSON.parse(e.data)
  let s = sessions.get(sid)
  if (!s) {
    s = newSession({ id: sid, project: '', cwd: '', title: '', active: Date.now() })
    sessions.set(sid, s)
  }
  const isNewFile = !s.files.has(c.filePath)
  const f = addChange(s, c)

  // Ausgewählte Session ohne eigene Änderungen? Dann zur aktiven wechseln.
  if (follow && (!cur() || cur().files.size === 0)) sessionId = sid

  if (sid !== sessionId) {
    renderSessions(sid) // nur der Punkt der anderen Session blinkt
    return
  }
  if (follow) selected = c.filePath
  renderAll({
    flash: c.filePath,
    enter: isNewFile ? c.filePath : null,
    animate: selected === c.filePath,
  })
  buddy.onChange(c, f, s)
})
