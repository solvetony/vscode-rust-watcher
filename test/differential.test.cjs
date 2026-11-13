'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { fixture, watch, delay, state } = require('./helpers.cjs')
const baseline = require('./baseline.cjs')()
const rust = require('../lib/adapter.cjs')

test('actual Parcel CJS and default/named ESM loading contract', { skip: !baseline }, async () => {
  const namespace = await import(require('node:url').pathToFileURL(baseline.file).href)
  for (const key of ['subscribe', 'unsubscribe', 'writeSnapshot', 'getEventsSince']) {
    assert.equal(typeof baseline.implementation[key], 'function')
    assert.equal(namespace.default[key], baseline.implementation[key])
    assert.equal(namespace[key], baseline.implementation[key])
  }
})

test('rename, atomic-save and coalescing match installed Parcel', { skip: !baseline }, async t => {
  async function run (implementation) {
    const root = await fixture(t)
    await fs.writeFile(path.join(root, 'old'), 'one')
    const observed = await watch(t, root, { backend: 'inotify' }, implementation)
    await fs.rename(path.join(root, 'old'), path.join(root, 'new'))
    await observed.expect('old', 'delete')
    await observed.expect('new', 'create')
    await fs.writeFile(path.join(root, 'atomic-temp'), 'replacement')
    await fs.rename(path.join(root, 'atomic-temp'), path.join(root, 'new'))
    await delay(150)
    await fs.writeFile(path.join(root, 'transient'), '')
    await fs.unlink(path.join(root, 'transient'))
    await delay(150)
    await observed.subscription.unsubscribe()
    return observed.events.filter(e => !e.path.endsWith('/atomic-temp')).map(e => `${e.type}:${path.relative(root, e.path)}`).sort()
  }
  assert.deepEqual(await run(rust), await run(baseline.implementation))
})

test('ignore paths, relative/absolute globs, dotfiles, classes and extglobs match Parcel', { skip: !baseline }, async t => {
  const patterns = ['**/node_modules/**', '**/.git/objects/**', '**/{dist,build}/**', '**/[ab]?.js', '**/@(foo|bar)/**', '**/+(foo|bar)/**', 'literal', '/absolute/**', '**/.cache/**']
  async function run (implementation, ignore) {
    const root = await fixture(t)
    const names = ['node_modules/pkg/file', '.git/objects/ab/file', '.git/keep', 'dist/file', 'build/file', 'aa.js', 'bc.js', 'foo/file', 'foobar/file', 'bar/file', 'literal/file', 'literal-other/file', '.cache/file', '.visible', 'visible']
    for (const name of names) await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    const observed = await watch(t, root, { ignore, backend: 'inotify' }, implementation)
    for (const name of names) {
      await fs.writeFile(path.join(root, name), 'x')
    }
    await observed.expect('visible', 'create')
    await delay(100)
    await observed.subscription.unsubscribe()
    return observed.events.filter(e => e.type === 'create').map(e => path.relative(root, e.path)).sort()
  }
  assert.deepEqual(await run(rust, patterns), await run(baseline.implementation, patterns))
})

test('Rust snapshots are safely readable by stock Parcel in another process', { skip: !baseline }, async t => {
  const root = await fixture(t)
  const snapshot = path.join(state, 'transition-snapshot')
  await fs.writeFile(path.join(root, 'deleted'), 'one')
  await fs.writeFile(path.join(root, 'modified'), 'one')
  await rust.writeSnapshot(root, snapshot, { backend: 'inotify' })
  await fs.unlink(path.join(root, 'deleted'))
  await fs.appendFile(path.join(root, 'modified'), 'two')
  await fs.writeFile(path.join(root, 'created'), 'one')
  const script = 'require(process.argv[1]).getEventsSince(process.argv[2],process.argv[3],{backend:\'inotify\'}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1})'
  const events = JSON.parse(execFileSync(baseline.node, ['-e', script, baseline.file, root, snapshot], { encoding: 'utf8', timeout: 10000 }))
  for (const [name, type] of [['deleted', 'delete'], ['modified', 'update'], ['created', 'create']]) assert(events.some(e => e.path === path.join(root, name) && e.type === type), `${name}: ${JSON.stringify(events)}`)
})

test('VS Code polling order rewrites stock snapshots before the first Rust query', { skip: !baseline }, async t => {
  const root = await fixture(t)
  const snapshot = path.join(state, 'stock-snapshot')
  await fs.writeFile(path.join(root, 'file'), 'one')
  await baseline.implementation.writeSnapshot(root, snapshot, { backend: 'inotify' })
  await assert.rejects(rust.getEventsSince(root, snapshot), /incompatible snapshot/)
  let iteration = 0
  async function poll () {
    iteration++
    let events = []
    if (iteration > 1) events = await rust.getEventsSince(root, snapshot, { backend: 'inotify' })
    await rust.writeSnapshot(root, snapshot, { backend: 'inotify' })
    return events
  }
  assert.deepEqual(await poll(), [])
  await fs.appendFile(path.join(root, 'file'), 'two')
  assert((await poll()).some(e => e.path === path.join(root, 'file') && e.type === 'update'))
})
