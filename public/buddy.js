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
  const COOLDOWN_MS = 75000
  function remark(c, f, s, ctx) {
    const name = f.rel.split('/').pop()
    const lower = name.toLowerCase()
    const created = [...s.files.values()].filter(x => x.kind === 'create').length
    if (ctx.wokeUp) return 'Oh! Back to work.'
    if (s.files.size === 1 && f.changes.length === 1) return c.kind === 'create' ? 'First file. Here we go!' : 'And off we go.'
    if (c.added >= 150) return `+${c.added} lines in one go. Bold.`
    if (c.removed >= 10 && c.removed > c.added * 2) return 'More deleted than written. Cleanup time!'
    if ([3, 5, 8].includes(f.changes.length)) return `Round ${f.changes.length} on ${name}. Tricky spot?`
    if (c.kind === 'create' && [5, 10, 20].includes(created)) return `${created} new files already.`
    if (c.kind === 'create' && /(test|spec)/.test(lower)) return 'Tests! Very sensible.'
    if (c.kind === 'create' && /readme|\.md$/.test(lower)) return 'Docs. Rare, but lovely.'
    if (/\.(css|scss|less)$/.test(lower) && f.changes.length === 1) return 'Making it pretty now.'
    if (c.added + c.removed === 1) return 'A character here, a character there.'
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
      if (woke || now - lastRemark > COOLDOWN_MS) {
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

    /** Demo of all reactions without real changes (key "d"). */
    let demoRunning = false
    function demo() {
      if (demoRunning) return
      demoRunning = true
      const saved = lastChange
      const typing = () => (lastChange = Date.now())
      const steps = [
        [0, () => (typing(), paper(), say('First file. Here we go!'))],
        [4500, () => (typing(), say('+240 lines in one go. Bold.'))],
        [9000, () => (typing(), crumbs(), say('More deleted than written. Cleanup time!'))],
        [13500, () => (typing(), say('Round 3 on app.js. Tricky spot?'))],
        [18000, () => (typing(), paper(), say('Tests! Very sensible.'))],
        [22500, () => (typing(), say('Making it pretty now.'))],
        [27000, () => (typing(), say('A character here, a character there.'))],
        [31500, () => (lastChange = Date.now() - SLEEP_AFTER - 1)], // fall asleep
        [38000, () => (startle(), typing(), setTimeout(() => say('Oh! Back to work.'), 500))],
        [44000, () => ((lastChange = Math.max(saved, Date.now() - TYPE_FOR - 1)), (demoRunning = false))],
      ]
      for (const [t, fn] of steps) setTimeout(fn, t)
    }

    draw()
    return { onChange, wake, say, demo }
  }

  return { create }
})()
