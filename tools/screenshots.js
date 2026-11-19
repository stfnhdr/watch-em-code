#!/usr/bin/env node
// Generates the README screenshots from a made-up demo project, so no real
// sessions, paths or code end up in the images. No dependencies: talks to a
// headless Chrome via the DevTools protocol (Node's built-in WebSocket).
//
//   node tools/screenshots.js        → docs/screenshots/*.png
//
// Requires Google Chrome (or Chromium) and Node 22+.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'screenshots')
const PORT = 4790
const CDP_PORT = 9333
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Demo data

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whc-demo-'))
const PROJECT = path.join(HOME, 'projects', 'pixel-todo')
const API = path.join(HOME, 'projects', 'api-server')
for (const [dir, branch] of [[PROJECT, 'feature/dark-mode'], [API, 'fix/flaky-login']]) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
}

/** Minimal line diff (LCS) → structuredPatch hunks with 3 lines of context. */
function diff(oldText, newText) {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([' ', a[i++], j++])
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push(['+', b[j++]])
    else ops.push(['-', a[i++]])
  }
  // group into hunks
  const hunks = []
  let o = 1
  let nn = 1
  let cur = null
  let lastChange = -10
  ops.forEach((op, k) => {
    const changed = op[0] !== ' '
    const near = ops.slice(k, k + 4).some(x => x[0] !== ' ') || k - lastChange <= 3
    if (near) {
      if (!cur) cur = { oldStart: o, newStart: nn, oldLines: 0, newLines: 0, lines: [] }
      cur.lines.push(op[0] + op[1])
      if (op[0] !== '+') cur.oldLines++
      if (op[0] !== '-') cur.newLines++
    } else if (cur) {
      hunks.push(cur)
      cur = null
    }
    if (changed) lastChange = k
    if (op[0] !== '+') o++
    if (op[0] !== '-') nn++
  })
  if (cur) hunks.push(cur)
  return hunks
}

class Session {
  constructor(id, cwd, title) {
    this.id = id
    this.cwd = cwd
    const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(path.join(dir, id), { recursive: true })
    fs.writeFileSync(path.join(dir, id, 'custom-title.json'), JSON.stringify({ customTitle: title }))
    this.log = path.join(dir, id + '.jsonl')
    this.files = new Map()
  }
  line(result, ago) {
    const entry = {
      type: 'user',
      cwd: this.cwd,
      sessionId: this.id,
      timestamp: new Date(Date.now() - ago * 1000).toISOString(),
      toolUseResult: result,
    }
    fs.appendFileSync(this.log, JSON.stringify(entry) + '\n')
  }
  write(rel, content, ago = 0) {
    const filePath = path.join(this.cwd, rel)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
    this.files.set(rel, content)
    this.line({ type: 'create', filePath, content, structuredPatch: [], originalFile: null }, ago)
  }
  edit(rel, from, to, ago = 0) {
    const filePath = path.join(this.cwd, rel)
    const before = this.files.get(rel)
    const after = before.replace(from, to)
    fs.writeFileSync(filePath, after)
    this.files.set(rel, after)
    this.line({ filePath, oldString: from, newString: to, originalFile: before, structuredPatch: diff(before, after), replaceAll: false }, ago)
  }
}

const todo = new Session(crypto.randomUUID(), PROJECT, 'Add dark mode to the todo app')
const api = new Session(crypto.randomUUID(), API, 'Fix flaky login test')

const THEME_JS = `// Dark mode, because our users' eyes deserve better.
export const THEMES = ['light', 'dark']

export function getTheme() {
  return localStorage.getItem('theme') ?? 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('theme', theme)
}
`
const APP_JS = `import { renderList } from './list.js'
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

document.querySelector('#new-todo').addEventListener('submit', e => {
  e.preventDefault()
  const input = e.target.elements.text
  if (input.value.trim()) addTodo(input.value.trim())
  input.value = ''
})

renderList(todos)
`
const STYLES = `:root {
  --bg: #ffffff;
  --text: #1d1d1f;
  --accent: #e0823c;
}

body {
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, sans-serif;
}

.todo.done {
  opacity: 0.5;
  text-decoration: line-through;
}
`
const TEST_JS = `import { describe, it, expect } from 'vitest'
import { getTheme, applyTheme } from '../src/theme.js'

describe('theme', () => {
  it('defaults to light', () => {
    expect(getTheme()).toBe('light')
  })

  it('remembers the chosen theme', () => {
    applyTheme('dark')
    expect(getTheme()).toBe('dark')
  })
})
`

function seed() {
  api.write('tests/login.test.js', `import { login } from '../src/auth.js'\n\nit('logs in', async () => {\n  await login('demo', 'hunter2')\n})\n`, 900)
  api.edit('tests/login.test.js', "it('logs in', async () => {", "it('logs in', { retry: 0, timeout: 5000 }, async () => {", 840)

  todo.write('src/app.js', APP_JS, 420)
  todo.write('src/styles.css', STYLES, 360)
  todo.write('src/theme.js', THEME_JS, 300)
  todo.write('tests/theme.test.js', TEST_JS, 240)
  todo.edit('src/styles.css', ':root {\n  --bg: #ffffff;\n  --text: #1d1d1f;\n  --accent: #e0823c;\n}\n',
    ":root {\n  --bg: #ffffff;\n  --text: #1d1d1f;\n  --accent: #e0823c;\n}\n\n:root[data-theme='dark'] {\n  --bg: #1f1f23;\n  --text: #dcdce0;\n}\n", 180)
  todo.edit('src/app.js', "import { loadTodos, saveTodos } from './storage.js'\n",
    "import { loadTodos, saveTodos } from './storage.js'\nimport { getTheme, applyTheme } from './theme.js'\n", 120)
}

/** The "live" change the screenshots catch mid-animation. */
function liveChange() {
  todo.edit('src/app.js',
    "function toggleTodo(id) {\n  const todo = todos.find(t => t.id === id)\n  todo.done = !todo.done\n  saveTodos(todos)\n  renderList(todos)\n}\n",
    "function toggleTodo(id) {\n  const todo = todos.find(t => t.id === id)\n  if (!todo) return // TODO: show a friendly error\n  todo.done = !todo.done\n  saveTodos(todos)\n  renderList(todos)\n}\n\nfunction toggleTheme() {\n  applyTheme(getTheme() === 'dark' ? 'light' : 'dark')\n}\n\ndocument.querySelector('#theme-toggle').addEventListener('click', toggleTheme)\n")
}

// ---------------------------------------------------------------------------
// Chrome via DevTools protocol

function findChrome() {
  const c = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return c.find(p => fs.existsSync(p))
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise(res => {
      const n = ++id
      pending.set(n, res)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  return { send, close: () => ws.close() }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  seed()

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, HOME, USERPROFILE: HOME, WHC_NO_OPEN: '1', WHC_PORT: String(PORT) },
    stdio: 'ignore',
  })
  const chromePath = findChrome()
  if (!chromePath) throw new Error('Chrome not found')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whc-chrome-'))
  const chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    let target
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200)
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
        target = list.find(t => t.type === 'page')
      } catch {}
    }
    const page = await cdp(target.webSocketDebuggerUrl)
    await page.send('Page.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 2, mobile: false })
    const url = `http://127.0.0.1:${PORT}/`
    const go = async settings => {
      await page.send('Page.navigate', { url })
      await sleep(800)
      await page.send('Runtime.evaluate', { expression: `localStorage.setItem('whc.settings', ${JSON.stringify(JSON.stringify(settings))})` })
      await page.send('Page.reload')
      await sleep(1800)
    }
    const shot = async (name, clip) => {
      const r = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
      console.log('✓', name)
    }

    // 1. Editor, dark, inline – caught mid-change with the Pixel Junior talking
    await go({ view: 'editor', theme: 'dark', diff: 'inline', buddy: true })
    liveChange()
    await sleep(1500)
    await page.send('Runtime.evaluate', { expression: "document.querySelector('.bubble').textContent = 'A TODO. Future you will love that.'; document.querySelector('.bubble').classList.add('show')" })
    await sleep(300)
    await shot('editor-dark.png')

    // 2. Side by side, dark
    await go({ view: 'editor', theme: 'dark', diff: 'split', buddy: true })
    await shot('side-by-side-dark.png')

    // 3. Cards, light
    await go({ view: 'cards', theme: 'light', diff: 'inline', buddy: true })
    await shot('cards-light.png')

    // 4. Pixel Junior close-up with a speech bubble
    await go({ view: 'editor', theme: 'dark', diff: 'inline', buddy: true })
    await page.send('Runtime.evaluate', { expression: "document.querySelector('.bubble').textContent = 'Writing tests? Who ARE you?'; document.querySelector('.bubble').classList.add('show')" })
    await sleep(400)
    await shot('pixel-junior.png', { x: 0, y: 860 - 260, width: 260, height: 260 })

    page.close()
  } finally {
    chrome.kill()
    server.kill()
    await sleep(300)
    fs.rmSync(HOME, { recursive: true, force: true })
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
