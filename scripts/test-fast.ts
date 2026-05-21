// Explicit pre-push allowlist. Keep this to deterministic unit and broker fake-driver tests;
// slow CLI subprocess suites and integration-tests stay on the full/integration paths.
const fastSuiteArgs = [
  'test',
  'packages/agent-scope',
  'packages/agent-spaces',
  'packages/cli-kit',
  'packages/config',
  'packages/execution',
  'packages/harness-claude',
  'packages/harness-codex',
  'packages/harness-pi',
  'packages/harness-pi-sdk',
  'packages/harness-broker-protocol',
  'packages/harness-broker-client',
  'packages/harness-broker',
  'packages/runtime',
  'packages/cli/src/index.test.ts',
  'packages/cli/src/commands/agent/__tests__/build-bundle-ref-agent-project.test.ts',
]

const cleanEnv = { ...process.env }
cleanEnv.GIT_DIR = undefined
cleanEnv.GIT_WORK_TREE = undefined

const proc = Bun.spawn(['bun', ...fastSuiteArgs], {
  cwd: `${import.meta.dir}/..`,
  env: cleanEnv,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
