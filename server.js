#!/usr/bin/env node
// Watch 'Em Code – shows the code changes of running Claude Code sessions live.
// No dependencies, Node built-ins only. The code lives in server/:
//
//   config.js      constants, paths, environment variables
//   text.js        text helpers (line endings, display paths, reading files)
//   diff.js        line diffs and patches
//   bus.js         live connections to the page (Server-Sent Events)
//   repos.js       git repos and branches (from .git/HEAD)
//   git.js         asking git: file versions, nested repos
//   sessions.js    watched sessions and their changes, from any source
//   claude.js      source: Claude Code session logs
//   shellwatch.js  git fallback for edits made through the shell
//   update.js      update check against GitHub releases
//   status.js      status check
//   http.js        HTTP server and endpoints
//   window.js      opening a window, single-instance check
//   main.js        start-up
'use strict'

const { START_PORT } = require('./server/config')

if (require.main === module) require('./server/main').listen(START_PORT)
else module.exports = { ...require('./server/diff'), toChange: require('./server/claude').toChange }
