'use strict'
// Live connections to the page (Server-Sent Events) and broadcasting to them.



// ---------------------------------------------------------------------------
// HTTP + Server-Sent Events

const clients = new Set() // { res, v }

function broadcast(v, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) if (c.v === v) c.res.write(msg)
}

module.exports = { clients, broadcast }
