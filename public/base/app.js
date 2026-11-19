'use strict'

const MAX_LINES = 1500 // pro Änderung, danach gekürzt
const STAGGER_MS = 14 // Verzögerung zwischen eingeblendeten Zeilen
const STAGGER_MAX = 70 // nur die ersten N Zeilen gestaffelt

const $ = id => document.getElementById(id)
const els = {
  files: $('files'),
  diff: $('diff'),
  project: $('project'),
  totals: $('totals'),
  live: $('live'),
  liveLabel: $('live-label'),
  toast: $('toast'),
}

/** filePath -> { filePath, rel, kind, added, removed, changes[], last } */
let files = new Map()
let follow = true
let selected = null
let connected = false

// ---------------------------------------------------------------------------
// Zustand

function addChange(c) {
  let f = files.get(c.filePath)
  if (!f) {
    f = { filePath: c.filePath, rel: c.rel, kind: c.kind, added: 0, removed: 0, changes: [], last: 0 }
    files.set(c.filePath, f)
  }
  f.changes.push(c)
  f.added += c.added
  f.removed += c.removed
  f.last = Math.max(f.last, c.ts)
  f.rel = c.rel
  return f
}

function latestFile() {
  let best = null
  for (const f of files.values()) if (!best || f.last >= best.last) best = f
  return best
}

// ---------------------------------------------------------------------------
// Darstellung

const esc = Highlight.esc
const sorted = () => [...files.values()].sort((a, b) => b.last - a.last)

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

function split(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) }
}

function renderTotals() {
  let a = 0
  let d = 0
  let created = 0
  for (const f of files.values()) {
    a += f.added
    d += f.removed
    if (f.kind === 'create') created++
  }
  els.totals.innerHTML = files.size
    ? `${files.size} Dateien · ${created} neu · <span class="plus">+${a}</span> <span class="minus">−${d}</span>`
    : ''
}

function renderLive() {
  els.live.classList.toggle('on', follow && connected)
  els.live.classList.toggle('offline', !connected)
  els.liveLabel.textContent = !connected ? 'Getrennt' : follow ? 'Live' : 'Live folgen'
}

function cardHtml(f, biggest) {
  const { dir, name } = split(f.rel)
  const total = f.added + f.removed
  const width = total ? Math.max(8, Math.round((total / biggest) * 100)) : 0
  return `
    <div class="row">
      <span class="name" title="${esc(f.rel)}">${esc(name)}</span>
      <span class="badge">${f.kind === 'create' ? 'neu' : 'geändert'}</span>
    </div>
    <div class="dir"><span dir="ltr">${dir ? esc(dir) : '&nbsp;'}</span></div>
    <div class="stats">
      <span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span>
      <span class="bar"><span class="fill" style="width:${width}%">
        <span class="a" style="flex-grow:${f.added}"></span><span class="d" style="flex-grow:${f.removed}"></span>
      </span></span>
      <span class="when" data-ts="${f.last}">${ago(f.last)}</span>
    </div>`
}

/** Baut die Liste neu auf, bestehende Karten bleiben erhalten (für Animationen). */
function renderFiles(flashPath) {
  if (files.size === 0) {
    els.files.innerHTML = `<div class="empty">Noch keine Änderungen<br />in dieser Session.</div>`
    return
  }
  const list = sorted()
  const biggest = Math.max(1, ...list.map(f => f.added + f.removed))
  const existing = new Map([...els.files.querySelectorAll('.card')].map(el => [el.dataset.path, el]))
  els.files.querySelector('.empty')?.remove()

  list.forEach((f, i) => {
    let el = existing.get(f.filePath)
    if (!el) {
      el = document.createElement('button')
      el.className = 'card'
      el.dataset.path = f.filePath
      el.addEventListener('click', () => pick(f.filePath))
      el.innerHTML = cardHtml({ ...f, added: 0, removed: 0 }, biggest) // Balken wächst von 0
    }
    existing.delete(f.filePath)
    el.classList.toggle('create', f.kind === 'create')
    el.classList.toggle('active', f.filePath === selected)
    if (els.files.children[i] !== el) els.files.insertBefore(el, els.files.children[i] || null)
    // Erst im nächsten Frame setzen, damit Balken/Breite animiert wachsen.
    requestAnimationFrame(() => {
      const fresh = document.createElement('div')
      fresh.innerHTML = cardHtml(f, biggest)
      const fill = el.querySelector('.fill')
      const nfill = fresh.querySelector('.fill')
      if (fill && nfill) {
        fill.style.width = nfill.style.width
        fill.querySelector('.a').style.flexGrow = f.added
        fill.querySelector('.d').style.flexGrow = f.removed
        el.querySelector('.plus').textContent = `+${f.added}`
        el.querySelector('.minus').textContent = `−${f.removed}`
        el.querySelector('.badge').textContent = f.kind === 'create' ? 'neu' : 'geändert'
        const when = el.querySelector('.when')
        when.dataset.ts = f.last
        when.textContent = ago(f.last)
      }
    })
    if (f.filePath === flashPath) {
      el.classList.remove('flash')
      void el.offsetWidth // Animation neu starten
      el.classList.add('flash')
    }
  })
  for (const el of existing.values()) el.remove()
}

function changeHtml(c, f, isNewest, animate) {
  const lang = Highlight.langOf(c.filePath)
  const state = { block: null }
  const rows = []
  let count = 0
  let hidden = 0

  c.hunks.forEach((h, hi) => {
    if (hi > 0 || (c.hunks.length && h.newStart > 1 && c.kind !== 'create')) {
      rows.push(`<tr class="gap"><td colspan="4">⋯ ab Zeile ${h.newStart}</td></tr>`)
    }
    let o = h.oldStart
    let n = h.newStart
    for (const raw of h.lines) {
      if (count >= MAX_LINES) {
        hidden++
        continue
      }
      const sign = raw[0]
      const text = raw.slice(1)
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
      const code = cls === 'note' ? esc(raw) : Highlight.line(text, lang, state)
      rows.push(
        `<tr class="${cls}${animate ? ' in' : ''}"${delay}>` +
          `<td class="ln">${lo}</td><td class="ln">${ln}</td>` +
          `<td class="sign">${sign === '+' ? '+' : sign === '-' ? '−' : ''}</td>` +
          `<td class="src">${code || ' '}</td></tr>`,
      )
      count++
    }
  })

  const when = new Date(c.ts).toLocaleTimeString('de-DE')
  const label = c.kind === 'create' && f.changes[0] === c ? 'angelegt' : 'geändert'
  return `
    <div class="change${isNewest ? '' : ' old'}" data-id="${c.id}">
      <div class="meta">
        <span class="first">${label}</span><span>${when}</span><span class="when" data-ts="${c.ts}">${ago(c.ts)}</span>
        <span><span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>
      </div>
      <table class="code">${rows.join('')}</table>
      ${hidden ? `<div class="more">… ${hidden} weitere Zeilen ausgeblendet</div>` : ''}
    </div>`
}

/** animateId: diese Änderung wird mit eingeblendeten Zeilen gezeigt. */
function renderDiff(animateId) {
  const f = selected && files.get(selected)
  if (!f) {
    els.diff.innerHTML = `
      <div class="empty">
        <div class="big">Warte auf Code…</div>
        <div>Sobald Claude eine Datei anlegt oder ändert, erscheint sie hier.</div>
      </div>`
    return
  }
  const { dir, name } = split(f.rel)
  const newestFirst = [...f.changes].reverse()
  els.diff.innerHTML =
    `<div class="head ${f.kind}">
       <div class="path"><span class="muted">${esc(dir)}</span>${esc(name)}</div>
       <span class="badge">${f.kind === 'create' ? 'neu' : 'geändert'}</span>
       <span><span class="plus">+${f.added}</span> <span class="minus">−${f.removed}</span></span>
     </div>` + newestFirst.map((c, i) => changeHtml(c, f, i === 0, c.id === animateId)).join('')
  if (animateId) els.diff.scrollTo({ top: 0, behavior: 'smooth' })
}

let toastTimer
function toast(html) {
  els.toast.innerHTML = html
  els.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600)
}

// ---------------------------------------------------------------------------
// Bedienung

function pick(path) {
  follow = false
  selected = path
  renderFiles()
  renderDiff()
  renderLive()
}

function goLive() {
  follow = true
  selected = latestFile()?.filePath ?? null
  renderFiles()
  renderDiff()
  renderLive()
}

els.live.addEventListener('click', goLive)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') goLive()
})

setInterval(() => {
  for (const el of document.querySelectorAll('.when[data-ts]')) el.textContent = ago(Number(el.dataset.ts))
}, 15000)

// ---------------------------------------------------------------------------
// Live-Verbindung

const events = new EventSource('/events')

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
  files = new Map()
  for (const c of snap.changes) addChange(c)
  els.project.textContent = snap.project || ''
  document.title = snap.project ? `base · ${snap.project}` : "Watch 'Em Code · base"
  if (follow || !files.has(selected)) {
    follow = true
    selected = latestFile()?.filePath ?? null
  }
  els.files.innerHTML = ''
  renderFiles()
  renderDiff()
  renderTotals()
  connected = true
  renderLive()
})

events.addEventListener('change', e => {
  const c = JSON.parse(e.data)
  const f = addChange(c)
  if (follow) selected = c.filePath
  renderFiles(c.filePath)
  renderTotals()
  if (selected === c.filePath) renderDiff(c.id)
  else
    toast(
      `✎ ${esc(split(c.rel).name)} ${f.changes.length === 1 && c.kind === 'create' ? 'angelegt' : 'geändert'} ` +
        `<span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span>`,
    )
})
