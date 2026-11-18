'use strict'
// Der Pixel-Junior: eine kleine eigene Figur mit Mütze und Laptop.
// Reagiert nur auf Code-Änderungen: tippt, legt Dateien ab, radiert,
// schläft ein, wenn nichts passiert, und schreckt hoch, wenn es weitergeht.

const Buddy = (() => {
  const SCALE = 5
  const W = 20
  const H = 16
  const COLORS = {
    P: '#e8c27a', // Bommel
    h: '#d9a35a', // Mütze
    H: '#b8843f', // Mützenrand
    s: '#efc8a0', // Haut
    c: '#e3a48e', // Wangen
    b: '#5f9e8f', // Pulli
    L: '#8d929b', // Laptop
    D: '#6b7079', // Laptop unten
    g: '#d8e9e0', // Logo
    e: '#2b2b31', // Augen
    m: '#9a5b4f', // Mund
  }
  // Grundfigur ohne Augen, Hände und Mund
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

  // Sprechblasen: selten, kurz, nur aus Fakten der Änderung.
  const COOLDOWN_MS = 75000
  function remark(c, f, s, ctx) {
    const name = f.rel.split('/').pop()
    const lower = name.toLowerCase()
    const created = [...s.files.values()].filter(x => x.kind === 'create').length
    if (ctx.wokeUp) return 'Oh! Weiter geht’s.'
    if (s.files.size === 1 && f.changes.length === 1) return c.kind === 'create' ? 'Erste Datei. Los geht’s!' : 'Und los.'
    if (c.added >= 150) return `+${c.added} Zeilen am Stück. Mutig.`
    if (c.removed >= 10 && c.removed > c.added * 2) return 'Mehr gelöscht als geschrieben. Aufräumen!'
    if ([3, 5, 8].includes(f.changes.length)) return `${f.changes.length}. Runde an ${name}. Knifflige Stelle?`
    if (c.kind === 'create' && [5, 10, 20].includes(created)) return `Schon ${created} neue Dateien.`
    if (c.kind === 'create' && /(test|spec)/.test(lower)) return 'Tests! Sehr vernünftig.'
    if (c.kind === 'create' && /readme|\.md$/.test(lower)) return 'Doku. Selten, aber schön.'
    if (/\.(css|scss|less)$/.test(lower) && f.changes.length === 1) return 'Jetzt wird’s hübsch.'
    if (c.added + c.removed === 1) return 'Ein Zeichen hier, ein Zeichen da.'
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

    // Takt: Tippen animieren, Zustände wechseln, ab und zu blinzeln/umschauen
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

    /** Beim Laden: letzte bekannte Änderung, damit er nicht grundlos tippt. */
    function wake(ts) {
      lastChange = ts || 0
      if (!ts) lastChange = Date.now() - SLEEP_AFTER / 2
      draw()
    }

    /** Vorführung aller Reaktionen, ohne echte Änderungen (Taste „d“). */
    let demoRunning = false
    function demo() {
      if (demoRunning) return
      demoRunning = true
      const saved = lastChange
      const typing = () => (lastChange = Date.now())
      const steps = [
        [0, () => (typing(), paper(), say('Erste Datei. Los geht’s!'))],
        [4500, () => (typing(), say('+240 Zeilen am Stück. Mutig.'))],
        [9000, () => (typing(), crumbs(), say('Mehr gelöscht als geschrieben. Aufräumen!'))],
        [13500, () => (typing(), say('3. Runde an app.js. Knifflige Stelle?'))],
        [18000, () => (typing(), paper(), say('Tests! Sehr vernünftig.'))],
        [22500, () => (typing(), say('Jetzt wird’s hübsch.'))],
        [27000, () => (typing(), say('Ein Zeichen hier, ein Zeichen da.'))],
        [31500, () => (lastChange = Date.now() - SLEEP_AFTER - 1)], // einschlafen
        [38000, () => (startle(), typing(), setTimeout(() => say('Oh! Weiter geht’s.'), 500))],
        [44000, () => ((lastChange = Math.max(saved, Date.now() - TYPE_FOR - 1)), (demoRunning = false))],
      ]
      for (const [t, fn] of steps) setTimeout(fn, t)
    }

    draw()
    return { onChange, wake, say, demo }
  }

  return { create }
})()
