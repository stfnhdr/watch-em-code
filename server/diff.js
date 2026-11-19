'use strict'
// Line diffs and patches, in the same hunk format as Claude Code's structuredPatch.



/** Applies a structuredPatch to the old content. */
function applyPatch(original, hunks) {
  const src = original.split('\n')
  const out = []
  let i = 0 // index into src
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1 + (h.oldLines === 0 ? 1 : 0))
    if (start < i) return null // hunks unsorted or overlapping
    while (i < start && i < src.length) out.push(src[i++])
    for (const l of h.lines) {
      if (l[0] === '+') out.push(l.slice(1))
      else if (l[0] === ' ') {
        out.push(l.slice(1))
        i++
      } else if (l[0] === '-') i++
    }
  }
  while (i < src.length) out.push(src[i++])
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Line diff, for changes found through git (those have no patch in the log).
// Returns hunks in the same format as Claude Code's structuredPatch.

const toLines = t => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))

function lcsOps(A, B) {
  const n = A.length
  const m = B.length
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push([' ', A[i++]])
      j++
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(['-', A[i++]])
    else ops.push(['+', B[j++]])
  }
  while (i < n) ops.push(['-', A[i++]])
  while (j < m) ops.push(['+', B[j++]])
  return ops
}

function lineDiff(before, after, ctx = 3) {
  const a = toLines(before)
  const b = toLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  // Very large middle parts: show as replaced block instead of an expensive LCS.
  const mid = A.length * B.length > 4e6 ? [...A.map(l => ['-', l]), ...B.map(l => ['+', l])] : lcsOps(A, B)
  const ops = [...a.slice(0, pre).map(l => [' ', l]), ...mid, ...a.slice(a.length - suf).map(l => [' ', l])]

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
    hunks.push({
      oldStart: ol ? oldNo[from] : oldNo[from] - 1,
      oldLines: ol,
      newStart: nl ? newNo[from] : newNo[from] - 1,
      newLines: nl,
      lines,
    })
  }
  return hunks
}

module.exports = { applyPatch, lineDiff, toLines, lcsOps }
