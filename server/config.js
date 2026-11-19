'use strict'
// Constants, paths and settings from environment variables.

const os = require('os')
const path = require('path')

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PROJECTS = path.join(CLAUDE_DIR, 'projects')
const HOST = '127.0.0.1'
const START_PORT = Number(process.env.WHC_PORT) || 4777
const POLL_MS = 600 // read new lines
const SCAN_MS = 2000 // look for sessions
const ACTIVE_MS = 60 * 60 * 1000 // a session counts as active for this long (tabs auto-close after it)
const MAX_SESSIONS = 6
const MAX_AFTER = 2 * 1024 * 1024 // larger files only as diff
const PUBLIC = path.join(__dirname, '..', 'public')
const DATA_DIR = path.join(os.homedir(), '.watch-em-code') // our own small state (watched folders)
// The Mac/Windows app passes its own version; this is the fallback for `node server.js`.
// When releasing, bump it together with app/macos/Info.plist and app/windows/WatchEmCode.csproj.
const VERSION = process.env.WHC_APP_VERSION || '0.4.1'

module.exports = { CLAUDE_DIR, PROJECTS, HOST, START_PORT, POLL_MS, SCAN_MS, ACTIVE_MS, MAX_SESSIONS, MAX_AFTER, PUBLIC, DATA_DIR, VERSION }
