'use strict'

const diagnostics = require('./diagnostics.cjs')

exports.load = function (installation) {
  process.env.RUST_WATCHER_SERVER = installation.server
  process.env.RUST_WATCHER_BUILD = installation.build
  if (process.env.RUST_WATCHER_CONFIG === undefined) process.env.RUST_WATCHER_CONFIG = installation.config
  let backend
  let implementation
  let error
  let effectivePolicy = null
  if (process.env.RUST_WATCHER_DISABLE === '1') {
    backend = 'original-bypass'
    implementation = require(installation.original)
    diagnostics.log('fallback', { backend, message: 'RUST_WATCHER_DISABLE=1; restore --all --disable-auto for persistent rollback' })
  } else {
    try {
      effectivePolicy = require('./policy.cjs').load()
      implementation = require('./adapter.cjs')
      backend = 'rust'
    } catch (failure) {
      error = failure.message
      backend = 'fallback'
      diagnostics.log('fallback', { backend, message: error, policyEnforced: false })
      implementation = require(installation.original)
    }
  }
  try {
    diagnostics.health({ backend, error, config: process.env.RUST_WATCHER_CONFIG, policy: backend === 'rust' ? effectivePolicy : null, release: installation.release })
  } catch (failure) {
    diagnostics.log('error', { message: `health record unavailable: ${failure.message}`, backend })
  }
  return implementation
}
