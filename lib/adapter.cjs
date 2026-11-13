'use strict'

const path = require('node:path')
const policy = require('./policy.cjs')
const diagnostics = require('./diagnostics.cjs')
const native = require('../dist/rust_file_watcher.node')
const config = policy.load()
const subscriptions = new Map()
let engine
let nextId = 0
let snapshots = 0

function release () {
  if (subscriptions.size === 0 && snapshots === 0 && engine) {
    const previous = engine
    engine = undefined
    previous.close()
  }
}

function getEngine () {
  if (!engine) {
    const instance = new native.Engine((error, json) => {
      try {
        if (error) throw error
        const message = JSON.parse(json)
        if (message.kind === 'fatal') {
          for (const sub of [...subscriptions.values()]) fail(sub, new Error(message.message))
          return
        }
        const sub = subscriptions.get(message.id)
        if (!sub || sub.cancelled) return
        if (message.kind === 'ready') {
          sub.ready = true
          diagnostics.log('ready', { requestedRoot: sub.dir, effectiveRoots: sub.spec.roots, initializationMs: message.initializationMs, ...JSON.parse(instance.stats()) }, config.logLevel)
          sub.resolve(sub.handle)
        } else if (message.kind === 'events') sub.callback(null, message.events)
        else if (message.kind === 'error') fail(sub, new Error(message.message))
        else if (message.kind === 'overflow') diagnostics.log('overflow', { requestedRoot: sub.dir, message: message.message }, config.logLevel)
      } finally { instance.ack() }
    })
    engine = instance
  }
  return engine
}

function fail (sub, error) {
  const wasReady = sub.ready
  if (!wasReady) sub.reject(error)
  sub.handle.unsubscribe()
  diagnostics.log('error', { message: error.message, requestedRoot: sub.dir, effectiveRoots: sub.spec?.roots, maxTrackedEntries: sub.spec?.maxTrackedEntries }, config.logLevel)
  if (wasReady) sub.callback(error, [])
}

function subscribe (dir, callback, options) {
  if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'))
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  const id = ++nextId
  const sub = { id, dir: typeof dir === 'string' ? path.resolve(dir) : dir, callback, options, resolve, reject, ready: false, cancelled: false }
  sub.handle = {
    unsubscribe () {
      if (!sub.cancelled) {
        sub.cancelled = true
        subscriptions.delete(id)
        if (engine) engine.cancel(id)
        if (!sub.ready) resolve(sub.handle)
        release()
      }
      return Promise.resolve()
    }
  }
  subscriptions.set(id, sub)
  policy.specification(dir, options, config).then(spec => {
    if (sub.cancelled) return
    sub.spec = spec
    diagnostics.log('requested', { requestedRoot: sub.dir, effectiveRoots: spec.roots }, config.logLevel)
    if (spec.roots.length === 0) {
      sub.ready = true
      diagnostics.log('inactive', { requestedRoot: sub.dir }, config.logLevel)
      resolve(sub.handle)
      return
    }
    getEngine().start(id, JSON.stringify(spec))
  }).catch(error => fail(sub, error))
  return promise
}

async function unsubscribe (dir, callback, options) {
  const root = path.resolve(dir)
  for (const sub of [...subscriptions.values()]) {
    if (sub.dir === root && sub.callback === callback && JSON.stringify(sub.options || {}) === JSON.stringify(options || {})) await sub.handle.unsubscribe()
  }
}

async function snapshot (dir, file, options, write) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new TypeError('snapshot must be a nonempty path')
  const spec = await policy.specification(dir, options, config, true)
  snapshots++
  try {
    const output = await getEngine().snapshot(JSON.stringify(spec), path.resolve(file), write)
    return write ? undefined : JSON.parse(output)
  } finally { snapshots--; release() }
}

exports.subscribe = subscribe
exports.unsubscribe = unsubscribe
exports.writeSnapshot = (dir, file, options) => snapshot(dir, file, options, true)
exports.getEventsSince = (dir, file, options) => snapshot(dir, file, options, false)
exports.diagnostics = () => engine ? JSON.parse(engine.stats()) : { activeWatches: 0, subscriptions: 0, queuedEvents: 0 }
exports.reconcile = () => { if (engine) engine.reconcile() }
