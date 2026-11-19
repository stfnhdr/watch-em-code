'use strict'
// The logo as its own pixel graphic: custom 5×7 letters (straight T),
// with a 1px outline and a hard drop shadow underneath. Colours come from CSS
// (--logo-fill, --logo-edge, --logo-drop) so light and dark can differ.

const PixelLogo = (() => {
  const GLYPHS = {
    W: ['1...1', '1...1', '1...1', '1.1.1', '1.1.1', '11.11', '1...1'],
    A: ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
    T: ['11111', '..1..', '..1..', '..1..', '..1..', '..1..', '..1..'],
    C: ['.1111', '1....', '1....', '1....', '1....', '1....', '.1111'],
    H: ['1...1', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
    I: ['111', '.1.', '.1.', '.1.', '.1.', '.1.', '111'],
    M: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
    O: ['.111.', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
    D: ['1111.', '1...1', '1...1', '1...1', '1...1', '1...1', '1111.'],
    E: ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
  }

  /** cell: size of one letter pixel, edge: outline width, drop: shadow offset (all in px) */
  function svg(text, { cell = 3, edge = 1, drop = 2 } = {}) {
    const cells = []
    let x = 0
    for (const ch of text.toUpperCase()) {
      if (ch === ' ') {
        x += 3
        continue
      }
      const g = GLYPHS[ch]
      if (!g) continue
      g.forEach((row, y) => [...row].forEach((p, cx) => p === '1' && cells.push([x + cx, y])))
      x += g[0].length + 1
    }
    const width = (x - 1) * cell + 2 * edge + drop
    const height = 7 * cell + 2 * edge + drop
    const rect = (cx, cy, grow, off, cls) =>
      `<rect class="${cls}" x="${cx * cell + edge - grow + off}" y="${cy * cell + edge - grow + off}" width="${cell + 2 * grow}" height="${cell + 2 * grow}"/>`
    const layer = (grow, off, cls) => cells.map(([a, b]) => rect(a, b, grow, off, cls)).join('')
    return (
      `<svg class="pixel-logo" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-label="${text}">` +
      (drop ? layer(edge, drop, 'lo-drop') : '') +
      (edge ? layer(edge, 0, 'lo-edge') : '') +
      layer(0, 0, 'lo-fill') +
      `</svg>`
    )
  }

  return { svg }
})()
