'use strict'
// Start-up: listen on a free port, start the watchers and timers, open a window.

const { HOST, START_PORT, POLL_MS, SCAN_MS } = require('./config')
const { server } = require('./http')
const { openWindow, isOurs } = require('./window')
const { scan, poll } = require('./claude')
const { checkGit } = require('./git')
const { checkUpdate, UPDATE_EVERY_MS } = require('./update')
const { gitFallbackTick } = require('./shellwatch')
const { loadFolders } = require('./folders')

function listen(port) {
  server.once('error', async err => {
    if (err.code !== 'EADDRINUSE') throw err
    if (await isOurs(port)) {
      // Already running: just open a window, no second server.
      const url = `http://${HOST}:${port}`
      console.log(`Watch 'Em Code is already running at ${url} – opening a window only.`)
      openWindow(url)
      setTimeout(() => process.exit(0), 300)
    } else if (port < START_PORT + 20) listen(port + 1)
    else throw err
  })
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`
    console.log(`Watch 'Em Code is running at ${url}  (stop with Ctrl+C)`)
    // Read the session logs a moment later: the window first gets the page
    // (instantly), the data follows over the live connection.
    setTimeout(() => {
      scan()
      loadFolders() // folders watched before the restart
      setInterval(poll, POLL_MS)
      setInterval(scan, SCAN_MS)
    }, 250)
    checkGit()
    setTimeout(checkUpdate, 5000).unref()
    setInterval(checkUpdate, UPDATE_EVERY_MS).unref()
    setInterval(gitFallbackTick, 1000)
    // Started by the Mac/Windows app: exit together with it
    const parent = Number(process.env.WHC_PARENT_PID) || 0
    if (parent)
      setInterval(() => {
        try {
          process.kill(parent, 0)
        } catch {
          process.exit(0)
        }
      }, 3000)
    openWindow(url)
  })
}

module.exports = { listen }
