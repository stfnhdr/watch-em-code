'use strict'
// Reine Ansicht: zeigt die Dateien so, wie der Agent sie gerade verändert.
// Bearbeiten ist bewusst nicht möglich. Zwei Ansichten mit gleichem Funktionsumfang:
//   Editor – Ordnerbaum + ganze Datei, Änderungen im Rand (Xcode-artig)
//   Karten – Dateikarten + Diff-Blöcke aller Änderungen einer Datei

const BUSY_MS = 4000 // so lange gilt eine Session als „gerade in Arbeit“
const GHOST_MS = 2600 // gelöschte Zeilen bleiben so lange sichtbar
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
  toast: $('toast'),
  buddy: $('buddy'),
}
const esc = Highlight.esc

// ---------------------------------------------------------------------------
// Einstellungen (bleiben im Browser gespeichert)

const DEFAULTS = { view: 'editor', theme: 'system', buddy: true, diff: 'inline' }
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
  // In der Mac-App: Titelleiste des Fensters mitfärben
  try {
    window.webkit?.messageHandlers?.whc?.postMessage({ theme: t })
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
  for (const b of els.settings.querySelectorAll('[data-key]')) {
    b.classList.toggle('on', String(settings[b.dataset.key]) === b.dataset.value)
  }
  if (!changed || changed === 'view') els.list.innerHTML = ''
  if (!changed || changed === 'view' || changed === 'diff') renderAll()
}

els.settings.addEventListener('click', e => {
  const b = e.target.closest('[data-key]')
  if (!b) return
  const v = b.dataset.key === 'buddy' ? b.dataset.value === 'true' : b.dataset.value
  setSetting(b.dataset.key, v)
})
function toggleSettings(open = els.settings.hidden) {
  els.settings.hidden = !open
  els.settingsBtn.classList.toggle('open', open)
}
els.settingsBtn.addEventListener('click', e => {
  e.stopPropagation()
  toggleSettings()
})
document.addEventListener('click', e => {
  if (!els.settings.hidden && !e.target.closest('.settings-wrap')) toggleSettings(false)
})

// ---------------------------------------------------------------------------
// Zustand

/** id -> { info, files: Map<path, File>, last: change } */
let sessions = new Map()
let sessionId = null // gewählte Session
let selected = null // gewählte Datei (filePath)
let follow = true
let connected = false
/** Repo-Wurzel -> { name, branch } */
let repos = new Map()

function newSession(info) {
  return { info, files: new Map(), last: null }
}

/** Datei: { filePath, rel, kind, added, removed, changes[], content, last, repo } */
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
  f.content = c.after // null, wenn unbekannt: dann nur die geänderten Stellen
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

const kindWord = (f, c) => (c.kind === 'create' && f.changes[0] === c ? 'angelegt' : 'geändert')

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
// Titelleiste: Session-Tabs und Live

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
      const r = s.info.repo && repos.get(s.info.repo)
      const title = [s.info.cwd, r && r.branch ? `Branch: ${r.branch}` : '', `${s.files.size} Dateien geändert`]
        .filter(Boolean)
        .join('\n')
      const proj = s.info.title && s.info.project ? `<span class="proj">${esc(s.info.project)}</span>` : ''
      return `<button class="${cls}" data-id="${s.info.id}" title="${esc(title)}"><span class="dot"></span><span class="label">${esc(label(s.info))}</span>${proj}</button>`
    })
    .join('')
}

els.sessions.addEventListener('click', e => {
  const b = e.target.closest('.session')
  if (!b) return
  sessionId = b.dataset.id
  follow = true
  selected = cur()?.last?.filePath ?? null
  els.list.innerHTML = ''
  renderAll()
})

function renderLive() {
  els.live.classList.toggle('on', follow && connected)
  els.live.classList.toggle('offline', !connected)
  els.liveLabel.textContent = !connected ? 'Getrennt' : follow ? 'Live' : 'Live folgen'
}

// ---------------------------------------------------------------------------
// Navigator links: Ordnerbaum (Editor) oder Karten

function renderList(flashPath) {
  const s = cur()
  if (!s || s.files.size === 0) {
    els.list.innerHTML = `<div class="empty-list">Noch keine Änderungen in dieser Session.</div>`
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
  els.list.innerHTML = rows.join('')
}

function cardHtml(f, width) {
  const { dir, name } = split(f.rel)
  return `
    <div class="row1">
      <span class="name">${esc(name)}</span>
      <span class="badge">${f.kind === 'create' ? 'neu' : 'geändert'}</span>
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

/** Karten bleiben als Elemente erhalten, damit Balken wachsen und Karten aufleuchten. */
function renderCards(s, flashPath) {
  for (const n of els.list.querySelectorAll(':scope > :not(.card)')) n.remove()
  const list = [...s.files.values()].sort((a, b) => b.last - a.last)
  const biggest = Math.max(1, ...list.map(f => f.added + f.removed))
  const existing = new Map([...els.list.querySelectorAll('.card')].map(el => [el.dataset.path, el]))

  list.forEach((f, i) => {
    const total = f.added + f.removed
    const width = total ? Math.max(8, Math.round((total / biggest) * 100)) : 0
    let el = existing.get(f.filePath)
    if (!el) {
      el = document.createElement('button')
      el.className = 'card'
      el.dataset.path = f.filePath
      el.title = f.rel
      el.innerHTML = cardHtml({ ...f, added: 0, removed: 0 }, 0) // Balken wächst von 0
    }
    existing.delete(f.filePath)
    el.classList.toggle('create', f.kind === 'create')
    el.classList.toggle('active', f.filePath === selected)
    if (els.list.children[i] !== el) els.list.insertBefore(el, els.list.children[i] || null)
    requestAnimationFrame(() => {
      const fill = el.querySelector('.fill')
      fill.style.width = width + '%'
      fill.querySelector('.a').style.flexGrow = f.added
      fill.querySelector('.d').style.flexGrow = f.removed
      el.querySelector('.plus').textContent = `+${f.added}`
      el.querySelector('.minus').textContent = `−${f.removed}`
      const when = el.querySelector('.when')
      when.dataset.ts = f.last
      when.textContent = ago(f.last)
    })
    if (f.filePath === flashPath) {
      el.classList.remove('flash')
      void el.offsetWidth // Animation neu starten
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
// Pfadzeile mit Branch

const BRANCH_ICON = `<svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" stroke-width="1.3">
  <circle cx="3" cy="2.5" r="1.6"/><circle cx="3" cy="10.5" r="1.6"/><circle cx="8.5" cy="4.5" r="1.6"/>
  <path d="M3 4.1v4.8M8.5 6.1c0 2-2 2.4-5.2 2.9"/></svg>`

/** Branch des Repos, in dem die Datei liegt; bei Unter-Repos mit Repo-Name. */
function branchHtml(s, f) {
  const r = f.repo && repos.get(f.repo)
  if (!r || !r.branch) return ''
  const sub = f.repo !== s.info.repo ? `<span class="repo">${esc(r.name)}</span>` : ''
  return `<span class="branch" title="${esc(r.root)}">${sub}${BRANCH_ICON}<span>${esc(r.branch)}</span></span>`
}

function hintHtml(c) {
  const { note } = diffMode(c)
  return note ? `<span class="hint">${esc(note)}</span>` : ''
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
    `<span class="spacer"></span>${hintHtml(last)}${branchHtml(s, f)}<span class="meta">${
      f.changes.length === 1 ? (f.kind === 'create' ? 'angelegt' : '1 Änderung') : `${f.changes.length} Änderungen`
    } · ` +
    `<span class="when" data-ts="${last.ts}">${ago(last.ts)}</span> · ` +
    `<span class="plus">+${last.added}</span> <span class="minus">−${last.removed}</span></span>`
}

// ---------------------------------------------------------------------------
// Diff-Modus: Neu, Inline oder Nebeneinander

const SPLIT_MIN_WIDTH = 900

/** Tatsächlicher Modus für eine Änderung, mit Hinweis, falls abweichend. */
function diffMode(c) {
  const m = settings.diff
  if (m !== 'split') return { mode: m }
  if (c.kind === 'create') return { mode: 'new', note: 'neue Datei – kein alter Stand' }
  if (els.view.clientWidth < SPLIT_MIN_WIDTH) return { mode: 'inline', note: 'zu schmal für nebeneinander' }
  return { mode: 'split' }
}

/** Alter Inhalt aus neuem Inhalt und Hunks zurückrechnen. */
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

/** Zeilen eines Hunks paarweise ausgerichtet: ctx | mod | del | add. */
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

/** Ganze Datei alt gegen neu, Zeile für Zeile ausgerichtet. */
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

/** Tabelle für die Nebeneinander-Ansicht. rows können Lücken { gap: Zeile } enthalten. */
function splitTable(rows, lang, animate) {
  const sl = { block: null }
  const sr = { block: null }
  let k = 0
  const out = ['<table class="code split"><colgroup><col class="cl"><col><col class="cl"><col></colgroup>']
  for (const r of rows) {
    if (r.gap) {
      out.push(`<tr class="gap"><td colspan="4">⋯ ab Zeile ${r.gap}</td></tr>`)
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
// Inhalt: ganze Datei (Editor) oder Diff-Blöcke (Karten)

function renderMain(animate, changeId) {
  const f = curFile()
  if (!f) {
    els.view.innerHTML = `<div class="waiting"><b>Warte auf Code …</b><span>Sobald Claude eine Datei anlegt oder ändert, erscheint sie hier.</span></div>`
    return
  }
  if (settings.view === 'cards') return renderDiff(f, animate ? changeId : null)
  const c = f.changes[f.changes.length - 1]
  const { mode } = diffMode(c)
  if (mode === 'split') renderEditorSplit(f, c, animate)
  else renderEditor(f, animate, mode === 'inline')
}

function renderEditorSplit(f, c, animate) {
  const lang = Highlight.langOf(f.filePath)
  if (f.content === null) {
    // Ganzer Inhalt unbekannt: nur die geänderten Stellen nebeneinander
    els.view.innerHTML =
      `<div class="notice">Nur die geänderten Stellen – den ganzen Inhalt kennt das Protokoll hier nicht.</div>` +
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

/** Hunks einer Änderung als ausgerichtete Zeilen mit Lücken dazwischen. */
function hunkRows(c) {
  const rows = []
  c.hunks.forEach((h, hi) => {
    if (hi > 0 || h.newStart > 1) rows.push({ gap: h.newStart })
    rows.push(...alignHunk(h))
  })
  return rows
}

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

function rowHtml(num, cls, code, delay) {
  const style = delay !== undefined ? ` style="--d:${delay}"` : ''
  return `<div class="row ${cls}"${style}><span class="gut">${num}</span><span class="code">${code || ' '}</span></div>`
}

function applyStagger() {
  for (const r of els.view.querySelectorAll('.row[style*="--d"]')) {
    r.querySelector('.code').style.animationDelay = `${Number(r.style.getPropertyValue('--d')) * STAGGER_MS}ms`
  }
}

function renderEditor(f, animate, showGhosts = true) {
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

  const { marks, ghosts, first } = markers(c)
  const lines = f.content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let staggered = 0
  const total = Math.min(lines.length, MAX_ROWS)
  for (let i = 1; i <= total + 1; i++) {
    const del = ghosts.get(i)
    if (del) {
      const dstate = { block: null }
      if (animate && showGhosts) for (const d of del) out.push(rowHtml('', 'ghost', Highlight.line(d, lang, dstate)))
      out.push(`<i data-delmark="${esc(del.join('\n'))}"></i>`) // Keil an der Folgezeile
    }
    if (i > total) break
    const mark = marks.get(i)
    let cls = mark || ''
    let delay
    if (mark && animate) {
      cls += ' fresh'
      if (staggered < STAGGER_MAX) delay = staggered++
    }
    out.push(rowHtml(i, cls, Highlight.line(lines[i - 1], lang, state), delay))
  }
  if (lines.length > MAX_ROWS) out.push(`<div class="notice">… ${lines.length - MAX_ROWS} weitere Zeilen</div>`)
  els.view.innerHTML = out.join('')

  for (const m of els.view.querySelectorAll('i[data-delmark]')) {
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
        <span class="first">${kindWord(f, c)}</span><span>${new Date(c.ts).toLocaleTimeString('de-DE')}</span>
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
      rows.push(`<tr class="gap"><td colspan="${onlyNew ? 3 : 4}">⋯ ab Zeile ${h.newStart}</td></tr>`)
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
      ${hidden ? `<div class="more">… ${hidden} weitere Zeilen ausgeblendet</div>` : ''}
    </div>`
}

function renderDiff(f, animateId) {
  const newestFirst = [...f.changes].reverse()
  els.view.innerHTML = newestFirst.map((c, i) => changeHtml(c, f, i === 0, c.id === animateId)).join('')
  if (animateId) els.view.scrollTo({ top: 0, behavior: 'smooth' })
}

// ---------------------------------------------------------------------------
// Hinweisleiste

let toastTimer
function toast(html) {
  els.toast.innerHTML = html
  els.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600)
}

// ---------------------------------------------------------------------------
// Bedienung

function renderAll(opts = {}) {
  renderSessions(opts.ping)
  renderList(opts.flash)
  renderJumpbar()
  renderMain(opts.animate, opts.changeId)
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
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Escape') {
    if (!els.settings.hidden) toggleSettings(false)
    else goLive()
  } else if (e.key === 'v') setSetting('view', settings.view === 'editor' ? 'cards' : 'editor')
  else if (e.key === 's') {
    const order = ['new', 'inline', 'split']
    setSetting('diff', order[(order.indexOf(settings.diff) + 1) % order.length])
  }
  else if (e.key === 't') {
    const order = ['light', 'dark', 'system']
    setSetting('theme', order[(order.indexOf(settings.theme) + 1) % order.length])
  } else if (e.key === 'd' && settings.buddy) buddy.demo()
})

// Nebeneinander hängt von der Breite ab: bei Größenänderung neu zeichnen
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

// Zeiten und Session-Punkte regelmäßig auffrischen
setInterval(() => {
  for (const el of document.querySelectorAll('.when[data-ts]')) el.textContent = ago(Number(el.dataset.ts))
  renderSessions()
}, 2000)

$('logo').innerHTML = PixelLogo.svg('Watch Him Code', { cell: 3, edge: 1, drop: 2 })
const buddy = Buddy.create(els.buddy)
applySettings()

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
  repos = new Map((snap.repos || []).map(r => [r.root, r]))
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
  els.list.innerHTML = ''
  renderAll()
  buddy.wake(s && s.last ? s.last.ts : 0)
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
})

events.addEventListener('change', e => {
  const { sessionId: sid, change: c } = JSON.parse(e.data)
  let s = sessions.get(sid)
  if (!s) {
    s = newSession({ id: sid, project: '', cwd: '', title: '', active: Date.now() })
    sessions.set(sid, s)
  }
  const f = addChange(s, c)

  // Gewählte Session ohne eigene Änderungen? Dann zur aktiven wechseln.
  if (follow && (!cur() || cur().files.size === 0)) {
    sessionId = sid
    els.list.innerHTML = ''
  }
  if (sid !== sessionId) {
    renderSessions(sid) // nur der Punkt der anderen Session blinkt
    return
  }
  if (follow) selected = c.filePath
  renderAll({ flash: c.filePath, animate: selected === c.filePath, changeId: c.id })
  if (selected !== c.filePath) {
    toast(
      `✎ ${esc(split(c.rel).name)} ${kindWord(f, c)} ` +
        `<span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span>`,
    )
  }
  buddy.onChange(c, f, s)
})
