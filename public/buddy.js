'use strict'
// The Pixel Junior: a small original character with a beanie and a laptop.
// Reacts only to code changes: types, drops new files, erases,
// falls asleep when nothing happens and startles awake when work resumes.

const Buddy = (() => {
  // Default grid; a character can bring its own size and pixel scale.
  const SCALE = 5
  const W = 20
  const H = 16

  // Avatars: same 20×16 grid, same laptop, same animations. Each one only
  // defines its colors, a base picture (without eyes, hands and mouth) and
  // where eyes, hands and the startled mouth go.
  const CHARACTERS = {
    // The Pixel Junior: a small original character with a beanie (24×26 at 4 px).
    junior: {
      name: 'Pixel Junior',
      w: 24,
      h: 26,
      scale: 4,
      colors: {
        P: '#e8c27a', // pompom
        B: '#d9a35a', // beanie
        R: '#b8843f', // beanie rim
        Q: '#c99550', // rim ribs, fold
        A: '#7a5236', // hair, brows
        K: '#efc8a0', // skin
        N: '#d9a37f', // ears
        C: '#e3a48e', // cheeks
        M: '#9a5b4f', // mouth
        T: '#5f9e8f', // sweater
        U: '#4c8476', // sweater shade
        Y: '#7fb8a8', // collar
        L: '#8d929b', // laptop
        D: '#6b7079', // laptop base
        k: '#d8e9e0', // logo
        e: '#2b2b31', // eyes
        m: '#7a3f36', // open mouth
      },
      base: [
        '..........PPPP..........',
        '..........PPPP..........',
        '.........BBPPBB.........',
        '.......BBBQBBBQBB.......',
        '......BBBQBBBBBQBB......',
        '.....BBBBBBBBBBBBBB.....',
        '.....BBBBBBBBBBBBBB.....',
        '....RQRQRQRQRQRQRQRQ....',
        '....RQRQRQRQRQRQRQRQ....',
        '......AAAKKKKKKAAA......',
        '......AKKKKKKKKKKA......',
        '......KKAAKKKKAAKK......',
        '.....NKKKKKKKKKKKKN.....',
        '.....NKKKKKKKKKKKKN.....',
        '......KKKKKKKKKKKK......',
        '......KCKKKKKKKKCK......',
        '.......KKKKMMKKKK.......',
        '........KKKKKKKK........',
        '........TYKKKKYT........',
        '......TTTYTKKTYTTT......',
        '.....TTTTTTTTTTTTTT.....',
        '..LLLLLLLLLLLLLLLLLLLL..',
        '..LLLLLLLLLLLLLLLLLLLL..',
        '..LLLLLLLLLkkLLLLLLLLL..',
        '..LLLLLLLLLLLLLLLLLLLL..',
        '..DDDDDDDDDDDDDDDDDDDD..',
      ],
      eyes: {
        open: [[9, 12], [9, 13], [14, 12], [14, 13]],
        down: [[9, 13], [14, 13]],
        left: [[8, 12], [8, 13], [13, 12], [13, 13]],
        right: [[10, 12], [10, 13], [15, 12], [15, 13]],
        closed: [[8, 13], [9, 13], [14, 13], [15, 13]],
        wide: [[8, 12], [9, 12], [8, 13], [9, 13], [14, 12], [15, 12], [14, 13], [15, 13]],
      },
      hands: {
        rest: [[5, 20], [6, 20], [17, 20], [18, 20]],
        typeL: [[5, 19], [6, 19], [17, 20], [18, 20]],
        typeR: [[5, 20], [6, 20], [17, 19], [18, 19]],
        up: [[2, 15], [2, 16], [21, 15], [21, 16]],
      },
      hand: 'K',
      mouth: [[11, 16], [12, 16], [11, 17], [12, 17]],
    },

    // Werner Sauer: the team's alpaca, after the team's own pixel drawing (32×32 at 4 px).
    // Tall ears, wavy rainbow wool with a zigzag fringe, an angry look, a long
    // yellow scarf and a laptop seen from behind. Sparks fly while he types.
    werner: {
      name: 'Werner',
      w: 32,
      h: 32,
      scale: 4,
      colors: {
        o: '#49351D', // outline, brows, nose
        f: '#F0E8D5', // face, ears
        i: '#F6B3BA', // inner ears
        r: '#F2B0B3', // wool: pink
        a: '#F4D8B4', // wool: peach
        y: '#F3F4B2', // wool: yellow
        l: '#F1BAEA', // wool: rose
        v: '#ADA8EA', // wool: violet
        b: '#9AC8ED', // wool: blue
        c: '#A4EFE4', // wool: mint
        g: '#B1EFA9', // wool: green
        S: '#FFDA00', // scarf
        s: '#D9A900', // scarf shade
        H: '#87849D', // laptop rim
        L: '#53516C', // laptop lid
        K: '#292638', // laptop edge
        k: '#B7B5C5', // logo
        h: '#F0E8D5', // hooves
        e: '#2b2b31', // eyes
        m: '#7a3f36', // open mouth
        z: '#FFDA00', // sparks
      },
      base: [
        '................................',
        '......ooo..........ooo..........',
        '......offo........offo..........',
        '......ofifo......ofifo..........',
        '......ofifoooooooofifo..........',
        '......ofiiorrrrrroiifo..........',
        '.......oforrrrrrrrofo...........',
        '.......orrrrrrrrrrrro...........',
        '.....orrrrrrrrrrrrrrrro.........',
        '....orraarraarraarraarro........',
        '....oaaaaaaaaaaaaaaaaaao........',
        '...oyaayyaayyaayyaayyaayo.......',
        '...oyyyyyyooyyyyooyyyyyyo.......',
        '...oyyyyyoffoyyoffoyyyyyo.......',
        '...olyyloffffooffffolyylo.......',
        '...ollloffffffffffffolllo.......',
        '...ovllofooffffffoofollvo.......',
        '...ovvvofffoffffofffovvvo.......',
        '...obvvoffffffffffffovvbo.......',
        '...obbbofffffoofffffobbbo.......',
        '....obbooffffffffffoobbo........',
        '....occcooooooooooooccco........',
        '....ooccggggggggggggccoo........',
        '...oSSSSSggggggggggSSSSSo.......',
        '..oSSSHHHHHHHHHHHHHHHHHHK.......',
        '..oSSsHLLLLLLLLLLLLLLLLLK.......',
        '.oSSSoHLLLLLLLLLLLLLLLLLK.......',
        '.oSsSoHLLLLLLLkkLLLLLLLLK.......',
        '.oSSSoHLLLLLLLkLLLLLLLLLK.......',
        '.oSSsoHLLLLLLLLLLLLLLLLLK.......',
        '.oSoSHHLLLLLLLLLLLLLLLLLL.......',
        '.S.SKKKKKKKKKKKKKKKKKKKKKK......',
      ],
      eyes: {
        open: [[10, 17], [10, 18], [11, 18], [17, 17], [17, 18], [16, 18]],
        down: [[10, 18], [11, 18], [16, 18], [17, 18]],
        left: [[9, 17], [9, 18], [10, 18], [16, 17], [16, 18], [15, 18]],
        right: [[11, 17], [11, 18], [12, 18], [18, 17], [18, 18], [17, 18]],
        closed: [[9, 18], [10, 18], [11, 18], [16, 18], [17, 18], [18, 18]],
        wide: [[10, 17], [11, 17], [10, 18], [11, 18], [16, 17], [17, 17], [16, 18], [17, 18]],
      },
      hands: {
        rest: [[9, 23], [10, 23], [17, 23], [18, 23]],
        typeL: [[9, 22], [10, 22], [17, 23], [18, 23]],
        typeR: [[9, 23], [10, 23], [17, 22], [18, 22]],
        up: [[1, 14], [1, 15], [26, 10], [26, 11]],
      },
      hand: 'h',
      mouth: [[13, 20], [14, 20]],
      // two frames, shown alternately while typing
      sparks: [
        [[28, 13], [27, 14], [27, 16], [28, 16], [29, 15], [28, 19], [29, 19], [30, 18]],
        [[29, 12], [28, 13], [28, 16], [29, 16], [30, 15], [29, 19], [30, 19], [31, 18]],
      ],
    },
  }

  function svg(who, eyes, hands, mouth, spark = -1) {
    const ch = CHARACTERS[who] || CHARACTERS.junior
    const w = ch.w || W
    const h = ch.h || H
    const scale = ch.scale || SCALE
    const px = ch.base.map(r => r.split(''))
    for (const [x, y] of ch.hands[hands]) px[y][x] = ch.hand
    for (const [x, y] of ch.eyes[eyes]) px[y][x] = 'e'
    if (mouth) for (const [x, y] of ch.mouth) px[y][x] = 'm'
    if (spark >= 0 && ch.sparks) for (const [x, y] of ch.sparks[spark % ch.sparks.length]) px[y][x] = 'z'
    let rects = ''
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = px[y][x]
        if (k !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ch.colors[k]}"/>`
      }
    return `<svg width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`
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
    let who = 'junior'

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
        mouth = true
      }
      fig.innerHTML = svg(who, eyes, hands, mouth, mode === 'typing' ? Math.floor(frame / 2) : -1)
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

    /** Switch the avatar (setting "Avatar"). */
    function setCharacter(name) {
      who = CHARACTERS[name] ? name : 'junior'
      root.dataset.character = who
      const ch = CHARACTERS[who]
      root.style.setProperty('--fig-h', `${(ch.h || H) * (ch.scale || SCALE)}px`)
      draw()
    }

    draw()
    return { onChange, wake, say, setChatty, nap, setCharacter }
  }

  /** One frame as SVG, e.g. for previews. */
  const sprite = (who, eyes = 'open', hands = 'rest', mouth = false, spark = -1) => svg(who, eyes, hands, mouth, spark)

  return { create, sprite, characters: Object.keys(CHARACTERS) }
})()
