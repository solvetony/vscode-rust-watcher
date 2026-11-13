#!/usr/bin/env node
'use strict'

const installer = require('../lib/install.cjs')

function main () {
  const [command, ...args] = process.argv.slice(2)
  const flags = {}
  const switches = ['--json', '--enable-auto', '--live', '--all', '--disable-auto']
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (switches.includes(key)) flags[key] = true
    else if (['--server-root', '--config', '--output'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) flags[key] = args[++i]
    else throw new Error(`unknown or incomplete argument: ${key}`)
  }
  let result
  if (command === 'discover') result = installer.discover()
  else if (command === 'package') result = installer.packageImage(flags['--output'], flags['--config'])
  else if (command === 'install') result = installer.install(flags['--server-root'], flags['--config'], flags['--enable-auto'])
  else if (command === 'verify') {
    if (!flags['--server-root']) throw new Error('verify requires --server-root PATH')
    result = installer.verify(flags['--server-root'])
  } else if (command === 'status') result = installer.status(flags['--server-root'], flags['--live'])
  else if (command === 'restore') {
    if (!flags['--all']) throw new Error('restore requires --all')
    result = installer.restore(flags['--disable-auto'])
  } else if (command === 'doctor') result = installer.doctor()
  else throw new Error('usage: watcherctl package --output FILE [--config FILE] | discover [--json] | install --server-root PATH --config FILE [--enable-auto] | verify --server-root PATH | status [--server-root PATH] --live | restore --all --disable-auto | doctor')
  console.log(JSON.stringify(result, null, 2))
}

try { main() } catch (error) { console.error(`[rust-watcher] ${error.message}`); process.exitCode = 1 }
