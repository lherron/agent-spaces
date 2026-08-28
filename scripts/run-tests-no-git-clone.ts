import { testGitGuardEnvironment } from './lib/test-git-guard.ts'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const command = separator === -1 ? argv : argv.slice(separator + 1)

if (command.length === 0) {
  console.error('usage: bun scripts/run-tests-no-git-clone.ts -- <test-command> [args...]')
  process.exit(2)
}

const child = Bun.spawn(command, {
  cwd: process.cwd(),
  env: testGitGuardEnvironment(),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}

process.exit(await child.exited)
