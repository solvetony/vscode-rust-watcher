'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-watcher-state-'))
process.env.RUST_WATCHER_STATE = state
delete process.env.RUST_WATCHER_CONFIG
delete process.env.RUST_WATCHER_ROOT
process.on('exit', () => fs.rmSync(state, { recursive: true, force: true }))

async function fixture (t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rust-watcher-test-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  return root
}

async function eventually (condition, message = 'condition did not become true', ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await condition()) return
    await delay(10)
  }
  assert.fail(message)
}

async function watch (t, root, options, implementation = require('../lib/adapter.cjs')) {
  const events = []
  const errors = []
  const subscription = await implementation.subscribe(root, (error, batch) => { if (error) errors.push(error); events.push(...batch) }, options)
  t.after(() => subscription.unsubscribe())
  const expect = (file, type) => eventually(() => { if (errors.length) throw errors[0]; return events.some(e => e.path === path.join(root, file) && e.type === type) }, `missing ${type}: ${file}`)
  return { subscription, events, errors, expect }
}

module.exports = { fixture, eventually, watch, state, delay }
