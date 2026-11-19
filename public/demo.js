'use strict'
// Demo mode (key "d"): plays a made-up session in its own "Demo" tab, through
// the same path as real changes – tree, editor, cards, diffs, toasts and the
// Pixel Junior. Real sessions keep running next to it. "d" again removes it.

const Demo = (() => {
  const ID = 'demo'
  const ROOT = '/demo/pixel-todo'
  const BRANCH = 'feature/dark-mode'

  // ---------------------------------------------------------------------------
  // The story: a small todo app gets a dark mode.

  const APP_V1 = `import { renderList } from './list.js'
import { loadTodos, saveTodos } from './storage.js'

const todos = loadTodos()

function addTodo(text) {
  todos.push({ id: Date.now(), text, done: false })
  saveTodos(todos)
  renderList(todos)
}

function toggleTodo(id) {
  const todo = todos.find(t => t.id === id)
  todo.done = !todo.done
  saveTodos(todos)
  renderList(todos)
}

renderList(todos)
`

  const LEGACY = `// Old theme handling from 2019. Nobody dares to touch it.
var themeState = null

function oldGetTheme() {
  if (themeState === null) {
    themeState = document.cookie.indexOf('dark=1') >= 0 ? 'dark' : 'light'
  }
  return themeState
}

function oldSetTheme(t) {
  themeState = t
  document.cookie = 'dark=' + (t === 'dark' ? '1' : '0')
  var links = document.getElementsByTagName('link')
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute('data-theme')) {
      links[i].disabled = links[i].getAttribute('data-theme') !== t
    }
  }
}

function oldToggleTheme() {
  oldSetTheme(oldGetTheme() === 'dark' ? 'light' : 'dark')
}

window.oldToggleTheme = oldToggleTheme
`

  const README_V1 = `# Pixel Todo

A tiny todo app. No framework, no build step, no excuses.

## Run it

Open \`index.html\` in a browser.
`

  const emoji = () => {
    const names = ['tada', 'rocket', 'bug', 'sparkles', 'fire', 'coffee', 'moon', 'sun', 'star', 'heart']
    const rows = []
    for (let i = 0; i < 158; i++) rows.push(`  { "name": "${names[i % names.length]}-${i}", "tag": "todo-${i % 12}" },`)
    rows[rows.length - 1] = rows[rows.length - 1].replace(/,$/, '')
    return `[\n${rows.join('\n')}\n]\n`
  }

  // [delay before this step (ms), file, new content | (old) => new, options]
  const STEPS = [
    [600, 'src/theme.js', `// Dark mode, because our users' eyes deserve better.
export const THEMES = ['light', 'dark']

export function getTheme() {
  return localStorage.getItem('theme') || 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('theme', theme)
}
`],
    [4200, 'src/app.js', old => old.replace("import { loadTodos", "import { getTheme, applyTheme } from './theme.js'\nimport { loadTodos").replace(/renderList\(todos\)\n$/, 'applyTheme(getTheme())\nrenderList(todos)\n'), { base: APP_V1 }],
    [4200, 'src/styles/dark.css', `:root[data-theme='dark'] {
  --bg: #1f1f23;
  --text: #dcdce0;
  --accent: #b9764a;
}

body {
  background: var(--bg);
  color: var(--text);
  transition: background 0.2s, color 0.2s;
}

.todo.done {
  opacity: 0.5;
  text-decoration: line-through;
}
`],
    [4200, 'src/app.js', old => old.replace('applyTheme(getTheme())\n', `function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

document.querySelector('#theme-toggle').addEventListener('click', toggleTheme)
applyTheme(getTheme())
`)],
    [4200, 'src/app.js', old => old.replace('  const todo = todos.find(t => t.id === id)\n', '  const todo = todos.find(t => t.id === id)\n  if (!todo) return // TODO: show a friendly error\n')],
    [4200, 'tests/theme.test.js', `import { describe, it, expect } from 'vitest'
import { getTheme, applyTheme } from '../src/theme.js'

describe('theme', () => {
  it('defaults to light', () => {
    localStorage.clear()
    expect(getTheme()).toBe('light')
  })

  it('remembers dark mode', () => {
    applyTheme('dark')
    expect(getTheme()).toBe('dark')
  })
})
`],
    // The agent reaches for sed: picked up through git, marked "via shell"
    [4200, 'src/theme.js', old => old.replace(/localStorage\.(get|set)Item\('theme'/g, "localStorage.$1Item('pixel-todo.theme'"), { source: 'git' }],
    [4200, 'src/app.js', old => old.replace('function toggleTheme() {\n', "function toggleTheme() {\n  console.log('toggle theme', getTheme())\n")],
    [4200, 'src/data/emoji.json', emoji()],
    [4200, 'src/legacy-theme.js', '// Replaced by theme.js – see src/theme.js\n', { base: LEGACY }],
    [4200, 'src/app.js', old => old.replace("  console.log('toggle theme', getTheme())\n", '')],
    // Nothing happens for a while: the junior dozes off …
    [800, null, 'nap'],
    // … and startles awake when work resumes.
    [6500, 'README.md', old => old + '\n## Dark mode\n\nClick the moon in the top right. Your choice is remembered.\n', { base: README_V1 }],
    [4500, null, 'end'],
  ]

  // ---------------------------------------------------------------------------
  // Line diff → hunks in Claude Code's structuredPatch format

  const toLines = t => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))

  function diff(before, after, ctx = 3) {
    const a = toLines(before)
    const b = toLines(after)
    const n = a.length
    const m = b.length
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    const ops = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push([' ', a[i++]])
        j++
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(['-', a[i++]])
      else ops.push(['+', b[j++]])
    }
    while (i < n) ops.push(['-', a[i++]])
    while (j < m) ops.push(['+', b[j++]])

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

  // ---------------------------------------------------------------------------
  // Running it

  let timers = []
  let contents = new Map()
  let seq = 0
  let previous = null // session selected before the demo
  let running = false

  const info = () => ({ id: ID, project: 'pixel-todo', title: 'Demo', cwd: ROOT, repo: ROOT, active: Date.now() })

  /** Called by the app after a server reset: keep the demo tab and its repo. */
  function keep(map, repoMap) {
    const s = sessions.get(ID)
    if (s) map.set(ID, s)
    if (s) repoMap.set(ROOT, { root: ROOT, name: 'pixel-todo', branch: BRANCH })
  }

  function step(file, content, opts = {}) {
    const path = `${ROOT}/${file}`
    const known = contents.has(path)
    const before = known ? contents.get(path) : opts.base ?? null
    const after = typeof content === 'function' ? content(before ?? '') : content
    const hunks = diff(before ?? '', after)
    let added = 0
    let removed = 0
    for (const h of hunks)
      for (const l of h.lines) {
        if (l[0] === '+') added++
        else if (l[0] === '-') removed++
      }
    contents.set(path, after)
    const s = sessions.get(ID)
    if (s) s.info.active = Date.now()
    receive(ID, {
      id: `demo-${++seq}`,
      filePath: path,
      rel: file,
      kind: before === null ? 'create' : 'update',
      hunks,
      added,
      removed,
      after,
      ts: Date.now(),
      repo: ROOT,
      ...(opts.source ? { source: opts.source } : {}),
    })
  }

  function start() {
    stop()
    running = true
    contents = new Map()
    previous = sessionId
    sessions.set(ID, newSession(info()))
    repos.set(ROOT, { root: ROOT, name: 'pixel-todo', branch: BRANCH })
    sessionId = ID
    follow = true
    selected = null
    els.list.innerHTML = ''
    renderAll()
    buddy.setChatty(true)
    toast('▶ Demo started – press <kbd>d</kbd> again to remove it')

    let t = 0
    for (const [delay, file, content, opts] of STEPS) {
      t += delay
      timers.push(
        setTimeout(() => {
          if (content === 'nap') buddy.nap()
          else if (content === 'end') finish()
          else step(file, content, opts)
        }, t),
      )
    }
  }

  function finish() {
    running = false
    buddy.setChatty(false)
    toast('✓ Demo done – the tab stays until you press <kbd>d</kbd>')
  }

  /** Remove the demo tab and go back to the session from before. */
  function stop() {
    timers.forEach(clearTimeout)
    timers = []
    if (running) buddy.setChatty(false)
    running = false
    if (!sessions.has(ID)) return false
    sessions.delete(ID)
    repos.delete(ROOT)
    if (sessionId === ID) {
      sessionId = sessions.has(previous) ? previous : pickDefaultSession()
      follow = true
      selected = cur()?.last?.filePath ?? null
      els.list.innerHTML = ''
    }
    renderAll()
    return true
  }

  /** Key "d": start the demo, or remove it if it is there. */
  function toggle() {
    if (!stop()) start()
  }

  return { toggle, keep, ID }
})()
