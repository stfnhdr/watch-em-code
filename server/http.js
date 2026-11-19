'use strict'
// HTTP server: the page, its files, the live connection and a few small endpoints.

const fs = require('fs')
const path = require('path')
const http = require('http')
const { PUBLIC } = require('./config')
const { clients } = require('./bus')
const { snapshotV2, snapshotV1 } = require('./sessions')
const { sessionList, listSessionFiles, pinned, scan } = require('./claude')
const { refreshUpdate, updateInfo } = require('./update')
const { statusReport } = require('./status')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/whc') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"watch-him-code"}')
    return
  }

  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(sessionList()))
    return
  }

  // Open (pin) or close (unpin) a session tab. Ids are checked against the logs on disk.
  if (url.pathname === '/open' || url.pathname === '/close') {
    const id = url.searchParams.get('id') || ''
    const known = /^[\w-]{1,100}$/.test(id) && listSessionFiles().some(f => f.id === id)
    if (!known) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false}')
      return
    }
    if (url.pathname === '/open') pinned.add(id)
    else pinned.delete(id)
    scan()
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
    return
  }

  // "Check now" in the settings: ask GitHub right away (at most every 10 s)
  if (url.pathname === '/check-update') {
    const run = refreshUpdate()
    run.then(() => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(updateInfo())))
    return
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(statusReport()))
    return
  }

  if (url.pathname === '/events') {
    const v = url.searchParams.get('v') === '2' ? 2 : 1
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`event: reset\ndata: ${JSON.stringify(v === 2 ? snapshotV2() : snapshotV1())}\n\n`)
    const client = { res, v }
    clients.add(client)
    req.on('close', () => clients.delete(client))
    return
  }

  // Frozen views live as subfolders in public/ (e.g. /base/).
  if (/^\/[\w-]+$/.test(url.pathname) && fs.existsSync(path.join(PUBLIC, url.pathname, 'index.html'))) {
    res.writeHead(301, { Location: url.pathname + '/' }).end()
    return
  }
  let name = url.pathname.slice(1)
  if (name === '' || name.endsWith('/')) name += 'index.html'
  const file = path.join(PUBLIC, path.normalize(name))
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end()
    return
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })
})

// Keeps the connections open.
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n')
}, 20000).unref()

module.exports = { server }
