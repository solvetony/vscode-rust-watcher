'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
process.chdir(path.resolve(__dirname, '..'))
if (process.getuid() === 0) throw new Error('build as vscode, not root')
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) throw new Error('build requires Linux x64 glibc')
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('build using Node 24; run npm ci, then npm run build')
process.env.PATH = `/home/vscode/.cargo/bin:${process.env.PATH}`
execFileSync('cargo', ['build', '--release', '--locked'], { stdio: 'inherit' })
fs.mkdirSync('dist', { recursive: true })
const stagedAddon = `dist/.rust_file_watcher.${process.pid}.tmp`
fs.copyFileSync('target/release/librust_file_watcher.so', stagedAddon)
fs.renameSync(stagedAddon, 'dist/rust_file_watcher.node')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inputs = ['LICENSE', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'package.json', 'package-lock.json', ...fs.readdirSync('src').sort().map(name => `src/${name}`), ...fs.readdirSync('lib').sort().map(name => `lib/${name}`), 'scripts/build.cjs']
const metadata = { version: 1, node: process.version, napi: 8, arch: process.arch, libc: process.report.getReport().header.glibcVersionRuntime, rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), inputs: Object.fromEntries(inputs.map(file => [file, hash(file)])), addon: hash('dist/rust_file_watcher.node') }
fs.writeFileSync('dist/build.json', JSON.stringify(metadata, null, 2) + '\n')
require('../dist/rust_file_watcher.node')
console.log('Built dist/rust_file_watcher.node (Node-API 8)')
