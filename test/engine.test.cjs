'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { fixture, eventually, watch, delay } = require('./helpers.cjs')
const watcher = require('../lib/adapter.cjs')

test('create, edit, atomic save, rename, delete, Unicode and dotfiles', async t => {
  const root = await fixture(t)
  const observed = await watch(t, root)
  await fs.writeFile(path.join(root, '.日本語-😀'), 'one')
  await observed.expect('.日本語-😀', 'create')
  await fs.appendFile(path.join(root, '.日本語-😀'), 'two')
  await observed.expect('.日本語-😀', 'update')
  observed.events.length = 0
  await fs.writeFile(path.join(root, 'temporary'), 'replacement')
  await fs.rename(path.join(root, 'temporary'), path.join(root, '.日本語-😀'))
  await observed.expect('.日本語-😀', 'create')
  await fs.rename(path.join(root, '.日本語-😀'), path.join(root, 'renamed'))
  await observed.expect('.日本語-😀', 'delete')
  await observed.expect('renamed', 'create')
  await fs.unlink(path.join(root, 'renamed'))
  await observed.expect('renamed', 'delete')
})

test('nested creation, populated moves, directory renames and continued paths', async t => {
  const outer = await fixture(t)
  const root = path.join(outer, 'root')
  const moved = path.join(outer, 'staging')
  await fs.mkdir(root)
  await fs.mkdir(path.join(moved, 'nested'), { recursive: true })
  await fs.writeFile(path.join(moved, 'nested/file'), 'one')
  const observed = await watch(t, root)
  await fs.rename(moved, path.join(root, 'arrived'))
  await observed.expect('arrived/nested/file', 'create')
  await fs.rename(path.join(root, 'arrived'), path.join(root, 'renamed'))
  await observed.expect('arrived/nested/file', 'delete')
  await observed.expect('renamed/nested/file', 'create')
  await fs.appendFile(path.join(root, 'renamed/nested/file'), 'two')
  await observed.expect('renamed/nested/file', 'update')
  await fs.mkdir(path.join(root, 'new/deep'), { recursive: true })
  await fs.writeFile(path.join(root, 'new/deep/file'), 'x')
  await observed.expect('new/deep/file', 'create')
})

test('requested root deletion and recreation', async t => {
  const parent = await fixture(t)
  const root = path.join(parent, 'root')
  await fs.mkdir(root)
  const observed = await watch(t, root)
  await fs.rm(root, { recursive: true })
  await eventually(() => observed.events.some(e => e.path === root && e.type === 'delete'))
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'back'), 'x')
  await observed.expect('back', 'create')
})

test('shared watches survive one subscriber leaving and filters remain independent', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'child'))
  const a = await watch(t, root, { ignore: ['**/hidden/**'] })
  const count = watcher.diagnostics().activeWatches
  const b = await watch(t, root, { ignore: ['**/child/**'] })
  assert.equal(watcher.diagnostics().activeWatches, count)
  await a.subscription.unsubscribe()
  await fs.mkdir(path.join(root, 'hidden'))
  await fs.writeFile(path.join(root, 'hidden/file'), 'x')
  await b.expect('hidden/file', 'create')
  await fs.writeFile(path.join(root, 'child/file'), 'x')
  await delay(100)
  assert(!b.events.some(e => e.path.includes('/child/')))
})

test('unsubscribe during initialization, repeated unsubscribe and self-unsubscribe', async t => {
  const root = await fixture(t)
  await Promise.all(Array.from({ length: 200 }, (_, i) => fs.mkdir(path.join(root, String(i)))))
  let calls = 0
  const callback = () => { calls++ }
  const pending = watcher.subscribe(root, callback)
  await watcher.unsubscribe(root, callback)
  const cancelled = await pending
  await cancelled.unsubscribe()
  await cancelled.unsubscribe()
  let stopped = false
  const subscription = await watcher.subscribe(root, async () => { await subscription.unsubscribe(); stopped = true })
  await fs.writeFile(path.join(root, 'first'), 'x')
  await eventually(() => stopped)
  await fs.writeFile(path.join(root, 'after'), 'x')
  await delay(100)
  assert.equal(calls, 0)
  assert.equal(watcher.diagnostics().activeWatches, 0)
})

test('symlinks and cycles are entries, never traversed', async t => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await fs.symlink(outside, path.join(root, 'outside'))
  await fs.symlink(root, path.join(root, 'cycle'))
  const observed = await watch(t, root)
  assert.equal(watcher.diagnostics().visitedDirectories, 1)
  await fs.writeFile(path.join(outside, 'secret'), 'x')
  await fs.writeFile(path.join(root, 'visible'), 'x')
  await observed.expect('visible', 'create')
  assert(!observed.events.some(e => e.path.includes('secret')))
})

test('fast child churn does not fail initialization or restart scans', async t => {
  const root = await fixture(t)
  const observed = await watch(t, root)
  for (let i = 0; i < 100; i++) {
    const dir = path.join(root, `churn-${i}`)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'file'), 'x')
    await fs.rm(dir, { recursive: true })
  }
  await fs.writeFile(path.join(root, 'final'), 'x')
  await observed.expect('final', 'create')
  assert.equal(observed.errors.length, 0)
  assert.equal(watcher.diagnostics().rescans, 0)
})

test('kernel-overflow recovery reconciles final state including deletes', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'old'), 'x')
  const observed = await watch(t, root)
  await fs.unlink(path.join(root, 'old'))
  await fs.writeFile(path.join(root, 'new'), 'x')
  watcher.reconcile()
  await observed.expect('old', 'delete')
  await observed.expect('new', 'create')
  assert(watcher.diagnostics().rescans >= 1)
})

test('active worker environments terminate without deadlock', async t => {
  const root = await fixture(t)
  for (let i = 0; i < 8; i++) {
    const worker = new Worker('const { parentPort, workerData } = require(\'node:worker_threads\'); require(workerData.module).subscribe(workerData.root, () => {}).then(() => parentPort.postMessage(\'ready\'))', { eval: true, workerData: { root, module: require.resolve('../lib/adapter.cjs') } })
    await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    await worker.terminate()
  }
})

test('rapid startup/shutdown cannot lose the shutdown wakeup', async t => {
  const root = await fixture(t)
  const descriptors = (await fs.readdir('/proc/self/fd')).length
  for (let i = 0; i < 300; i++) {
    const subscription = await watcher.subscribe(root, () => {})
    await subscription.unsubscribe()
  }
  assert.equal(watcher.diagnostics().activeWatches, 0)
  assert((await fs.readdir('/proc/self/fd')).length <= descriptors + 4, 'native descriptors must be released before JS garbage collection')
})

test('worker teardown cancels startup and snapshot work under queued events', async t => {
  const root = await fixture(t)
  for (let i = 0; i < 500; i++) await fs.mkdir(path.join(root, String(i)))
  const worker = new Worker('const {parentPort,workerData}=require(\'node:worker_threads\');(async()=>{const policy=require(workerData.policy);const spec=await policy.specification(workerData.root,{},policy.validate({}));global.engine=new (require(workerData.native).Engine)(()=>{});engine.start(1,JSON.stringify(spec));engine.snapshot(JSON.stringify(spec),workerData.snapshot,true).catch(()=>{});parentPort.postMessage(\'started\')})()', { eval: true, workerData: { root, policy: require.resolve('../lib/policy.cjs'), native: require.resolve('../dist/rust_file_watcher.node'), snapshot: path.join(root, 'cancelled.snapshot') } })
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  await Promise.all(Array.from({ length: 30 }, (_, i) => fs.writeFile(path.join(root, String(i), 'file'), 'x')))
  await worker.terminate()
})

test('missing root, file root, permission failure, malformed options and non-UTF-8 names', async t => {
  const root = await fixture(t)
  await assert.rejects(watcher.subscribe(path.join(root, 'absent'), () => {}), /requested root/)
  await fs.writeFile(path.join(root, 'file'), '')
  await assert.rejects(watcher.subscribe(path.join(root, 'file'), () => {}), /not a directory/)
  for (const options of [null, { ignore: 'x' }, { ignore: [42] }, { backend: 'brute-force' }, { backend: 'watchman' }, { unknown: true }]) await assert.rejects(watcher.subscribe(root, () => {}, options))
  await fs.mkdir(path.join(root, 'denied'), { mode: 0 })
  t.after(() => fs.chmod(path.join(root, 'denied'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await assert.rejects(watcher.subscribe(root, () => {}), /Permission denied/)
  await fs.chmod(path.join(root, 'denied'), 0o700)
  const observed = await watch(t, root)
  await fs.writeFile(Buffer.concat([Buffer.from(root + '/'), Buffer.from([255])]), '')
  await eventually(() => observed.errors.length > 0)
  assert.match(observed.errors[0].message, /non-UTF-8/)
})
