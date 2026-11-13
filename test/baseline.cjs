'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { discover } = require('../lib/install.cjs')
const profile = require('../config/compatibility.json')
const { fileHash } = require('../lib/install.cjs')

function baseline () {
  const candidates = process.env.RUST_WATCHER_BASELINE ? [{ server: process.env.RUST_WATCHER_BASELINE }] : discover()
  for (const candidate of candidates) {
    const pkg = path.join(candidate.server, 'node_modules/@parcel/watcher')
    const original = path.join(pkg, '.rust-watcher-original-index.cjs')
    const file = fs.existsSync(original) ? original : path.join(pkg, 'index.js')
    try {
      if (fileHash(path.join(candidate.server, 'out/vs/platform/files/node/watcher/watcherMain.js')) !== profile.bundleSha256) continue
      if (fileHash(file) === profile.entrySha256) return { ...candidate, pkg, file, implementation: require(file), node: path.join(candidate.server, 'node') }
    } catch {}
  }
  return null
}

module.exports = baseline
