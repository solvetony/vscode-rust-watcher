'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const picomatch = require('picomatch')
const { fixture, watch, delay } = require('./helpers.cjs')
const policy = require('../lib/policy.cjs')
const watcher = require('../lib/adapter.cjs')

test('compiled positive globs retain picomatch semantics on enumerated paths', () => {
  const patterns = ['**', '**/node_modules/**', '**/.git/objects/**', '**/.git/subtree-cache/**', '**/{dist,build}/**', '**/[ab]?.js', '**/@(foo|bar)/**', '**/+(foo|bar)/**', '**/?(foo|bar)/**', '**/*(foo|bar)/**', '**/*.js', 'foo\\*bar', '/tmp/root/**', 'a/**/b']
  const paths = ['', 'a', 'b', 'a/b', 'a/x/b', 'a/x/y/b', '.hidden/a.js', 'node_modules', 'node_modules/a.js', '.git/objects', '.git/objects/ab/1', 'app/node_modules/x', 'dist', 'dist/file', 'build/x', 'foo', 'foo/a', 'foobar/a', 'bar/a', 'foox/a', 'aa.js', 'bc.js', 'foo*bar', '/tmp/root/a', '日本語/a.js']
  for (const pattern of patterns) {
    const baseline = picomatch.makeRe(pattern, { dot: true, windows: false, strictBrackets: true })
    const translated = new RegExp(policy.compile(pattern))
    for (const name of paths) assert.equal(translated.test(name), baseline.test(name), `${pattern}: ${name}`)
  }
  for (const pattern of ['!foo', '**/!(foo)/**', '(?=x)', 'a[', '{1..50}']) assert.throws(() => policy.compile(pattern))
})

test('dependency and generated subtrees are pruned before traversal', async t => {
  const root = await fixture(t)
  const names = ['node_modules', '.git/objects', '.git/subtree-cache', '.next', 'dist', 'build', 'target']
  for (const name of names) {
    await fs.mkdir(path.join(root, name, 'deep/more'), { recursive: true })
    await fs.writeFile(path.join(root, name, 'deep/more/file'), 'x')
  }
  const observed = await watch(t, root, { ignore: names.map(name => `**/${name}/**`) })
  assert.equal(watcher.diagnostics().visitedDirectories, 2, 'only root and .git should be visited')
  assert.equal(watcher.diagnostics().pruned, names.length)
  for (const name of names) await fs.appendFile(path.join(root, name, 'deep/more/file'), 'y')
  await fs.writeFile(path.join(root, '.visible'), 'x')
  await observed.expect('.visible', 'create')
  assert(!observed.events.some(event => names.some(name => event.path.includes(`/${name}/`))))
})

test('fully excluded requests install no watches and visit no directories', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'unreadable'), { mode: 0 })
  t.after(() => fs.chmod(path.join(root, 'unreadable'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error }))
  const observed = await watch(t, root, { ignore: ['**'] })
  assert.equal(watcher.diagnostics().activeWatches, 0)
  assert.equal(watcher.diagnostics().visitedDirectories, 0)
  await fs.writeFile(path.join(root, 'hidden'), 'x')
  await delay(100)
  assert.deepEqual(observed.events, [])
})

test('literal ignores use component containment; braces, classes and extglobs work in Rust', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'literal'))
  await fs.mkdir(path.join(root, 'literal-other'))
  const observed = await watch(t, root, { ignore: ['literal', '**/{dist,build}/**', '**/@(foo|bar)/**', '**/[ab]?.js'] })
  for (const name of ['literal/file', 'dist/file', 'build/file', 'foo/file', 'bar/file', 'aa.js', 'bc.js', 'literal-other/visible']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), 'x')
  }
  await observed.expect('literal-other/visible', 'create')
  assert.deepEqual(observed.events.filter(e => e.type === 'create').map(e => path.relative(root, e.path)), ['literal-other/visible'])
})

test('restricted requests clip before scanning and retain original filter coordinates', async t => {
  const parent = await fixture(t)
  const root = path.join(parent, 'allowed')
  await fs.mkdir(root)
  await fs.mkdir(path.join(parent, 'unrelated'), { mode: 0 })
  t.after(() => fs.chmod(path.join(parent, 'unrelated'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error }))
  const config = path.join(parent, 'policy.json')
  await fs.writeFile(config, JSON.stringify({ scope: { mode: 'restricted', allowedRoots: [root] }, globalIgnore: ['**/global/**'], logLevel: 'silent' }))
  const script = 'const fs=require(\'fs\'),path=require(\'path\'),assert=require(\'assert/strict\'),w=require(process.argv[1]);(async()=>{const root=process.argv[2],parent=path.dirname(root);const events=[];const s=await w.subscribe(parent,(e,b)=>{if(e)throw e;events.push(...b)},{ignore:[\'allowed/ignored\']});assert.equal(w.diagnostics().visitedDirectories,1);for(const name of [\'ignored\',\'global\',\'visible\']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,\'file\'),\'x\')}await new Promise(r=>setTimeout(r,250));assert(events.some(e=>e.path.endsWith(\'/visible/file\')));assert(!events.some(e=>e.path.includes(\'/ignored\')||e.path.includes(\'/global\')));await s.unsubscribe();const inactive=await w.subscribe(root+\'-sibling\',()=>{throw Error(\'inactive callback\')});assert.equal(w.diagnostics().activeWatches,0);await inactive.unsubscribe();fs.symlinkSync(root,path.join(parent,\'link\'));await assert.rejects(w.subscribe(path.join(parent,\'link\'),()=>{}).then(s=>s.unsubscribe()),/symlink/).catch(e=>{if(!e.message.includes(\'Missing expected rejection\'))throw e});console.log(\'PASS\')})().catch(e=>{console.error(e);process.exitCode=1})'
  const output = execFileSync(process.execPath, ['-e', script, require.resolve('../lib/adapter.cjs'), root], { env: { ...process.env, RUST_WATCHER_CONFIG: config }, encoding: 'utf8', timeout: 10000 })
  assert.match(output, /PASS/)
  const spec = await policy.specification(parent, { ignore: ['allowed/ignored'] }, policy.load(config))
  assert.equal(spec.root, parent)
  assert.deepEqual(spec.roots, [root])
})

test('invalid explicit configuration never defaults to compatible', async t => {
  const root = await fixture(t)
  const config = path.join(root, 'config.json')
  await fs.writeFile(config, JSON.stringify({ scope: { mode: 'restricted', allowedRoots: [] } }))
  for (const filename of [config, path.join(root, 'absent'), '']) assert.throws(() => policy.load(filename))
  for (const input of [{ unknown: true }, { debounceMs: -1 }, { maxQueuedEvents: 1 }, { globalIgnore: ['**/!(foo)/**'] }, { scope: { mode: 'restricted', allowedRoots: ['/tmp/../etc'] } }]) assert.throws(() => policy.validate(input))
  assert.equal(policy.load().scope.mode, 'compatible')
})

test('projects policy excludes confirmed generated specs/backups without hiding source or widening scope', async () => {
  const config = policy.validate(require('../config/devcontainer.json'))
  assert.deepEqual(config.scope.allowedRoots, ['/workspaces/mounted/projects'])
  assert.equal(config.maxTrackedEntries, 3000000)
  const patterns = config.globalIgnore.map(pattern => new RegExp(policy.compile(pattern)))
  const ignored = name => patterns.some(pattern => pattern.test(`/workspaces/mounted/projects/${name}`))
  for (const name of ['specs/log-widgets.backup-2026-04-19/deep/file', 'specs/log-widgets.backup-improve-2026-04-19', 'specs/log-widgets/loghub', 'specs/log-widgets/zenodo/deep/file', 'specs/log-widgets/secrepo/deep/file', 'btcwid/specs/log-widgets/loghub/deep/file', 'btcwid/specs/log-widgets/zenodo', 'btcwid/specs/log-widgets/secrepo/deep/file']) assert(ignored(name), name)
  for (const name of ['specs/log-widgets/mappings.json', 'btcwid/specs/log-widgets/mappings.json', 'btcwid/scripts/generate-log-widget-specs.mjs', 'another-project/specs/log-widgets/loghub/file', 'specs/log-widgets/handwritten/file']) assert(!ignored(name), name)
})
