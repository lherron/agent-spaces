import { scanTestCloneCommands } from './lib/test-no-git-clone.ts'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/u, '')
const findings = await scanTestCloneCommands(root)

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: repository cloning is forbidden in tests and test execution paths`
    )
  }
  process.exit(1)
}

console.log('Test Git clone boundary check passed.')
