'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { fixture, state } = require('./helpers.cjs')
const policy = require('../lib/policy.cjs')

test('tracking limit is validated and passed to the native specification', async t => {
  const root = await fixture(t)
  assert.equal(policy.validate({}).maxTrackedEntries, 1000000)
  for (const value of [0, -1, 1.5, 10000001, '3000000']) assert.throws(() => policy.validate({ maxTrackedEntries: value }), /maxTrackedEntries/)
  const spec = await policy.specification(root, {}, policy.validate({ maxTrackedEntries: 3000000 }))
  assert.equal(spec.maxTrackedEntries, 3000000)
})

test('depth-first traversal fits the exact entry limit and bounds pending directory iterators', async t => {
  const root = await fixture(t)
  for (let i = 0; i < 128; i++) {
    await fs.mkdir(path.join(root, String(i)))
    await fs.writeFile(path.join(root, String(i), 'file'), 'x')
  }
  const config = path.join(state, 'exact-limit.json')
  await fs.writeFile(config, JSON.stringify({ maxTrackedEntries: 257, logLevel: 'silent' }))
  const script = 'const w=require(process.argv[1]),assert=require(\'assert/strict\');const delay=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{const root=process.argv[2];const s=await w.subscribe(root,(e)=>{if(e)throw e});for(let i=0;i<100&&w.diagnostics().trackedEntries!==257;i++)await delay(10);const stats=w.diagnostics();assert.equal(stats.trackedEntries,257);assert(stats.peakSubscriptionWork<=4,JSON.stringify(stats));await s.unsubscribe();await w.writeSnapshot(root,process.argv[3]);assert.deepEqual(await w.getEventsSince(root,process.argv[3]),[]);console.log(JSON.stringify(stats))})().catch(e=>{console.error(e);process.exitCode=1})'
  const output = execFileSync(process.execPath, ['-e', script, require.resolve('../lib/adapter.cjs'), root, path.join(state, 'exact-snapshot')], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: config }, timeout: 15000 })
  assert.equal(JSON.parse(output).trackedEntries, 257)
})

test('tracking limits apply during startup and after readiness with actionable counts', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'seed'), 'x')
  const config = path.join(state, 'growth-limit.json')
  await fs.writeFile(config, JSON.stringify({ maxTrackedEntries: 4, logLevel: 'silent' }))
  const script = 'const w=require(process.argv[1]),fs=require(\'fs\'),path=require(\'path\'),assert=require(\'assert/strict\');(async()=>{const root=process.argv[2],errors=[];const s=await w.subscribe(root,e=>{if(e)errors.push(e)});for(let i=0;i<3;i++)fs.writeFileSync(path.join(root,String(i)),\'x\');for(let i=0;i<100&&!errors.length;i++)await new Promise(r=>setTimeout(r,10));assert.equal(errors.length,1);assert.match(errors[0].message,/maxTrackedEntries=4, trackedEntries=5/);assert.match(errors[0].message,/effectiveRoots=/);await s.unsubscribe();await assert.rejects(w.subscribe(root,()=>{}),/maxTrackedEntries=4, trackedEntries=5/);await assert.rejects(w.writeSnapshot(root,process.argv[3]),/maxTrackedEntries=4/);console.log(\'PASS\')})().catch(e=>{console.error(e);process.exitCode=1})'
  const output = execFileSync(process.execPath, ['-e', script, require.resolve('../lib/adapter.cjs'), root, path.join(state, 'limited-snapshot')], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: config }, timeout: 15000 })
  assert.match(output, /PASS/)
})

test('root environment override forces restriction and retains ignore rules and limits', async t => {
  const root = await fixture(t)
  const configFile = path.join(state, 'environment-root.json')
  await fs.writeFile(configFile, JSON.stringify({ scope: { mode: 'compatible' }, globalIgnore: ['**/hidden/**'], maxTrackedEntries: 7 }))
  const previous = process.env.RUST_WATCHER_ROOT
  try {
    process.env.RUST_WATCHER_ROOT = root
    const config = policy.load(configFile)
    assert.deepEqual(config.scope, { mode: 'restricted', allowedRoots: [root] })
    assert.deepEqual(config.globalIgnore, ['**/hidden/**'])
    assert.equal(config.maxTrackedEntries, 7)
    assert.deepEqual((await policy.specification(path.dirname(root), {}, config)).roots, [root])
    assert.deepEqual((await policy.specification(root + '-sibling', {}, config)).roots, [])
    await assert.rejects(async () => policy.load(path.join(state, 'missing-config')), /ENOENT/)
    for (const value of ['', 'relative/path', root + '/..', root + '/']) {
      process.env.RUST_WATCHER_ROOT = value
      assert.throws(() => policy.load(configFile), /Invalid RUST_WATCHER_ROOT/)
    }
    delete process.env.RUST_WATCHER_ROOT
    assert.equal(policy.load(configFile).scope.mode, 'compatible')
  } finally {
    if (previous === undefined) delete process.env.RUST_WATCHER_ROOT
    else process.env.RUST_WATCHER_ROOT = previous
  }
})

test('environment root clips native traversal and delivery before unrelated siblings are visited', async t => {
  const parent = await fixture(t)
  const root = path.join(parent, 'allowed')
  await fs.mkdir(root)
  await fs.mkdir(path.join(parent, 'unrelated'), { mode: 0 })
  const config = path.join(state, 'native-environment-root.json')
  await fs.writeFile(config, JSON.stringify({ scope: { mode: 'compatible' }, logLevel: 'silent' }))
  const script = 'const w=require(process.argv[1]),fs=require(\'fs\'),path=require(\'path\'),assert=require(\'assert/strict\');(async()=>{const root=process.argv[2],parent=path.dirname(root),events=[];const s=await w.subscribe(parent,(error,batch)=>{if(error)throw error;events.push(...batch)});fs.writeFileSync(path.join(parent,\'outside\'),\'x\');fs.writeFileSync(path.join(root,\'visible\'),\'x\');for(let i=0;i<100&&!events.some(e=>e.path===path.join(root,\'visible\'));i++)await new Promise(r=>setTimeout(r,10));assert(events.some(e=>e.path===path.join(root,\'visible\')));assert(!events.some(e=>e.path===path.join(parent,\'outside\')));assert.equal(w.diagnostics().visitedDirectories,1);const inactive=await w.subscribe(path.join(parent,\'unrelated\'),()=>{throw Error(\'out-of-scope callback\')});await inactive.unsubscribe();await s.unsubscribe();console.log(\'PASS\')})().catch(e=>{console.error(e);process.exitCode=1})'
  assert.match(execFileSync(process.execPath, ['-e', script, require.resolve('../lib/adapter.cjs'), root], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: config, RUST_WATCHER_ROOT: root }, timeout: 10000 }), /PASS/)
})
