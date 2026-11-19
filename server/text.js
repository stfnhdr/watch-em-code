'use strict'
// Text helpers: line endings, display paths, reading files as text.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { MAX_AFTER } = require('./config')

/**
 * One line-ending style everywhere: CRLF/CR -> LF, no BOM. Otherwise a file
 * whose working copy has CRLF (Windows, core.autocrlf, .gitattributes eol=crlf)
 * differs from git's LF version in every line, and the whole file would show
 * up as changed although only a few lines are.
 */
const normText = t => (typeof t === 'string' ? t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : t)
const normLine = l => String(l).replace(/\r$/, '')

function displayPath(file, cwd) {
  if (cwd) {
    const rel = path.relative(cwd, file)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  }
  const home = os.homedir()
  if (file.startsWith(home)) return '~' + file.slice(home.length).split(path.sep).join('/')
  return file.split(path.sep).join('/')
}

/** File content as text: undefined = missing, null = binary or too large. */
function readText(file) {
  let buf
  try {
    if (!fs.statSync(file).isFile()) return undefined
    buf = fs.readFileSync(file)
  } catch {
    return undefined
  }
  if (buf.length > MAX_AFTER || buf.includes(0)) return null
  return normText(buf.toString('utf8'))
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\n$/, '') === b.replace(/\n$/, '')

module.exports = { normText, normLine, displayPath, readText, same }
