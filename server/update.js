'use strict'
// Update check against GitHub releases. Installing is up to the Mac/Windows app.

const { VERSION } = require('./config')

// ---------------------------------------------------------------------------
// Update check: asks GitHub for the latest release now and then. Installing is
// up to the Mac/Windows app, and only when the user clicks.

// New repo name first; the old one still works (GitHub redirects renamed repos).
const RELEASES = [
  'https://api.github.com/repos/stfnhdr/watch-em-code/releases/latest',
  'https://api.github.com/repos/stfnhdr/watch-him-code/releases/latest',
]
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
const UPDATE_CHECK = process.env.WHC_UPDATE_CHECK !== '0'
let update = { checked: 0, latest: '', name: '', page: '', assets: {}, error: '' }

const parseVersion = v => (String(v).replace(/^v/, '').match(/\d+/g) || []).slice(0, 3).map(Number)
function newer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

async function checkUpdate() {
  if (!UPDATE_CHECK || typeof fetch !== 'function') return
  try {
    let res
    for (const url of RELEASES) {
      res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'watch-him-code' },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status !== 404) break
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const r = await res.json()
    const assets = {}
    for (const a of r.assets || []) {
      if (/macos\.zip$/i.test(a.name)) assets.mac = a.browser_download_url
      if (/windows\.zip$/i.test(a.name)) assets.windows = a.browser_download_url
    }
    update = { checked: Date.now(), latest: String(r.tag_name || '').replace(/^v/, ''), name: r.name || '', page: r.html_url || '', assets, error: '' }
  } catch (e) {
    update = { ...update, checked: Date.now(), error: e.message }
  }
}

function updateInfo() {
  return {
    current: VERSION,
    latest: update.latest,
    available: !!update.latest && newer(update.latest, VERSION),
    name: update.name,
    page: update.page,
    assets: update.assets,
    enabled: UPDATE_CHECK,
    error: update.error,
  }
}

/** "Check now" in the settings: ask GitHub right away (at most every 10 s). */
const refreshUpdate = () => (Date.now() - update.checked > 10000 ? checkUpdate() : Promise.resolve())

module.exports = { UPDATE_EVERY_MS, UPDATE_CHECK, checkUpdate, updateInfo, newer, refreshUpdate }
