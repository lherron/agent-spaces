#!/usr/bin/env bun
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const child = spawn(
  process.execPath,
  [
    'scripts/pre-hrc-broker-matrix-e2e.ts',
    '--config',
    'real-pi-tui-tmux',
    '--keep-artifacts',
    ...args,
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  }
)

child.on('error', (error) => {
  process.stderr.write(`debug-pi-tui-tmux-live failed: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
