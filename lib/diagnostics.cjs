'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { threadId } = require('node:worker_threads')
const state = process.env.RUST_WATCHER_STATE || '/workspaces/mounted/.vscode-rust-watcher'
const last = new Map()

function startIdentity (pid = process.pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

function privateDirectory (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error(`unsafe state directory: ${dir}`)
}

function atomic (file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${threadId}.${require('node:crypto').randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = fs.openSync(tmp, 'wx', mode)
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, file)
    const directory = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } finally { fs.rmSync(tmp, { force: true }) }
}

function log (kind, details = {}, level = 'info') {
  if (level === 'silent' || (level === 'error' && !['error', 'fallback'].includes(kind))) return
  const now = Date.now()
  if (now - (last.get(kind) || 0) < 1000) return
  last.set(kind, now)
  const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, threadId, kind, ...details }) + '\n'
  try {
    privateDirectory(state)
    const file = path.join(state, 'diagnostics.jsonl')
    if (fs.existsSync(file) && fs.lstatSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, line, { mode: 0o600, flag: fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW })
  } catch (error) { process.stderr.write(`[rust-watcher] diagnostic unavailable: ${error.message}\n`) }
  if (['error', 'fallback', 'overflow', 'inactive'].includes(kind)) process.stderr.write(`[rust-watcher] ${line}`)
}

function health (details) {
  privateDirectory(state)
  const dir = path.join(state, 'health')
  privateDirectory(dir)
  for (const name of fs.readdirSync(dir).slice(0, 256)) {
    const match = /^(\d+)-(\d+)-(\d+)\.json$/.exec(name)
    if (!match) continue
    try {
      if (startIdentity(Number(match[1])) !== match[2]) fs.rmSync(path.join(dir, name), { force: true })
    } catch (error) { if (error.code === 'ENOENT') fs.rmSync(path.join(dir, name), { force: true }) }
  }
  const start = startIdentity()
  const file = path.join(dir, `${process.pid}-${start}-${threadId}.json`)
  atomic(file, JSON.stringify({ pid: process.pid, start, threadId, server: process.env.RUST_WATCHER_SERVER || null, build: process.env.RUST_WATCHER_BUILD || null, timestamp: new Date().toISOString(), ...details }))
  return file
}

module.exports = { state, startIdentity, privateDirectory, atomic, log, health }
