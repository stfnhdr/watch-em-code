'use strict'
// Opening a window, and finding out whether we are already running.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { HOST } = require('./config')

// ---------------------------------------------------------------------------
// Opening a window: if possible as its own app window (Chrome, Edge, Brave,
// Chromium in --app mode, no address bar or tabs), otherwise the default browser.

const exists = p => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function findAppBrowser() {
  if (process.platform === 'darwin') {
    const names = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')])
      for (const n of names) {
        const p = path.join(dir, n + '.app')
        if (exists(p)) return { mac: p }
      }
  } else if (process.platform === 'win32') {
    const env = process.env
    const candidates = [
      [env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'],
      [env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'],
      [env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
      [env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'],
      [env.ProgramFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ]
    for (const [base, rel] of candidates) {
      if (!base) continue
      const p = path.join(base, rel)
      if (exists(p)) return { exe: p }
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    for (const n of names)
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        const p = path.join(dir, n)
        if (exists(p)) return { exe: p }
      }
  }
  return null
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

function openWindow(url) {
  if (process.env.WHC_NO_OPEN) return
  const b = process.env.WHC_BROWSER === 'default' ? null : findAppBrowser()
  const args = [`--app=${url}`, '--window-size=1400,900']
  try {
    if (b && b.mac) {
      spawn('open', ['-na', b.mac, '--args', ...args], { stdio: 'ignore', detached: true }).unref()
      return
    }
    if (b && b.exe) {
      spawn(b.exe, args, { stdio: 'ignore', detached: true }).unref()
      return
    }
  } catch {}
  openBrowser(url)
}

/** Is Watch Him Code already running on this port? */
function isOurs(port) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: '/whc', timeout: 800 }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve(body.includes('watch-him-code')))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

module.exports = { findAppBrowser, openBrowser, openWindow, isOurs }
