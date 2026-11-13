'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const diagnostics = require('./diagnostics.cjs')
const policy = require('./policy.cjs')
const jsonc = require('jsonc-parser')
const project = path.resolve(__dirname, '..')
const profile = require('../config/compatibility.json')
const hash = content => crypto.createHash('sha256').update(content).digest('hex')
const fileHash = file => hash(fs.readFileSync(file))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const exists = file => fs.existsSync(file)

function serverPaths (server) {
  server = fs.realpathSync(server)
  const pkg = path.join(server, 'node_modules/@parcel/watcher')
  return { server, pkg, entry: path.join(pkg, 'index.js'), wrapper: path.join(pkg, 'wrapper.js'), node: path.join(server, 'node'), bundle: path.join(server, 'out/vs/platform/files/node/watcher/watcherMain.js'), original: path.join(pkg, '.rust-watcher-original-index.cjs') }
}

function requirePackageWrite (pkg) {
  try { fs.accessSync(pkg, fs.constants.W_OK | fs.constants.X_OK) } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EROFS') throw error
    let repair = ''
    if (error.code === 'EACCES' && process.env.RUST_WATCHER_FIX_PERMISSIONS === '1') {
      const owner = fs.lstatSync(pkg)
      if (owner.isDirectory() && owner.uid === 0 && (owner.mode & 0o300) === 0o300) {
        try {
          require('node:child_process').execFileSync('/usr/bin/sudo', ['-n', '--', '/usr/bin/chown', '--no-dereference', `${process.getuid()}:${process.getgid()}`, '--', pkg], { encoding: 'utf8', timeout: 5000 })
          fs.accessSync(pkg, fs.constants.W_OK | fs.constants.X_OK)
          return
        } catch (failure) { repair = ` Automatic ownership repair failed: ${failure.message}.` }
      }
    }
    throw new Error(`Parcel package directory is not writable by UID ${process.getuid()}: ${pkg}. Atomic backup/install/restore requires directory write access.${repair} Ask the container administrator to grant access to this directory, then retry; see docs/image-installation.md#server-directory-permissions.`)
  }
}

function processServers () {
  const result = new Map()
  let entries
  try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).slice(0, 16384) } catch { return result }
  for (const pid of entries) {
    try {
      const executable = fs.readlinkSync(`/proc/${pid}/exe`)
      if (path.basename(executable) !== 'node') continue
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const main = args.find(arg => /\/out\/(bootstrap-fork(?:\.js)?|server-main\.js)$/.test(arg))
      if (!main) continue
      const server = fs.realpathSync(path.dirname(path.dirname(main)))
      if (!exists(path.join(server, 'node_modules/@parcel/watcher/package.json'))) continue
      const command = args.join(' ')
      if (!result.has(server)) result.set(server, [])
      result.get(server).push({ pid: Number(pid), command: command.includes('--type=fileWatcher') ? 'fileWatcher' : command.includes('server-main') ? 'server' : 'other' })
    } catch {}
  }
  return result
}

function discover () {
  const processes = processServers()
  const roots = new Set(processes.keys())
  const locations = ['/vscode/vscode-server/bin/linux-x64', path.join(os.homedir(), '.vscode-server/bin'), path.join(os.homedir(), '.vscode-server-insiders/bin')]
  for (const location of locations) {
    let names
    try { names = fs.readdirSync(location).slice(0, 256) } catch { continue }
    for (const name of names) {
      const server = path.join(location, name)
      if (exists(path.join(server, 'node_modules/@parcel/watcher/package.json'))) roots.add(fs.realpathSync(server))
    }
  }
  for (const base of ['.vscode-server', '.vscode-server-insiders']) {
    const location = path.join(os.homedir(), base, 'cli/servers')
    let names
    try { names = fs.readdirSync(location).slice(0, 256) } catch { continue }
    for (const name of names) {
      const server = path.join(location, name, 'server')
      if (exists(path.join(server, 'node_modules/@parcel/watcher/package.json'))) roots.add(fs.realpathSync(server))
    }
  }
  return [...roots].sort().map(server => {
    try {
      const info = read(path.join(server, 'node_modules/@parcel/watcher/package.json'))
      return { server, version: info.version, processes: processes.get(server) || [] }
    } catch (error) { return { server, error: error.message, processes: processes.get(server) || [] } }
  })
}

function stateDirectory () {
  const state = path.resolve(diagnostics.state)
  if (policy.contains('/workspaces/mounted/projects', state)) throw new Error('state directory must be outside the watched projects tree')
  diagnostics.privateDirectory(state)
  for (const name of ['installs', 'releases']) diagnostics.privateDirectory(path.join(state, name))
  return state
}

function withLock (fn) {
  const state = stateDirectory()
  const lock = path.join(state, 'lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const owner = read(path.join(lock, 'owner.json'))
        try { stale = diagnostics.startIdentity(owner.pid) !== owner.start } catch (e) { if (e.code === 'ENOENT') stale = true; else throw e }
      } catch (e) { if (e.code === 'ENOENT' && Date.now() - fs.statSync(lock).mtimeMs > 30000) stale = true }
      if (!stale || attempt === 1) throw new Error('another installer owns the state lock; retry after it finishes')
      fs.rmSync(lock, { recursive: true })
    }
  }
  try {
    diagnostics.atomic(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: diagnostics.startIdentity() }))
    return fn(state)
  } finally { fs.rmSync(lock, { recursive: true }) }
}

function installation (state, server) {
  const directory = path.join(state, 'installs', hash(server))
  return { directory, file: path.join(directory, 'manifest.json') }
}

function runtimeInfo (node) {
  return JSON.parse(execFileSync(node, ['-e', 'console.log(JSON.stringify({node:process.version,napi:Number(process.versions.napi),arch:process.arch,platform:process.platform,libc:process.report.getReport().header.glibcVersionRuntime}))'], { encoding: 'utf8', timeout: 15000 }))
}

function validateTarget (paths, manifest) {
  const pkg = read(path.join(paths.pkg, 'package.json'))
  if (pkg.name !== profile.package || pkg.version !== profile.version || pkg.main !== profile.main || pkg.type === 'module' || fileHash(path.join(paths.pkg, 'package.json')) !== profile.packageSha256 || fileHash(paths.wrapper) !== profile.wrapperSha256) throw new Error('unsupported Parcel package/version/wrapper fingerprint; leaving stock unchanged')
  const actual = fileHash(paths.entry)
  if (actual !== profile.entrySha256 && (!manifest || actual !== manifest.shimHash)) throw new Error('unknown entry-point modification; refusing to overwrite')
  const bundle = fs.readFileSync(paths.bundle, 'utf8')
  if (fileHash(paths.bundle) !== profile.bundleSha256) throw new Error('unsupported VS Code watcher bundle fingerprint; audit this update before adding a compatibility profile')
  if (!/import [\w$]+ from"@parcel\/watcher"/.test(bundle) || !bundle.includes('getEventsSince') || !bundle.includes('writeSnapshot') || !bundle.includes('subscribe') || !bundle.includes('"inotify"')) throw new Error('unsupported VS Code loading contract')
  const info = runtimeInfo(paths.node)
  if (info.platform !== 'linux' || info.arch !== 'x64' || !info.libc || info.napi < profile.napiMinimum) throw new Error('unsupported server Node ABI/platform')
  return { ...info, version: pkg.version, entry: profile.entrySha256, wrapper: profile.wrapperSha256, package: profile.packageSha256, bundle: fileHash(paths.bundle), commit: exists(path.join(paths.server, 'product.json')) ? read(path.join(paths.server, 'product.json')).commit : null }
}

function files (directory, prefix = '') {
  const result = []
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`release cannot include symlink: ${relative}`)
    if (entry.isDirectory()) result.push(...files(directory, relative))
    else if (entry.isFile()) result.push(relative)
    else throw new Error(`unsupported release file: ${relative}`)
  }
  return result
}

function buildFresh () {
  try {
    const build = read(path.join(project, 'dist/build.json'))
    if (exists(path.join(project, 'bundle.json'))) {
      const bundle = read(path.join(project, 'bundle.json'))
      const actual = files(project).filter(file => file !== 'bundle.json').sort()
      return bundle.schemaVersion === 1 && build.arch === process.arch && build.libc === process.report.getReport().header.glibcVersionRuntime && build.addon === fileHash(path.join(project, 'dist/rust_file_watcher.node')) && JSON.stringify(actual) === JSON.stringify(Object.keys(bundle.checksums).sort()) && Object.entries(bundle.checksums).every(([file, digest]) => policy.contains(project, path.resolve(project, file)) && fileHash(path.join(project, file)) === digest)
    }
    return build.arch === process.arch && build.libc === process.report.getReport().header.glibcVersionRuntime && build.rust.startsWith('rustc 1.99.1 ') && build.addon === fileHash(path.join(project, 'dist/rust_file_watcher.node')) && Object.entries(build.inputs).every(([file, digest]) => fileHash(path.join(project, file)) === digest)
  } catch { return false }
}

function copyDependencies (destination, names) {
  const copied = new Set()
  function dependency (name) {
    if (copied.has(name)) return
    copied.add(name)
    const source = path.join(project, 'node_modules', name)
    const pkg = read(path.join(source, 'package.json'))
    fs.cpSync(source, path.join(destination, 'node_modules', name), { recursive: true })
    for (const child of Object.keys(pkg.dependencies || {})) dependency(child)
  }
  for (const name of names) dependency(name)
}

function packageImage (output, config = path.join(project, 'config/devcontainer.json')) {
  if (!output) throw new Error('package requires --output FILE')
  if (!buildFresh()) throw new Error('missing/stale build; run npm run build before packaging')
  policy.load(path.resolve(config))
  output = path.resolve(output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-watcher-image-'))
  const archive = `${output}.${process.pid}.tmp`
  try {
    for (const name of ['lib', 'bin', 'config']) fs.cpSync(path.join(project, name), path.join(stage, name), { recursive: true })
    for (const file of ['scripts/smoke.cjs', 'scripts/on-attach.cjs', 'integrations/devcontainer/on-attach.sh', 'integrations/devcontainer/preload.cjs', 'dist/build.json', 'dist/rust_file_watcher.node']) {
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true })
      fs.copyFileSync(path.join(project, file), path.join(stage, file))
    }
    fs.copyFileSync(path.resolve(config), path.join(stage, 'config/devcontainer.json'))
    fs.copyFileSync(path.join(project, 'LICENSE'), path.join(stage, 'LICENSE'))
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'vscode-rust-watcher-image', version: require('../package.json').version, license: 'MIT', main: 'lib/adapter.cjs', dependencies: require('../package.json').dependencies }))
    copyDependencies(stage, Object.keys(require('../package.json').dependencies))
    const checksums = Object.fromEntries(files(stage).map(file => [file, fileHash(path.join(stage, file))]))
    fs.writeFileSync(path.join(stage, 'bundle.json'), JSON.stringify({ schemaVersion: 1, checksums }))
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', stage, '.'])
    fs.renameSync(archive, output)
    return { archive: output, sha256: fileHash(output), bytes: fs.statSync(output).size }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
  }
}

function imageAuto () {
  if (process.getuid() === 0) throw new Error('run image activation as vscode, not root')
  if (!exists(path.join(project, 'bundle.json')) || !buildFresh()) throw new Error('image package missing, incompatible or checksum verification failed; rebuild the image package')
  return withLock(state => {
    if (exists(path.join(state, 'auto-disabled.json'))) return false
    const marker = path.join(state, 'auto.json')
    if (!exists(marker)) diagnostics.atomic(marker, JSON.stringify({ schemaVersion: 1, config: path.join(project, 'config/devcontainer.json'), project }))
    const optIn = read(marker)
    if (optIn.schemaVersion !== 1 || optIn.project !== project) throw new Error('auto marker belongs to another package path; explicitly install this image package with --enable-auto to migrate')
    return true
  })
}

function release (state) {
  if (!buildFresh()) throw new Error('missing/stale build; run npm ci && npm run build with Node 24 as vscode')
  const stage = fs.mkdtempSync(path.join(state, 'releases/.stage-'))
  try {
    fs.mkdirSync(path.join(stage, 'lib'))
    for (const name of ['adapter.cjs', 'policy.cjs', 'loader.cjs', 'diagnostics.cjs']) fs.copyFileSync(path.join(project, 'lib', name), path.join(stage, 'lib', name))
    fs.mkdirSync(path.join(stage, 'dist'))
    for (const name of ['build.json', 'rust_file_watcher.node']) fs.copyFileSync(path.join(project, 'dist', name), path.join(stage, 'dist', name))
    fs.copyFileSync(path.join(project, 'LICENSE'), path.join(stage, 'LICENSE'))
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'vscode-rust-watcher-runtime', version: require('../package.json').version, license: 'MIT', main: 'lib/adapter.cjs' }))
    copyDependencies(stage, ['is-glob', 'picomatch'])
    const checksums = Object.fromEntries(files(stage).map(file => [file, fileHash(path.join(stage, file))]))
    const build = hash(JSON.stringify(checksums))
    fs.writeFileSync(path.join(stage, 'checksums.json'), JSON.stringify(checksums))
    const destination = path.join(state, 'releases', build)
    if (exists(destination)) {
      verifyRelease(destination)
      fs.rmSync(stage, { recursive: true })
    } else {
      for (const file of files(stage)) fs.chmodSync(path.join(stage, file), 0o400)
      fs.renameSync(stage, destination)
    }
    return { path: destination, build }
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error }
}

function verifyRelease (directory) {
  const checksums = read(path.join(directory, 'checksums.json'))
  if (path.basename(directory) !== hash(JSON.stringify(checksums))) throw new Error('release manifest hash mismatch')
  const actual = files(directory).filter(file => file !== 'checksums.json').sort()
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(checksums).sort())) throw new Error('release checksum mismatch (file list)')
  for (const [file, digest] of Object.entries(checksums)) {
    if (!policy.contains(directory, path.resolve(directory, file)) || fileHash(path.join(directory, file)) !== digest) throw new Error(`release checksum mismatch: ${file}`)
  }
}

function shim (options) {
  return `'use strict'\nprocess.env.RUST_WATCHER_STATE = ${JSON.stringify(options.state)}\nconst watcher = require(${JSON.stringify(path.join(options.release, 'lib/loader.cjs'))}).load(${JSON.stringify(options)})\nexports.subscribe = watcher.subscribe\nexports.unsubscribe = watcher.unsubscribe\nexports.writeSnapshot = watcher.writeSnapshot\nexports.getEventsSince = watcher.getEventsSince\n`
}

function smoke (paths, config, module, state) {
  const settings = policy.load(config)
  const settingFiles = [path.join(os.homedir(), '.vscode-server/data/Machine/settings.json'), path.join(os.homedir(), '.vscode-server-insiders/data/Machine/settings.json'), ...((settings.scope.allowedRoots || []).map(root => path.join(root, '.vscode/settings.json')))]
  const ignores = ['**/.git/objects/**', '**/.git/subtree-cache/**', '**/node_modules/*/**', '**/.hg/store/**']
  for (const file of settingFiles) {
    if (!exists(file)) continue
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error(`settings file too large: ${file}`)
    const errors = []
    const parsed = jsonc.parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true })
    if (errors.length || !parsed || typeof parsed !== 'object') throw new Error(`cannot validate watcher settings: ${file}`)
    for (const [pattern, enabled] of Object.entries(parsed['files.watcherExclude'] || {})) if (enabled) ignores.push(pattern)
  }
  const env = { ...process.env, RUST_WATCHER_CONFIG: config, RUST_WATCHER_STATE: state, RUST_WATCHER_DISABLE: '0', RUST_WATCHER_PREFLIGHT_IGNORES: JSON.stringify([...new Set(ignores)]) }
  if (module === paths.entry) delete env.RUST_WATCHER_CONFIG
  const output = execFileSync(paths.node, [path.join(project, 'scripts/smoke.cjs'), module, config], { encoding: 'utf8', timeout: 60000, env }).trim()
  if (module === paths.entry) {
    execFileSync(paths.node, ['--input-type=module', '-e', 'import watcher, {subscribe, unsubscribe, writeSnapshot, getEventsSince} from "@parcel/watcher"; for (const [key,value] of Object.entries({subscribe,unsubscribe,writeSnapshot,getEventsSince})) if (typeof value !== "function" || watcher[key] !== value) throw Error("ESM contract mismatch")'], { cwd: paths.server, timeout: 15000, env })
  }
  return output
}

function install (server, config, enableAuto = false, autoOnly = false) {
  if (process.getuid() === 0) throw new Error('run install/build as vscode, not root')
  if (!server || !config) throw new Error('install requires --server-root PATH --config FILE')
  config = fs.realpathSync(config)
  const settings = policy.load(config)
  return withLock(state => {
    if (autoOnly && (!exists(path.join(state, 'auto.json')) || exists(path.join(state, 'auto-disabled.json')))) return { server, message: 'Auto-enable marker absent or disabled; leaving stock unchanged.' }
    if (settings.scope.mode === 'restricted' && settings.scope.allowedRoots.some(root => policy.contains(root, state))) throw new Error('state directory must be outside allowed roots')
    const paths = serverPaths(server)
    const location = installation(state, paths.server)
    let manifest = exists(location.file) ? read(location.file) : null
    const compatibility = validateTarget(paths, manifest)
    requirePackageWrite(paths.pkg)
    if (!manifest && exists(paths.original)) {
      const backup = path.join(location.directory, 'original-index.js')
      if (!exists(backup) || fileHash(backup) !== profile.entrySha256 || fileHash(paths.original) !== profile.entrySha256) throw new Error('unmanaged or unverifiable backup; refusing install')
      manifest = { schemaVersion: 1, state, config, server: paths.server, original: paths.original, originalHash: profile.entrySha256, originalMode: fs.statSync(paths.entry).mode & 0o777, phase: 'prepared' }
    }
    if (manifest) {
      if (manifest.originalHash !== profile.entrySha256 || fileHash(path.join(location.directory, 'original-index.js')) !== manifest.originalHash || !exists(paths.original) || fileHash(paths.original) !== manifest.originalHash) throw new Error('backup verification failed; refusing install')
      if (manifest.config !== config && fileHash(paths.entry) !== profile.entrySha256) throw new Error('configuration path changed; restore before reinstalling')
    }
    const runtime = release(state)
    smoke(paths, config, path.join(runtime.path, 'lib/adapter.cjs'), state)
    const options = { state, config, server: paths.server, original: paths.original, release: runtime.path, build: runtime.build }
    const content = shim(options)
    if (!manifest) {
      diagnostics.privateDirectory(location.directory)
      const original = fs.readFileSync(paths.entry)
      diagnostics.atomic(path.join(location.directory, 'original-index.js'), original)
      diagnostics.atomic(paths.original, original, fs.statSync(paths.entry).mode & 0o777)
      if (fileHash(paths.original) !== profile.entrySha256 || fileHash(path.join(location.directory, 'original-index.js')) !== profile.entrySha256) throw new Error('backup verification failed')
      manifest = { schemaVersion: 1, ...options, compatibility, originalHash: profile.entrySha256, originalMode: fs.statSync(paths.entry).mode & 0o777 }
    }
    manifest = { ...manifest, ...options, compatibility, shimHash: hash(content), phase: 'prepared' }
    diagnostics.atomic(location.file, JSON.stringify(manifest, null, 2))
    diagnostics.atomic(paths.entry, content, manifest.originalMode)
    manifest.phase = 'installed'
    diagnostics.atomic(location.file, JSON.stringify(manifest, null, 2))
    try {
      const result = smoke(paths, config, paths.entry, state)
      if (enableAuto) {
        diagnostics.atomic(path.join(state, 'auto.json'), JSON.stringify({ schemaVersion: 1, config, project }))
        fs.rmSync(path.join(state, 'auto-disabled.json'), { force: true })
      }
      return { server: paths.server, build: runtime.build, smoke: result, message: 'Installed on disk. Reload Window or reconnect is required for existing processes; run status --live afterward.' }
    } catch (error) {
      diagnostics.atomic(paths.entry, fs.readFileSync(path.join(location.directory, 'original-index.js')), manifest.originalMode)
      manifest.phase = 'restored'
      diagnostics.atomic(location.file, JSON.stringify(manifest, null, 2))
      throw new Error(`verification failed; original entry restored: ${error.message}`)
    }
  })
}

function manifests (state) {
  const base = path.join(state, 'installs')
  if (!exists(base)) return []
  return fs.readdirSync(base).filter(n => /^[0-9a-f]{64}$/.test(n)).map(name => path.join(base, name, 'manifest.json')).filter(exists).map(file => ({ file, manifest: read(file) }))
}

function restore (disableAuto) {
  return withLock(state => {
    if (disableAuto) {
      diagnostics.atomic(path.join(state, 'auto-disabled.json'), JSON.stringify({ schemaVersion: 1 }))
      fs.rmSync(path.join(state, 'auto.json'), { force: true })
    }
    const results = []
    for (const { file, manifest } of manifests(state)) {
      const entry = path.join(manifest.server, 'node_modules/@parcel/watcher/index.js')
      if (!exists(entry)) { results.push({ server: manifest.server, state: 'server absent, backup retained' }); continue }
      const digest = fileHash(entry)
      if (digest !== manifest.originalHash && digest !== manifest.shimHash) throw new Error(`unknown modification at ${entry}; refusing restoration`)
      const backup = path.join(path.dirname(file), 'original-index.js')
      if (fileHash(backup) !== manifest.originalHash) throw new Error('external backup checksum mismatch')
      if (digest !== manifest.originalHash) {
        requirePackageWrite(path.dirname(entry))
        diagnostics.atomic(entry, fs.readFileSync(backup), manifest.originalMode)
      }
      manifest.phase = 'restored'
      diagnostics.atomic(file, JSON.stringify(manifest, null, 2))
      results.push({ server: manifest.server, state: 'original package on disk; reload/reconnect required' })
    }
    return results
  })
}

function verify (server) {
  const state = stateDirectory()
  const paths = serverPaths(server)
  const location = installation(state, paths.server)
  if (!exists(location.file)) throw new Error('no installation manifest')
  const manifest = read(location.file)
  validateTarget(paths, manifest)
  if (fileHash(paths.entry) !== manifest.shimHash) throw new Error('replacement is not installed on disk')
  verifyRelease(manifest.release)
  return { smoke: smoke(paths, manifest.config, paths.entry, state), message: 'Selected server Node passed. This is not proof of live VS Code activation.' }
}

function retainStock (server) {
  return withLock(state => {
    const paths = serverPaths(server)
    const location = installation(state, paths.server)
    if (!exists(location.file)) return
    const manifest = read(location.file)
    if (fileHash(paths.entry) === manifest.originalHash) return
    if (fileHash(paths.entry) !== manifest.shimHash) throw new Error('unknown entry modification; restore refused')
    const backup = path.join(location.directory, 'original-index.js')
    if (fileHash(backup) !== manifest.originalHash) throw new Error('backup verification failed')
    requirePackageWrite(paths.pkg)
    diagnostics.atomic(paths.entry, fs.readFileSync(backup), manifest.originalMode)
    manifest.phase = 'restored'
    diagnostics.atomic(location.file, JSON.stringify(manifest, null, 2))
  })
}

function liveProcess (server, processInfo, manifest, state) {
  const { pid } = processInfo
  try {
    const start = diagnostics.startIdentity(pid)
    const maps = fs.readFileSync(`/proc/${pid}/maps`, 'utf8')
    const directory = path.join(state, 'health')
    const records = exists(directory) ? fs.readdirSync(directory).filter(name => name.startsWith(`${pid}-${start}-`)).map(name => read(path.join(directory, name))) : []
    const record = records.find(r => r.pid === pid && r.start === start && r.server === server && (!manifest || r.build === manifest.build))
    const mapped = maps.split('\n').some(line => line.includes('/rust_file_watcher.node') && (!manifest || line.includes(manifest.release)))
    const stockMapped = maps.split('\n').some(line => line.includes(`${server}/node_modules/@parcel/watcher`) && line.includes('/watcher.node'))
    if (record && record.backend !== 'rust') return { pid, process: processInfo.command, state: 'running fallback/original backend', backend: record.backend, policy: record.policy }
    if (record && mapped && record.backend === 'rust') return { pid, process: processInfo.command, state: 'running Rust backend', build: record.build, policy: record.policy }
    if (!mapped && !record && stockMapped) return { pid, process: processInfo.command, state: manifest?.phase === 'installed' ? 'installed replacement awaiting process restart' : 'running fallback/original backend', backend: 'original (mapped native binary)' }
    return { pid, process: processInfo.command, state: 'unknown (mapping/health evidence incomplete)' }
  } catch (error) { return { pid, process: processInfo.command, state: 'unknown due to permissions or missing diagnostics', error: error.code || error.message } }
}

function status (server, live) {
  const state = path.resolve(diagnostics.state)
  let candidates = discover()
  if (server) {
    server = fs.realpathSync(server)
    candidates = candidates.filter(candidate => candidate.server === server)
    if (candidates.length === 0) candidates.push({ server, version: read(path.join(server, 'node_modules/@parcel/watcher/package.json')).version, processes: processServers().get(server) || [] })
  }
  return candidates.map(candidate => {
    const paths = serverPaths(candidate.server)
    const location = installation(state, candidate.server)
    const manifest = exists(location.file) ? read(location.file) : null
    const digest = fileHash(paths.entry)
    const disk = digest === profile.entrySha256 ? 'original package on disk' : manifest && digest === manifest.shimHash ? 'replacement installed on disk' : 'unknown entry-point modification'
    return { ...candidate, disk, autoEnabled: exists(path.join(state, 'auto.json')), ...(live ? { live: candidate.processes.map(proc => liveProcess(candidate.server, proc, manifest, state)) } : {}) }
  })
}

function doctor () {
  const values = {}
  for (const name of ['max_user_watches', 'max_user_instances', 'max_queued_events']) {
    try { values[name] = fs.readFileSync(`/proc/sys/fs/inotify/${name}`, 'utf8').trim() } catch { values[name] = null }
  }
  return { platform: process.platform, arch: process.arch, developmentNode: process.version, buildFresh: buildFresh(), state: diagnostics.state, inotify: values, installations: status(undefined, true), note: 'Limits are read only. Unreadable process data is unknown, never zero watches.' }
}

module.exports = { discover, install, verify, restore, retainStock, status, doctor, withLock, buildFresh, packageImage, imageAuto, stateDirectory, fileHash, read, serverPaths, runtimeInfo, verifyRelease, pathToFileURL }
