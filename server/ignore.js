'use strict'
// Folders and files nobody wants to watch: dependencies, build output, tool
// caches, editor state and temp files. Used for watched folders – on top of
// .gitignore inside git repos.

const { SKIP_DIRS } = require('./git')

const IGNORE_DIRS = new Set([
  ...SKIP_DIRS,
  '.git', '.hg', '.svn', '.idea', '.vs', '.vscode', '__pycache__', '.next', '.nuxt', '.cache', '.turbo',
  '.parcel-cache', 'coverage', '.pytest_cache', '.mypy_cache', '.gradle', '.terraform',
])
const IGNORE_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|4913|\.#.*)$|(~|\.sw[pox]|\.tmp|\.temp|\.crdownload|\.part|\.orig)$/i

/** Is this path (relative, / or \ separated) something to leave out? */
function ignored(rel) {
  const parts = String(rel).split(/[\\/]/)
  return IGNORE_FILES.test(parts[parts.length - 1]) || parts.slice(0, -1).some(p => IGNORE_DIRS.has(p))
}

module.exports = { IGNORE_DIRS, IGNORE_FILES, ignored }
