'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { fixture, state } = require('./helpers.cjs')
const watcher = require('../lib/adapter.cjs')

test('bounded userspace queue and slow callbacks converge to the final state', async t => {
  const root = await fixture(t)
  const config = path.join(state, 'backpressure.json')
  await fs.writeFile(config, JSON.stringify({ debounceMs: 0, maxBatchSize: 2, maxQueuedEvents: 4, logLevel: 'silent' }))
  const script = 'const fs=require(\'fs\'),path=require(\'path\'),assert=require(\'assert/strict\'),w=require(process.argv[1]);(async()=>{const root=process.argv[2],seen=new Set();let error;const s=await w.subscribe(root,(e,b)=>{error||=e;for(const v of b)if(v.type===\'create\')seen.add(v.path);const until=Date.now()+2;while(Date.now()<until){}});for(let i=0;i<200;i++)fs.writeFileSync(path.join(root,String(i)),\'x\');for(let i=0;i<1000&&seen.size<200;i++)await new Promise(r=>setTimeout(r,5));if(error)throw error;assert.equal(seen.size,200);const stats=w.diagnostics();assert(stats.overflows>0);await s.unsubscribe();console.log(JSON.stringify(stats))})().catch(e=>{console.error(e);process.exitCode=1})'
  const output = execFileSync(process.execPath, ['-e', script, require.resolve('../lib/adapter.cjs'), root], { encoding: 'utf8', env: { ...process.env, RUST_WATCHER_CONFIG: config }, timeout: 15000 })
  assert(JSON.parse(output).overflows > 0)
})

test('opt-in repeated subscription memory and large-fixture soak', { skip: !process.env.RUST_WATCHER_STRESS }, async t => {
  const root = await fixture(t)
  for (let i = 0; i < 2000; i++) {
    await fs.mkdir(path.join(root, String(i)))
    await fs.writeFile(path.join(root, String(i), 'file'), 'x')
  }
  const memory = []
  for (let cycle = 0; cycle < 100; cycle++) {
    const subscription = await watcher.subscribe(root, error => { if (error) throw error })
    await fs.appendFile(path.join(root, String(cycle), 'file'), 'x')
    await subscription.unsubscribe()
    if (cycle % 10 === 0) memory.push({ cycle, rss: process.memoryUsage().rss })
    assert.equal(watcher.diagnostics().activeWatches, 0)
  }
  console.log(JSON.stringify({ repeatedSubscriptionMemory: memory }))
  assert(memory[memory.length - 1].rss - memory[2].rss < 128 * 1024 * 1024, 'unexpected retained-memory growth; RSS is process-wide')
})
