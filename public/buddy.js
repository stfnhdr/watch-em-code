'use strict'
// The Pixel Junior: a small original character with a beanie and a laptop.
// Reacts only to code changes: types, drops new files, erases,
// falls asleep when nothing happens and startles awake when work resumes.

const Buddy = (() => {
  const SCALE = 5
  const W = 20
  const H = 16
  const COLORS = {
    P: '#e8c27a', // pompom
    h: '#d9a35a', // beanie
    H: '#b8843f', // beanie rim
    s: '#efc8a0', // skin
    c: '#e3a48e', // cheeks
    b: '#5f9e8f', // sweater
    L: '#8d929b', // laptop
    D: '#6b7079', // laptop base
    g: '#d8e9e0', // logo
    e: '#2b2b31', // eyes
    m: '#9a5b4f', // mouth
  }
  // Base figure without eyes, hands and mouth
  const BASE = [
    '.........PP.........',
    '.......hhhhhh.......',
    '......hhhhhhhh......',
    '.....hhhhhhhhhh.....',
    '.....HHHHHHHHHH.....',
    '.....ssssssssss.....',
    '.....ssssssssss.....',
    '.....ssssssssss.....',
    '.....cssssssssc.....',
    '......ssssssss......',
    '....bbbbbbbbbbbb....',
    '...bbbbbbbbbbbbbb...',
    '..LLLLLLLLLLLLLLLL..',
    '..LLLLLLLLLLLLLLLL..',
    '..LLLLLLLgLLLLLLLL..',
    '..DDDDDDDDDDDDDDDD..',
  ]

  const EYES = {
    open: [[7, 6], [7, 7], [12, 6], [12, 7]],
    down: [[7, 7], [12, 7]],
    left: [[6, 6], [6, 7], [11, 6], [11, 7]],
    right: [[8, 6], [8, 7], [13, 6], [13, 7]],
    closed: [[6, 7], [7, 7], [12, 7], [13, 7]],
    wide: [[6, 6], [7, 6], [6, 7], [7, 7], [12, 6], [13, 6], [12, 7], [13, 7]],
  }
  const HANDS = {
    rest: [[4, 11], [5, 11], [14, 11], [15, 11]],
    typeL: [[4, 10], [5, 10], [14, 11], [15, 11]],
    typeR: [[4, 11], [5, 11], [14, 10], [15, 10]],
    up: [[3, 8], [3, 9], [16, 8], [16, 9]],
  }

  function svg(eyes, hands, mouth) {
    const px = BASE.map(r => r.split(''))
    for (const [x, y] of HANDS[hands]) px[y][x] = 's'
    for (const [x, y] of EYES[eyes]) px[y][x] = 'e'
    if (mouth) for (const [x, y] of mouth) px[y][x] = 'm'
    let rects = ''
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const k = px[y][x]
        if (k !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[k]}"/>`
      }
    return `<svg width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects}</svg>`
  }

  // Speech bubbles: rare, short, based only on facts about the change.
  // Each rule has several lines; one is picked at random, never twice in a row.
  const COOLDOWN_MS = 75000
  const LINES = {
    wake: ['Oh! Back to work.', 'I was NOT asleep.', 'Huh? Yes. Code. Watching.', 'Just resting my eyes.'],
    firstCreate: ['First file. Here we go!', 'And so it begins.', 'Blank page no more.', 'A new file is born. Congrats.'],
    firstEdit: ['And off we go.', 'Warming up the keyboard.', 'Let the editing commence.'],
    huge: ['+{n} lines in one go. Bold.', '{n} lines?! Somebody had coffee.', 'That is not a change, that is a novel.', 'Scroll wheel, prepare yourself.'],
    cleanup: ['More deleted than written. Cleanup time!', 'Marie Kondo would be proud.', 'Less code, fewer bugs. Probably.', 'The best code is no code.'],
    rounds: ['Round {n} on {file}. Tricky spot?', '{file} again. It knows what it did.', 'Edit #{n} on {file}. Persistence!', 'Still {file}? Still {file}.'],
    manyFiles: ['{n} new files already.', '{n} new files. Is this a framework now?', 'Look at all these files. {n}!'],
    tests: ['Tests! Very sensible.', 'Writing tests? Who ARE you?', 'A test file. My hero.', 'Future you says thanks for the tests.'],
    docs: ['Docs. Rare, but lovely.', 'Documentation! Frame this moment.', 'Someone will actually read this. Maybe.'],
    css: ['Making it pretty now.', 'CSS time. Good luck centering that div.', 'Pixels are being pushed.', 'Ah, the cascade. Fun.'],
    tiny: ['A character here, a character there.', 'One line. Surgical.', 'Precision engineering.', 'Tiny change, huge confidence.'],
    todo: ['A TODO. Future you will love that.', 'TODO: actually do the TODO.', 'Another TODO for the pile.'],
    debug: ['console.log debugging. A classic.', 'print() – the debugger of champions.', 'Debug output. We have all been there.'],
    func: ['New function: {fn}(). Nice name.', 'Hello, {fn}(). Welcome to the codebase.', '{fn}() just moved in.'],
    imports: ['New import. The dependency tree grows.', 'Importing friends.', 'Pulling in reinforcements.'],
    config: ['Config files. Living on the edge.', 'Touching config. Brave.', 'Settings, settings everywhere.'],
    comments: ['Comments! Explaining the why. Respect.', 'Look at those comments. Chef’s kiss.'],
    lateNight: ['Coding after midnight? Bold choice.', 'It is late. The bugs come out at night.', 'Shh, the code is sleeping. Oh wait.'],
    earlyBird: ['Early bird gets the merge.', 'Coding before breakfast? Impressive.'],
    friday: ['Friday afternoon deploy energy.', 'It is Friday. Are we sure about this?'],
  }
  let lastLine = ''
  function pick(key, vars = {}) {
    const pool = LINES[key]
    let line = pool[Math.floor(Math.random() * pool.length)]
    if (pool.length > 1 && line === lastLine) line = pool[(pool.indexOf(line) + 1) % pool.length]
    lastLine = line
    return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  }

  function remark(c, f, s, ctx) {
    const name = f.rel.split('/').pop()
    const lower = name.toLowerCase()
    const created = [...s.files.values()].filter(x => x.kind === 'create').length
    const added = c.hunks.flatMap(h => h.lines.filter(l => l[0] === '+').map(l => l.slice(1)))
    const has = re => added.some(l => re.test(l))
    const hour = new Date().getHours()
    const fn = added.map(l => /(?:function\s+|def\s+|func\s+|fn\s+)([A-Za-z_$][\w$]*)/.exec(l)).find(Boolean)

    if (ctx.wokeUp) return pick('wake')
    if (s.files.size === 1 && f.changes.length === 1) return pick(c.kind === 'create' ? 'firstCreate' : 'firstEdit')
    if (c.added >= 150) return pick('huge', { n: c.added })
    if (c.removed >= 10 && c.removed > c.added * 2) return pick('cleanup')
    if (has(/\b(TODO|FIXME|HACK)\b/)) return pick('todo')
    if (has(/\bconsole\.(log|debug)\(|^\s*print\(|\bdbg!\(|fmt\.Println\(/)) return pick('debug')
    if ([3, 5, 8, 13].includes(f.changes.length)) return pick('rounds', { n: f.changes.length, file: name })
    if (c.kind === 'create' && [5, 10, 20].includes(created)) return pick('manyFiles', { n: created })
    if (c.kind === 'create' && /(test|spec)/.test(lower)) return pick('tests')
    if (c.kind === 'create' && /readme|\.md$/.test(lower)) return pick('docs')
    if (/\.(css|scss|less)$/.test(lower) && f.changes.length === 1) return pick('css')
    if (/(package\.json|\.ya?ml|\.toml|config|\.env)/.test(lower)) return pick('config')
    if (fn && Math.random() < 0.6) return pick('func', { fn: fn[1] })
    if (has(/^\s*(import\s|from\s+\S+\s+import|const .* = require\(|use\s+\w)/) && Math.random() < 0.5) return pick('imports')
    if (added.filter(l => /^\s*(\/\/|#|\/\*|\*)/.test(l)).length >= 3) return pick('comments')
    if (c.added + c.removed === 1) return pick('tiny')
    if ((hour >= 23 || hour < 4) && Math.random() < 0.3) return pick('lateNight')
    if (hour >= 5 && hour < 7 && Math.random() < 0.3) return pick('earlyBird')
    if (new Date().getDay() === 5 && hour >= 15 && Math.random() < 0.2) return pick('friday')
    return null
  }

  function create(root) {
    root.innerHTML = `
      <div class="bubble"></div>
      <span class="zzz">z</span><span class="zzz z2">z</span>
      <div class="figure"></div>
      <div class="desk"></div>`
    const fig = root.querySelector('.figure')
    const bubble = root.querySelector('.bubble')

    let lastChange = 0
    let mode = 'idle' // typing | idle | sleep | startle
    let frame = 0
    let look = 'open'
    let lastRemark = 0
    let bubbleTimer = null
    let chatty = false

    const SLEEP_AFTER = 120000
    const TYPE_FOR = 3500

    function draw() {
      let eyes = look
      let hands = 'rest'
      let mouth = null
      if (mode === 'typing') {
        eyes = 'down'
        hands = frame % 2 ? 'typeL' : 'typeR'
      } else if (mode === 'sleep') {
        eyes = 'closed'
      } else if (mode === 'startle') {
        eyes = 'wide'
        hands = 'up'
        mouth = [[9, 9], [10, 9]]
      }
      fig.innerHTML = svg(eyes, hands, mouth)
      root.classList.toggle('sleeping', mode === 'sleep')
    }

    function say(text) {
      if (!text) return
      bubble.textContent = text
      bubble.classList.add('show')
      clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 4500)
    }

    function spark(cls, style = '') {
      const el = document.createElement('div')
      el.className = 'spark ' + cls
      if (style) el.setAttribute('style', style)
      root.appendChild(el)
      setTimeout(() => el.remove(), 1600)
    }

    // Tick: animate typing, switch states, blink or look around now and then
    setInterval(() => {
      const idle = Date.now() - lastChange
      if (mode === 'startle') return
      if (idle < TYPE_FOR) mode = 'typing'
      else if (lastChange && idle > SLEEP_AFTER) mode = 'sleep'
      else if (!lastChange && idle > SLEEP_AFTER) mode = 'sleep'
      else mode = 'idle'
      frame++
      if (mode === 'idle' && frame % 6 === 0) {
        const r = Math.random()
        look = r < 0.15 ? 'closed' : r < 0.3 ? 'left' : r < 0.45 ? 'right' : 'open'
      }
      draw()
    }, 170)

    function startle() {
      mode = 'startle'
      draw()
      fig.classList.remove('jump')
      void fig.offsetWidth
      fig.classList.add('jump')
      setTimeout(() => {
        mode = 'typing'
        draw()
      }, 700)
    }
    const paper = () => spark('paper')
    const crumbs = () => {
      for (let i = 0; i < 5; i++) spark('crumb', `--dx:${(i - 2) * 9}px;animation-delay:${i * 60}ms`)
    }

    function onChange(c, f, s) {
      const woke = mode === 'sleep'
      lastChange = Date.now()
      if (woke) startle()
      if (c.kind === 'create' && f.changes.length === 1) paper()
      if (c.removed >= 5 && c.removed > c.added) crumbs()
      const now = Date.now()
      if (woke || now - lastRemark > (chatty ? 3000 : COOLDOWN_MS)) {
        const text = remark(c, f, s, { wokeUp: woke })
        if (text) {
          lastRemark = now
          setTimeout(() => say(text), woke ? 500 : 200)
        }
      }
    }

    /** On load: last known change, so he doesn't type for no reason. */
    function wake(ts) {
      lastChange = ts || 0
      if (!ts) lastChange = Date.now() - SLEEP_AFTER / 2
      draw()
    }

    /** Demo mode: comment on every change instead of only now and then. */
    function setChatty(on) {
      chatty = on
    }
    /** Demo mode: doze off right away (the next change wakes him up). */
    function nap() {
      lastChange = Date.now() - SLEEP_AFTER - 1
    }

    draw()
    return { onChange, wake, say, setChatty, nap }
  }

  return { create }
})()
