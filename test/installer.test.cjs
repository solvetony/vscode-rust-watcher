'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { fixture, state, eventually } = require('./helpers.cjs')
const installer = require('../lib/install.cjs')
const baseline = require('./baseline.cjs')()
const profile = require('../config/compatibility.json')

async function fake (t) {
  const root = await fixture(t)
  const server = path.join(root, 'server')
  const pkg = path.join(server, 'node_modules/@parcel/watcher')
  fs.mkdirSync(path.dirname(pkg), { recursive: true })
  fs.cpSync(baseline.pkg, pkg, { recursive: true })
  fs.copyFileSync(baseline.file, path.join(pkg, 'index.js'))
  fs.rmSync(path.join(pkg, '.rust-watcher-original-index.cjs'), { force: true })
  fs.symlinkSync(baseline.node, path.join(server, 'node'))
  for (const name of ['picomatch', 'is-glob', 'is-extglob', 'detect-libc']) {
    const source = path.dirname(require.resolve(`${name}/package.json`, { paths: [baseline.pkg, process.cwd()] }))
    fs.symlinkSync(source, path.join(server, 'node_modules', name))
  }
  const bundle = path.join(server, 'out/vs/platform/files/node/watcher/watcherMain.js')
  fs.mkdirSync(path.dirname(bundle), { recursive: true })
  fs.copyFileSync(path.join(baseline.server, 'out/vs/platform/files/node/watcher/watcherMain.js'), bundle)
  const config = path.join(root, 'policy.json')
  const allowed = path.join(root, 'fixture')
  fs.mkdirSync(allowed)
  fs.writeFileSync(config, JSON.stringify({ scope: { mode: 'restricted', allowedRoots: [allowed] }, logLevel: 'silent' }))
  return { root, server, pkg, entry: path.join(pkg, 'index.js'), config, allowed }
}

test('fake server install, named exports, idempotence, verify and persistent rollback', { skip: !baseline }, async t => {
  const f = await fake(t)
  const binary = installer.fileHash(path.join(f.pkg, 'build/Release/watcher.node'))
  const result = installer.install(f.server, f.config, true)
  assert.match(result.message, /Reload Window/)
  assert.notEqual(installer.fileHash(f.entry), profile.entrySha256)
  assert.equal(installer.fileHash(path.join(f.pkg, 'build/Release/watcher.node')), binary)
  assert.equal(installer.install(f.server, f.config, true).build, result.build)
  assert.match(installer.verify(f.server).smoke, /PASS/)
  assert.equal(installer.status(f.server, true)[0].disk, 'replacement installed on disk')
  assert(fs.existsSync(path.join(state, 'auto.json')))
  installer.restore(true)
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
  fs.copyFileSync(path.join(baseline.pkg, 'package.json'), path.join(f.pkg, 'package.json'))
  fs.appendFileSync(path.join(f.server, 'out/vs/platform/files/node/watcher/watcherMain.js'), '\n// unreviewed server update\n')
  assert.throws(() => installer.install(f.server, f.config), /bundle fingerprint/)
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
  assert(!fs.existsSync(path.join(state, 'auto.json')))
  assert.match(installer.install(f.server, f.config, false, true).message, /marker absent/)
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
})

test('unknown modifications and changed upstream versions are refused', { skip: !baseline }, async t => {
  const f = await fake(t)
  fs.appendFileSync(f.entry, '\n// unknown change\n')
  assert.throws(() => installer.install(f.server, f.config), /unknown entry-point/)
  assert(fs.readFileSync(f.entry, 'utf8').includes('unknown change'))
  fs.copyFileSync(baseline.file, f.entry)
  const pkg = JSON.parse(fs.readFileSync(path.join(f.pkg, 'package.json'), 'utf8'))
  pkg.version = '99.0.0'
  fs.writeFileSync(path.join(f.pkg, 'package.json'), JSON.stringify(pkg))
  assert.throws(() => installer.install(f.server, f.config), /unsupported Parcel/)
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
})

test('read-only package directory fails before backup/install and gives the same restore guidance', { skip: !baseline }, async t => {
  const f = await fake(t)
  const original = installer.fileHash(f.entry)
  try {
    fs.chmodSync(f.pkg, 0o555)
    assert.throws(() => installer.install(f.server, f.config), /Parcel package directory is not writable by UID/)
    assert.equal(installer.fileHash(f.entry), original)
    assert(!fs.existsSync(path.join(f.pkg, '.rust-watcher-original-index.cjs')))
    fs.chmodSync(f.pkg, 0o755)
    installer.install(f.server, f.config)
    const shim = installer.fileHash(f.entry)
    fs.chmodSync(f.pkg, 0o555)
    assert.throws(() => installer.restore(false), /requires directory write access/)
    assert.throws(() => installer.retainStock(f.server), /requires directory write access/)
    assert.equal(installer.fileHash(f.entry), shim)
  } finally {
    fs.chmodSync(f.pkg, 0o755)
    installer.restore(false)
  }
})

test('opt-in ownership repair targets only the validated root-owned package and fails closed without sudo', { skip: !baseline }, async t => {
  const f = await fake(t)
  const access = fs.accessSync
  const lstat = fs.lstatSync
  const childProcess = require('node:child_process')
  let writable = false
  let unavailable = false
  const repairs = []
  const previous = process.env.RUST_WATCHER_FIX_PERMISSIONS
  t.mock.method(fs, 'accessSync', (file, mode) => {
    if (file === f.pkg && !writable) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return access(file, mode)
  })
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const info = lstat(file, ...args)
    return file === f.pkg ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: 0 }) : info
  })
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    assert.equal(file, '/usr/bin/sudo')
    assert.deepEqual(args, ['-n', '--', '/usr/bin/chown', '--no-dereference', `${process.getuid()}:${process.getgid()}`, '--', f.pkg])
    assert.equal(options.timeout, 5000)
    repairs.push(args)
    if (unavailable) throw new Error('sudo: a password is required')
    writable = true
    return ''
  })
  try {
    delete process.env.RUST_WATCHER_FIX_PERMISSIONS
    assert.throws(() => installer.install(f.server, f.config), /directory is not writable/)
    assert.equal(repairs.length, 0)
    process.env.RUST_WATCHER_FIX_PERMISSIONS = '1'
    assert.match(installer.install(f.server, f.config).smoke, /PASS/)
    assert.equal(repairs.length, 1)
    installer.restore(false)
    writable = false
    unavailable = true
    assert.throws(() => installer.install(f.server, f.config), /Automatic ownership repair failed: sudo: a password is required/)
    assert.equal(installer.fileHash(f.entry), profile.entrySha256)
    assert.equal(fs.statSync(f.pkg).uid, process.getuid())
  } finally {
    if (previous === undefined) delete process.env.RUST_WATCHER_FIX_PERMISSIONS
    else process.env.RUST_WATCHER_FIX_PERMISSIONS = previous
    writable = true
    installer.restore(false)
  }
})

test('interrupted backup and prepared-manifest phases are recoverable', { skip: !baseline }, async t => {
  const f = await fake(t)
  installer.install(f.server, f.config)
  installer.restore(false)
  const directory = path.join(state, 'installs', require('node:crypto').createHash('sha256').update(f.server).digest('hex'))
  const manifestFile = path.join(directory, 'manifest.json')
  fs.unlinkSync(manifestFile)
  assert.match(installer.install(f.server, f.config).smoke, /PASS/)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.phase = 'prepared'
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.match(installer.install(f.server, f.config).smoke, /PASS/)
  installer.restore(false)
})

test('missing backup state and tampered releases cannot be overwritten or restored', { skip: !baseline }, async t => {
  const f = await fake(t)
  const result = installer.install(f.server, f.config)
  const directory = path.join(state, 'installs', require('node:crypto').createHash('sha256').update(f.server).digest('hex'))
  const backup = path.join(directory, 'original-index.js')
  const manifest = path.join(directory, 'manifest.json')
  fs.renameSync(manifest, `${manifest}.hidden`)
  assert.throws(() => installer.install(f.server, f.config), /unknown entry-point/)
  fs.renameSync(`${manifest}.hidden`, manifest)
  const original = fs.readFileSync(backup)
  fs.writeFileSync(backup, 'damaged')
  assert.throws(() => installer.install(f.server, f.config), /backup verification/)
  assert.throws(() => installer.restore(false), /checksum mismatch/)
  fs.writeFileSync(backup, original)
  const release = path.join(state, 'releases', result.build)
  const file = path.join(release, 'lib/adapter.cjs')
  const adapter = fs.readFileSync(file)
  fs.chmodSync(file, 0o600)
  fs.writeFileSync(file, 'damaged')
  assert.throws(() => installer.verify(f.server), /checksum mismatch/)
  fs.writeFileSync(file, adapter)
  fs.chmodSync(file, 0o400)
  installer.restore(false)
})

test('native initialization fallback is degraded and never passes verification', { skip: !baseline }, async t => {
  const f = await fake(t)
  const result = installer.install(f.server, f.config)
  const addon = path.join(state, 'releases', result.build, 'dist/rust_file_watcher.node')
  fs.renameSync(addon, `${addon}.hidden`)
  try {
    const script = 'const w=require(process.argv[1]);const fs=require(\'fs\');const state=process.argv[2];const pid=process.pid;const names=fs.readdirSync(state+\'/health\').filter(n=>n.startsWith(pid+\'-\'));console.log(JSON.stringify(JSON.parse(fs.readFileSync(state+\'/health/\'+names[0],\'utf8\')).backend));if(typeof w.subscribe!==\'function\')throw Error(\'fallback missing\')'
    const output = execFileSync(baseline.node, ['-e', script, f.entry, state], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: f.config } })
    assert.equal(JSON.parse(output), 'fallback')
    assert.throws(() => installer.verify(f.server), /checksum mismatch|ENOENT/)
  } finally { fs.renameSync(`${addon}.hidden`, addon); installer.restore(false) }
})

test('invalid configured startup is prominently degraded, never reported as unrestricted Rust', { skip: !baseline }, async t => {
  const f = await fake(t)
  installer.install(f.server, f.config)
  const script = 'require(process.argv[1]);const fs=require(\'fs\'),dir=process.argv[2]+\'/health\';const name=fs.readdirSync(dir).find(n=>n.startsWith(process.pid+\'-\'));console.log(fs.readFileSync(dir+\'/\'+name,\'utf8\'))'
  const record = JSON.parse(execFileSync(baseline.node, ['-e', script, f.entry, state], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: path.join(f.root, 'missing-policy.json') } }))
  assert.equal(record.backend, 'fallback')
  assert.equal(record.policy, null)
  assert.match(record.error, /ENOENT/)
  installer.restore(false)
})

test('installer lock excludes concurrent invocations and recovers a stale owner', { skip: !baseline }, async t => {
  const holder = spawn(process.execPath, ['-e', 'require(process.argv[1]).withLock(()=>{require(\'fs\').writeFileSync(process.argv[2],\'ready\');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200)})', require.resolve('../lib/install.cjs'), path.join(state, 'lock-ready')], { env: process.env, stdio: 'pipe' })
  t.after(() => { if (holder.exitCode === null) holder.kill() })
  await eventually(() => fs.existsSync(path.join(state, 'lock-ready')))
  assert.throws(() => installer.withLock(() => {}), /another installer/)
  await new Promise((resolve, reject) => { holder.once('exit', code => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))); holder.once('error', reject) })
  const lock = path.join(state, 'lock')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, start: '0' }))
  assert.equal(installer.withLock(() => 'recovered'), 'recovered')
})

test('live status verifies a real process mapping and start identity, not smoke-test records', { skip: !baseline }, async t => {
  const f = await fake(t)
  installer.install(f.server, f.config)
  const bootstrap = path.join(f.server, 'out/bootstrap-fork')
  fs.writeFileSync(bootstrap, `require(${JSON.stringify(f.entry)});setInterval(()=>{},1000)`)
  const child = spawn(path.join(f.server, 'node'), [bootstrap, '--type=fileWatcher'], { env: { ...process.env, RUST_WATCHER_CONFIG: f.config }, stdio: 'pipe' })
  t.after(() => { if (child.exitCode === null) child.kill() })
  await eventually(() => installer.status(f.server, true)[0].live.some(proc => proc.pid === child.pid && proc.state === 'running Rust backend'))
  installer.restore(false)
  const running = installer.status(f.server, true)[0]
  assert.equal(running.disk, 'original package on disk')
  assert(running.live.some(proc => proc.state === 'running Rust backend'))
  child.kill()
  await new Promise(resolve => child.once('exit', resolve))
  assert.deepEqual(installer.status(f.server, true)[0].live, [])
})

test('multiple active fake candidates are reported; concurrent installs serialize safely', { skip: !baseline }, async t => {
  const a = await fake(t)
  const b = await fake(t)
  const servers = []
  for (const f of [a, b]) {
    const bootstrap = path.join(f.server, 'out/bootstrap-fork')
    fs.writeFileSync(bootstrap, `require(${JSON.stringify(f.entry)});setInterval(()=>{},1000)`)
    const child = spawn(path.join(f.server, 'node'), [bootstrap, '--type=fileWatcher'], { stdio: 'pipe' })
    t.after(() => { if (child.exitCode === null) child.kill() })
    servers.push(child)
  }
  await eventually(() => [a, b].every(f => installer.discover().some(item => item.server === f.server && item.processes.some(proc => proc.command === 'fileWatcher'))))
  const invocations = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, [require.resolve('../bin/watcherctl.cjs'), 'install', '--server-root', a.server, '--config', a.config], { env: process.env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stderr })) })
  })
  const results = await Promise.all(invocations)
  assert(results.some(result => result.code === 0))
  for (const result of results) if (result.code !== 0) assert.match(result.stderr, /another installer/)
  assert.match(installer.verify(a.server).smoke, /PASS/)
  assert(installer.status(a.server, true)[0].live.some(proc => proc.state === 'installed replacement awaiting process restart'))
  assert.equal(installer.fileHash(b.entry), profile.entrySha256)
  installer.restore(false)
  for (const child of servers) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
  }
})

test('attach build failure attempts stock restoration and absent opt-in does nothing', { skip: !baseline }, async t => {
  const f = await fake(t)
  fs.rmSync(path.join(state, 'auto-disabled.json'), { force: true })
  const marker = path.join(state, 'auto.json')
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, config: f.config, project: path.resolve(__dirname, '..') }))
  const saved = Object.fromEntries(['discover', 'buildFresh', 'withLock', 'retainStock'].map(key => [key, installer[key]]))
  const log = console.error
  const warnings = []
  let restored
  try {
    installer.discover = () => [{ server: f.server, processes: [{ command: 'server' }] }]
    installer.buildFresh = () => false
    installer.withLock = () => { throw new Error('injected build failure') }
    installer.retainStock = server => { restored = server }
    console.error = message => warnings.push(message)
    require('../scripts/on-attach.cjs')
    assert.equal(restored, f.server)
    assert(warnings.some(message => message.includes('injected build failure')))
    fs.unlinkSync(marker)
    delete require.cache[require.resolve('../scripts/on-attach.cjs')]
    restored = undefined
    require('../scripts/on-attach.cjs')
    assert.equal(restored, undefined)
  } finally {
    Object.assign(installer, saved)
    console.error = log
    fs.rmSync(marker, { force: true })
    delete require.cache[require.resolve('../scripts/on-attach.cjs')]
  }
})

test('image package installs, verifies and rolls back without source, Cargo or npm', { skip: !baseline }, async t => {
  const f = await fake(t)
  const archive = path.join(f.root, 'image.tar.gz')
  const packaged = installer.packageImage(archive, f.config)
  assert.equal(packaged.sha256, installer.fileHash(archive))
  const image = path.join(f.root, 'opt-watcher')
  fs.mkdirSync(image)
  execFileSync('tar', ['-xzf', archive, '-C', image])
  assert.equal(fs.readFileSync(path.join(image, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(__dirname, '../LICENSE'), 'utf8'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(image, 'package.json'), 'utf8')).license, 'MIT')
  for (const name of ['src', 'Cargo.toml', 'Cargo.lock', 'scripts/build.cjs', 'node_modules/node']) assert(!fs.existsSync(path.join(image, name)), name)
  const isolated = path.join(f.root, 'image-state')
  const env = { ...process.env, RUST_WATCHER_STATE: isolated, PATH: '/nonexistent' }
  const cli = path.join(image, 'bin/watcherctl.cjs')
  const run = args => JSON.parse(execFileSync(baseline.node, [cli, ...args], { env, encoding: 'utf8', timeout: 60000 }))
  const config = path.join(image, 'config/devcontainer.json')
  assert.match(run(['install', '--server-root', f.server, '--config', config, '--enable-auto']).smoke, /PASS/)
  assert.match(run(['verify', '--server-root', f.server]).smoke, /PASS/)
  run(['restore', '--all', '--disable-auto'])
  assert(fs.existsSync(path.join(isolated, 'auto-disabled.json')))
  const seed = 'console.log(require(process.argv[1]).imageAuto())'
  assert.equal(execFileSync(baseline.node, ['-e', seed, path.join(image, 'lib/install.cjs')], { env, encoding: 'utf8' }).trim(), 'false')
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
  assert.match(run(['install', '--server-root', f.server, '--config', f.config, '--enable-auto']).smoke, /PASS/)
  assert(!fs.existsSync(path.join(isolated, 'auto-disabled.json')))
  run(['restore', '--all', '--disable-auto'])
  const addon = path.join(image, 'dist/rust_file_watcher.node')
  fs.appendFileSync(addon, 'tampered')
  assert.throws(() => run(['install', '--server-root', f.server, '--config', config]), /missing\/stale build/)
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
})

test('image preload activates before the first ESM import and respects persistent disable after rebuild', { skip: !baseline }, async t => {
  const f = await fake(t)
  const archive = path.join(f.root, 'startup-image.tar.gz')
  installer.packageImage(archive, f.config)
  const image = path.join(f.root, 'image')
  fs.mkdirSync(image)
  execFileSync('tar', ['-xzf', archive, '-C', image])
  fs.unlinkSync(path.join(f.server, 'node'))
  fs.copyFileSync(baseline.node, path.join(f.server, 'node'))
  fs.writeFileSync(path.join(f.server, 'package.json'), JSON.stringify({ type: 'module' }))
  const main = path.join(f.server, 'out/server-main.js')
  fs.writeFileSync(main, 'import watcher from "@parcel/watcher"; import fs from "node:fs"; console.log(JSON.stringify({rust:fs.readFileSync("/proc/self/maps","utf8").includes("/rust_file_watcher.node"),api:typeof watcher.subscribe}))')
  const isolated = path.join(f.root, 'startup-state')
  const env = { ...process.env, RUST_WATCHER_STATE: isolated, NODE_OPTIONS: `--require=${path.join(image, 'integrations/devcontainer/preload.cjs')}`, PATH: '/nonexistent' }
  const run = () => JSON.parse(execFileSync(path.join(f.server, 'node'), [main], { env, encoding: 'utf8', timeout: 60000 }))
  assert.deepEqual(run(), { rust: true, api: 'function' })
  assert(fs.existsSync(path.join(isolated, 'auto.json')))
  const cli = path.join(image, 'bin/watcherctl.cjs')
  execFileSync(baseline.node, [cli, 'restore', '--all', '--disable-auto'], { env, encoding: 'utf8' })
  assert.deepEqual(run(), { rust: false, api: 'function' })
  assert(!fs.existsSync(path.join(isolated, 'auto.json')))
  fs.rmSync(image, { recursive: true })
  fs.mkdirSync(image)
  execFileSync('tar', ['-xzf', archive, '-C', image])
  assert.deepEqual(run(), { rust: false, api: 'function' })
  fs.rmSync(path.join(isolated, 'auto-disabled.json'))
  fs.appendFileSync(path.join(f.server, 'out/vs/platform/files/node/watcher/watcherMain.js'), '\n// unsupported update\n')
  assert.deepEqual(run(), { rust: false, api: 'function' })
  assert.equal(installer.fileHash(f.entry), profile.entrySha256)
})
