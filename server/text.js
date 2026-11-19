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

const bufText = buf => (buf.length > MAX_AFTER || buf.includes(0) ? null : normText(buf.toString('utf8')))

/** File content as text: undefined = missing, null = binary or too large. */
function readText(file) {
  let buf
  try {
    if (!fs.statSync(file).isFile()) return undefined
    buf = fs.readFileSync(file)
  } catch {
    return undefined
  }
  return bufText(buf)
}

/** Like readText, without blocking the server (for reading many files). */
async function readTextAsync(file) {
  let buf
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) return undefined
    if (st.size > MAX_AFTER) return null
    buf = await fs.promises.readFile(file)
  } catch {
    return undefined
  }
  return bufText(buf)
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\n$/, '') === b.replace(/\n$/, '')

module.exports = { normText, normLine, displayPath, readText, readTextAsync, same }
