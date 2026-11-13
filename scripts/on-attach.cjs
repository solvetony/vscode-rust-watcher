'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const installer = require('../lib/install.cjs')
const diagnostics = require('../lib/diagnostics.cjs')
const project = path.resolve(__dirname, '..')
const marker = path.join(diagnostics.state, 'auto.json')

function selectServer () {
  const candidates = installer.discover()
  const known = new Map(candidates.map(item => [item.server, item]))
  let pid = process.pid
  for (let i = 0; i < 64 && pid > 1; i++) {
    try {
      const executable = fs.readlinkSync(`/proc/${pid}/exe`)
      if (path.basename(executable) === 'node' && known.has(path.dirname(executable))) return path.dirname(executable)
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch { break }
  }
  const active = candidates.filter(item => item.processes.some(proc => ['server', 'fileWatcher'].includes(proc.command)))
  if (active.length !== 1) throw new Error(`cannot select one active server (${active.length} candidates); run discover and install manually`)
  return active[0].server
}

function main () {
  if (process.argv.includes('--image') && !installer.imageAuto()) return
  if (!fs.existsSync(marker)) return
  if (fs.existsSync(path.join(diagnostics.state, 'auto-disabled.json'))) return
  if (process.getuid() === 0) throw new Error('run attach integration as vscode')
  const optIn = installer.read(marker)
  if (optIn.schemaVersion !== 1 || optIn.project !== project) throw new Error('invalid auto-enable marker or source moved; install manually')
  const server = selectServer()
  try {
    if (!installer.buildFresh()) {
      if (fs.existsSync(path.join(project, 'bundle.json'))) throw new Error('image package is incompatible or damaged; rebuild it, no source build will be attempted')
      installer.withLock(() => {
        if (installer.buildFresh()) return
        execFileSync('npm', ['ci'], { cwd: project, stdio: 'inherit' })
        const node = path.join(project, 'node_modules/node/bin/node')
        execFileSync(node, [path.join(project, 'scripts/build.cjs')], { cwd: project, stdio: 'inherit' })
      })
    }
    if (!fs.existsSync(marker)) return
    const result = installer.install(server, optIn.config, false, true)
    console.log(`[rust-watcher] ${result.message}`)
  } catch (error) {
    try { installer.retainStock(server) } catch (restoreError) { console.error(`[rust-watcher] Stock restoration unavailable: ${restoreError.message}`) }
    throw error
  }
}

try { main() } catch (error) { console.error(`[rust-watcher] WARNING: ${error.message}. Stock watcher retained where restoration is possible; no automatic reload.`) }
