// Small, dependency-free syntax highlighter. Deliberately simple:
// recognises comments, strings, numbers, keywords, functions, types
// and HTML tags. State (block comment) is carried across lines.
'use strict'

const Highlight = (() => {
  const KEYWORDS = new Set(
    (
      'abstract and as async await break case catch class const continue def default defer del delete do elif else enum ' +
      'export extends false final finally fn for from func function go if impl implements import in instanceof interface ' +
      'is let loop match mod module mut new nil none not null of or package pass private protected pub public raise ' +
      'readonly return self static struct super switch this throw throws trait true try type typeof undefined union unsafe ' +
      'use var void where while with yield lambda global nonlocal None True False then fi done esac local echo export ' +
      'select from where insert update into values create table'
    ).split(' '),
  )

  const LANG = {
    js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c', mts: 'c', cts: 'c', java: 'c', kt: 'c', kts: 'c',
    swift: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', php: 'c', dart: 'c',
    scala: 'c', css: 'css', scss: 'css', less: 'css', json: 'json', jsonc: 'c',
    py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', fish: 'hash', ps1: 'hash', yml: 'hash', yaml: 'hash',
    toml: 'hash', ini: 'hash', env: 'hash', r: 'hash', pl: 'hash', dockerfile: 'hash', makefile: 'hash',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
    sql: 'sql', lua: 'sql', md: 'text', txt: 'text', ipynb: 'hash',
  }

  function langOf(file) {
    const base = file.split(/[\\/]/).pop().toLowerCase()
    if (base === 'dockerfile' || base === 'makefile') return LANG[base]
    const ext = base.includes('.') ? base.split('.').pop() : ''
    return LANG[ext] || 'c'
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`

  const STRING = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/y
  const NUMBER = /(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y
  const IDENT = /[A-Za-z_$][\w$]*/y
  const SPACE = /\s+/y

  function at(re, s, i) {
    re.lastIndex = i
    const m = re.exec(s)
    return m ? m[0] : null
  }

  /** state: { block: null | '*\/' | '-->' }  is mutated */
  function line(text, lang, state) {
    if (lang === 'text') return esc(text)
    let out = ''
    let i = 0
    const n = text.length
    const lineComment = lang === 'hash' ? '#' : lang === 'sql' ? '--' : lang === 'c' || lang === 'css' ? '//' : null

    while (i < n) {
      // Block comment still open
      if (state.block) {
        const end = text.indexOf(state.block, i)
        if (end < 0) {
          out += span('c', text.slice(i))
          return out
        }
        out += span('c', text.slice(i, end + state.block.length))
        i = end + state.block.length
        state.block = null
        continue
      }

      const rest = text.slice(i)
      const ch = text[i]

      // '#' only starts a comment when it isn't in the middle of a word
      if (lineComment && rest.startsWith(lineComment) && !(lineComment === '#' && i > 0 && /[\w$]/.test(text[i - 1]))) {
        out += span('c', rest)
        return out
      }
      if ((lang === 'c' || lang === 'css') && rest.startsWith('/*')) {
        state.block = '*/'
        out += span('c', '/*')
        i += 2
        continue
      }
      if (lang === 'html' && rest.startsWith('<!--')) {
        state.block = '-->'
        out += span('c', '<!--')
        i += 4
        continue
      }
      if (lang === 'html' && ch === '<') {
        const m = /^<\/?[A-Za-z][\w:.-]*/.exec(rest)
        if (m) {
          out += span('p', m[0][1] === '/' ? '</' : '<') + span('tag', m[0].replace(/^<\/?/, ''))
          i += m[0].length
          continue
        }
      }

      const sp = at(SPACE, text, i)
      if (sp) {
        out += sp
        i += sp.length
        continue
      }

      if (ch === '"' || ch === "'" || (ch === '`' && lang !== 'hash')) {
        const s = at(STRING, text, i)
        if (s) {
          // colour JSON keys slightly differently
          const isKey = lang === 'json' && /^\s*:/.test(text.slice(i + s.length))
          out += span(isKey ? 'attr' : 's', s)
          i += s.length
          continue
        }
      }

      if (/\d/.test(ch) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
        const num = at(NUMBER, text, i)
        if (num) {
          out += span('n', num)
          i += num.length
          continue
        }
      }

      const id = at(IDENT, text, i)
      if (id) {
        const after = text.slice(i + id.length)
        let cls = null
        if (lang === 'html' && /^\s*=/.test(after)) cls = 'attr'
        else if (lang === 'css' && /^\s*:/.test(after) && !/[{]/.test(after)) cls = 'attr'
        else if (KEYWORDS.has(id) || (lang === 'sql' && KEYWORDS.has(id.toLowerCase()))) cls = 'k'
        else if (/^\s*\(/.test(after)) cls = 'f'
        else if (/^[A-Z][a-z0-9]/.test(id)) cls = 't'
        out += cls ? span(cls, id) : esc(id)
        i += id.length
        continue
      }

      out += /[{}()[\];,.:=<>+\-*/!?&|%^~@]/.test(ch) ? span('p', ch) : esc(ch)
      i++
    }
    return out
  }

  return { line, langOf, esc }
})()
