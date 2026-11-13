'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const picomatch = require('picomatch')
const isGlob = require('is-glob')

const defaults = { schemaVersion: 1, scope: { mode: 'compatible' }, globalIgnore: [], debounceMs: 40, maxBatchSize: 4096, maxQueuedEvents: 65536, maxTrackedEntries: 1000000, logLevel: 'info' }

function contains (root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative))
}

function strings (value, label) {
  if (!Array.isArray(value) || value.length > 1024 || value.some(s => typeof s !== 'string' || !s || s.includes('\0') || s.length > 4096)) {
    throw new TypeError(`${label} must contain at most 1024 nonempty strings (4096 characters each)`)
  }
  return value
}

function keys (value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`invalid ${label}`)
}

function compile (glob) {
  if (glob.startsWith('!') || glob.includes('!(') || glob.includes('(?') || /\{\d+\.\.\d+/.test(glob)) {
    throw new Error(`unsupported ignore pattern: ${glob}`)
  }
  let source = picomatch.makeRe(glob, { dot: true, windows: false, strictBrackets: true }).source
  // Directory enumeration never returns . or ..; these assertions are redundant.
  for (const assertion of ['(?!(?:^|\\/)\\.{1,2}(?:\\/|$))', '(?!\\.{1,2}(?:\\/|$))']) source = source.split(assertion).join('')
  source = source.replaceAll('(?=.)', '')
  if (source.includes('(?=') || source.includes('(?!') || source.includes('(?<') || /\\[1-9]/.test(source)) throw new Error(`unsupported ignore pattern: ${glob}`)
  return source.replaceAll('\\/', '/')
}

function validate (input) {
  keys(input, Object.keys(defaults), 'configuration')
  const value = { ...defaults, ...input }
  if (value.schemaVersion !== 1) throw new Error('unsupported configuration schemaVersion')
  keys(value.scope, ['mode', 'allowedRoots'], 'scope')
  if (!['compatible', 'restricted'].includes(value.scope.mode)) throw new Error('invalid scope.mode')
  if (value.scope.mode === 'restricted') {
    strings(value.scope.allowedRoots, 'scope.allowedRoots')
    if (value.scope.allowedRoots.length === 0 || value.scope.allowedRoots.some(s => !path.isAbsolute(s) || path.resolve(s) !== s)) throw new Error('allowedRoots must be normalized absolute paths')
  } else if (value.scope.allowedRoots !== undefined) throw new Error('allowedRoots requires restricted mode')
  strings(value.globalIgnore, 'globalIgnore')
  for (const pattern of value.globalIgnore) {
    if (isGlob(pattern)) compile(pattern)
    else if (!path.isAbsolute(pattern)) throw new Error('global literal ignores must be absolute')
  }
  for (const [key, min, max] of [['debounceMs', 0, 60000], ['maxBatchSize', 1, 65536], ['maxQueuedEvents', 1, 1000000], ['maxTrackedEntries', 1, 10000000]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`invalid ${key}`)
  }
  if (value.maxQueuedEvents < value.maxBatchSize) throw new Error('maxQueuedEvents must be >= maxBatchSize')
  if (!['silent', 'error', 'info', 'debug'].includes(value.logLevel)) throw new Error('invalid logLevel')
  return value
}

function load (file = process.env.RUST_WATCHER_CONFIG) {
  let input = {}
  if (file !== undefined) {
    if (!file || !path.isAbsolute(file)) throw new Error('RUST_WATCHER_CONFIG must be an absolute filename')
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('configuration exceeds 1 MiB')
    input = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  const config = validate(input)
  if (process.env.RUST_WATCHER_ROOT === undefined) return config
  try { return validate({ ...config, scope: { mode: 'restricted', allowedRoots: [process.env.RUST_WATCHER_ROOT] } }) } catch (error) {
    throw new Error(`Invalid RUST_WATCHER_ROOT: ${error.message}`)
  }
}

async function noSymlinks (root) {
  const parts = root.split(path.sep).filter(Boolean)
  let current = path.parse(root).root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error(`restricted path traverses a symlink: ${current}`)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
  }
}

async function specification (dir, options, config, querying = false) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) throw new TypeError('dir must be a nonempty path')
  if (options === undefined) options = {}
  keys(options, ['ignore', 'backend'], 'options')
  if (options.backend !== undefined && !['inotify', ...(querying ? ['brute-force'] : [])].includes(options.backend)) throw new Error(`unsupported backend: ${options.backend}`)
  const ignore = options.ignore === undefined ? [] : strings(options.ignore, 'ignore')
  let root = path.resolve(dir)
  let roots
  if (config.scope.mode === 'restricted') {
    roots = config.scope.allowedRoots.flatMap(allowed => contains(allowed, root) ? [root] : contains(root, allowed) ? [allowed] : [])
    roots = [...new Set(roots)].filter((r, i, all) => !all.some((a, j) => j !== i && contains(a, r)))
    for (const effective of roots) await noSymlinks(effective)
  } else {
    try { root = await fs.promises.realpath(root) } catch (e) { if (e.code !== 'ENOENT') throw e }
    roots = [root]
  }
  const literals = []
  const patterns = []
  const globalPatterns = []
  for (const pattern of ignore) {
    if (isGlob(pattern)) patterns.push(compile(pattern))
    else literals.push(path.resolve(root, pattern))
  }
  for (const pattern of config.globalIgnore) {
    if (isGlob(pattern)) globalPatterns.push(compile(pattern))
    else literals.push(path.resolve(pattern))
  }
  const identity = crypto.createHash('sha256').update(JSON.stringify({ root, roots, literals: [...literals].sort(), patterns: [...patterns].sort(), globalPatterns: [...globalPatterns].sort() })).digest('hex')
  return { root, roots, literals, patterns, globalPatterns, identity, debounceMs: config.debounceMs, maxBatchSize: config.maxBatchSize, maxQueuedEvents: config.maxQueuedEvents, maxTrackedEntries: config.maxTrackedEntries }
}

module.exports = { contains, compile, validate, load, specification }
