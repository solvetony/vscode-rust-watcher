'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { setTimeout: delay } = require('node:timers/promises')
const policy = require('../lib/policy.cjs')

async function main () {
  const [module, config] = process.argv.slice(2)
  const settings = policy.load(config)
  const base = settings.scope.mode === 'restricted' ? settings.scope.allowedRoots[0] : os.tmpdir()
  const fixture = await fs.mkdtemp(path.join(base, '.rust-watcher-verify-'))
  const snapshot = path.join(fixture, 'snapshot')
  let subscription
  try {
    const cjs = require(module)
    if (module.endsWith('/index.js')) assert.equal(require(path.dirname(module)), cjs)
    const esm = await import(pathToFileURL(module).href)
    assert((await fs.readFile('/proc/self/maps', 'utf8')).includes('/rust_file_watcher.node'), 'Rust addon must be mapped; fallback is not a successful verification')
    if (module.endsWith('/index.js')) {
      const diagnostics = require('../lib/diagnostics.cjs')
      const healthDirectory = path.join(diagnostics.state, 'health')
      const name = (await fs.readdir(healthDirectory)).find(name => name.startsWith(`${process.pid}-${diagnostics.startIdentity()}-`))
      assert(name, 'missing initialization health record')
      const record = JSON.parse(await fs.readFile(path.join(healthDirectory, name), 'utf8'))
      assert.equal(record.backend, 'rust', 'fallback is degraded, not healthy Rust operation')
    }
    for (const name of ['subscribe', 'unsubscribe', 'writeSnapshot', 'getEventsSince']) {
      assert.equal(typeof cjs[name], 'function')
      assert.equal(esm.default[name], cjs[name])
      if (module.endsWith('/index.js')) assert.equal(esm[name], cjs[name])
    }
    const ignoredCheck = await cjs.subscribe(fixture, () => { throw new Error('fully excluded preflight emitted events') }, { backend: 'inotify', ignore: [...JSON.parse(process.env.RUST_WATCHER_PREFLIGHT_IGNORES || '[]'), '**'] })
    await ignoredCheck.unsubscribe()
    const events = []
    let callbackError
    subscription = await esm.default.subscribe(fixture, (error, batch) => { callbackError ||= error; events.push(...batch) }, { backend: 'inotify' })
    const a = path.join(fixture, 'a')
    const b = path.join(fixture, 'b')
    async function expect (file, type) {
      for (let i = 0; i < 100; i++) {
        if (callbackError) throw callbackError
        if (events.some(event => event.path === file && event.type === type)) return
        await delay(20)
      }
      throw new Error(`smoke failed: missing ${type} ${file}`)
    }
    await fs.writeFile(a, 'one')
    await expect(a, 'create')
    await fs.appendFile(a, 'two')
    await expect(a, 'update')
    await esm.default.writeSnapshot(fixture, snapshot, { backend: 'inotify' })
    await fs.rename(a, b)
    await expect(a, 'delete')
    await expect(b, 'create')
    const diff = await esm.default.getEventsSince(fixture, snapshot, { backend: 'inotify' })
    assert(diff.some(e => e.path === a && e.type === 'delete'))
    assert(diff.some(e => e.path === b && e.type === 'create'))
    await fs.unlink(b)
    await expect(b, 'delete')
    await subscription.unsubscribe()
    subscription = undefined
    console.log('CJS + default/named ESM; create/update/rename/delete; snapshot round trip: PASS')
  } finally {
    if (subscription) await subscription.unsubscribe()
    await fs.rm(fixture, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
