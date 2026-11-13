'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')

function procMetrics () {
  let threads = null
  let watches = null
  let processes = null
  try { threads = fs.readdirSync('/proc/self/task').length } catch {}
  try {
    watches = 0
    for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
      try {
        const content = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
        watches += content.split('\n').filter(line => line.startsWith('inotify wd:')).length
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  } catch { watches = null }
  try {
    const pending = [process.pid]
    const seen = new Set()
    while (pending.length && seen.size < 1024) {
      const pid = pending.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      for (const thread of fs.readdirSync(`/proc/${pid}/task`)) {
        const children = fs.readFileSync(`/proc/${pid}/task/${thread}/children`, 'utf8').trim()
        if (children) pending.push(...children.split(/\s+/).map(Number))
      }
    }
    if (!pending.length) processes = seen.size
  } catch {}
  return { rss: process.memoryUsage().rss, threads, processes, activeWatches: watches }
}

async function child () {
  const [module, root, mutate, ignoreJson] = process.argv.slice(3)
  delete process.env.RUST_WATCHER_CONFIG
  const watcher = require(module)
  const latency = []
  const sent = new Map()
  let failure
  let eventCount = 0
  const start = performance.now()
  const cpuStart = process.cpuUsage()
  const subscription = await watcher.subscribe(root, (error, events) => {
    failure ||= error
    eventCount += events.length
    for (const event of events) {
      if (sent.has(event.path)) { latency.push(performance.now() - sent.get(event.path)); sent.delete(event.path) }
    }
  }, { backend: 'inotify', ignore: JSON.parse(ignoreJson) })
  const startup = { wallMs: performance.now() - start, cpuMicros: process.cpuUsage(cpuStart), ...procMetrics() }
  await delay(300)
  const idleStart = performance.now()
  const idleCpu = process.cpuUsage()
  await delay(1500)
  const idle = { wallMs: performance.now() - idleStart, cpuMicros: process.cpuUsage(idleCpu), ...procMetrics() }
  idle.oneCorePercent = 100 * (idle.cpuMicros.user + idle.cpuMicros.system) / (idle.wallMs * 1000)
  const churnStart = performance.now()
  const churnCpu = process.cpuUsage()
  if (mutate === 'yes') {
    for (let i = 0; i < 100; i++) {
      const file = path.join(root, `workload-${i}`)
      sent.set(file, performance.now())
      fs.writeFileSync(file, 'one')
      await delay(3)
    }
    for (let i = 0; i < 100 && sent.size; i++) await delay(20)
    if (sent.size) throw new Error(`benchmark missed ${sent.size} final creates`)
  }
  const churn = { wallMs: performance.now() - churnStart, cpuMicros: process.cpuUsage(churnCpu), ...procMetrics(), eventCount }
  if (failure) throw failure
  const stats = typeof watcher.diagnostics === 'function' ? watcher.diagnostics() : { queuedEvents: null, rescans: null }
  await subscription.unsubscribe()
  latency.sort((a, b) => a - b)
  console.log(JSON.stringify({ node: process.version, root, scope: 'compatible', ignore: JSON.parse(ignoreJson), startup, idle, churn, counters: stats, latencyMs: { samples: latency.length, p50: latency.length ? latency[Math.floor(latency.length * 0.5)] : null, p95: latency.length ? latency[Math.floor(latency.length * 0.95)] : null }, afterUnsubscribe: procMetrics() }))
}

async function main () {
  if (process.argv[2] === '--child') return child()
  const args = process.argv.slice(2)
  let root
  if (args.length) {
    if (args[0] !== '--root' || args.length !== 2) throw new Error('usage: npm run bench -- [--root PATH] (real roots are read only)')
    root = fs.realpathSync(args[1])
  }
  const generated = !root
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-watcher-bench-state-'))
  if (generated) root = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-watcher-bench-'))
  try {
    if (generated) {
      const count = process.env.RUST_WATCHER_LARGE_BENCH === '1' ? 10000 : 200
      for (let i = 0; i < count; i++) {
        fs.mkdirSync(path.join(root, String(i)))
        fs.writeFileSync(path.join(root, String(i), 'file'), 'x')
      }
    }
    const baseline = require('../test/baseline.cjs')()
    if (!baseline) throw new Error('no fingerprint-validated installed Parcel baseline; set RUST_WATCHER_BASELINE to a server root')
    const ignore = JSON.stringify(['**/.codex/**', '**/node_modules/**', '**/.git/objects/**', '**/.git/subtree-cache/**', '**/.next/**', '**/dist/**', '**/build/**', '**/target/**'])
    const results = {}
    for (const [name, module] of [['stock', baseline.file], ['rust', require.resolve('../lib/adapter.cjs')]]) {
      const output = execFileSync(baseline.node, [__filename, '--child', module, root, generated ? 'yes' : 'no', ignore], { encoding: 'utf8', timeout: 120000, env: { ...process.env, RUST_WATCHER_STATE: state } })
      results[name] = JSON.parse(output)
      if (generated) for (let i = 0; i < 100; i++) fs.unlinkSync(path.join(root, `workload-${i}`))
    }
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), generatedFixture: generated, sameServerNode: baseline.node, warmupMs: 300, results, caveat: 'A small-fixture measurement is not evidence of a large-project fix. Stock queue/rescan counters are unavailable.' }, null, 2))
  } finally {
    if (generated) fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(state, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
