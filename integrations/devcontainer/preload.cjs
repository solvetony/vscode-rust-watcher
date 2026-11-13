'use strict'

const path = require('node:path')
const { isMainThread } = require('node:worker_threads')

const main = process.argv[1]
const startup = main && (path.basename(main) === 'server-main.js' || (['bootstrap-fork', 'bootstrap-fork.js'].includes(path.basename(main)) && process.argv.includes('--type=fileWatcher')))
if (isMainThread && startup && process.env.RUST_WATCHER_DISABLE !== '1') {
  let installer
  let server
  try {
    const fs = require('node:fs')
    server = path.dirname(process.execPath)
    if (fs.realpathSync(path.dirname(path.dirname(main))) === server && fs.existsSync(path.join(server, 'node_modules/@parcel/watcher/package.json'))) {
      installer = require('../../lib/install.cjs')
      if (installer.imageAuto()) {
        const marker = installer.read(path.join(require('../../lib/diagnostics.cjs').state, 'auto.json'))
        installer.install(server, marker.config, false, true)
        console.error('[rust-watcher] Image package installed before VS Code module loading.')
      }
    }
  } catch (error) {
    if (installer && server) {
      try { installer.retainStock(server) } catch (failure) { console.error(`[rust-watcher] Stock restoration unavailable: ${failure.message}`) }
    }
    console.error(`[rust-watcher] Startup activation unavailable: ${error.message}. No automatic reload.`)
  }
}
