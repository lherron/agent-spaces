// Explicit pre-push allowlist. Keep this to deterministic unit and broker fake-driver tests;
// slow CLI subprocess suites and integration-tests stay on the full/integration paths.
const FAST_TEST_TIMEOUT_MS = 60_000

const fastSuiteArgs = [
  'test',
  `--timeout=${FAST_TEST_TIMEOUT_MS}`,
  'contracts/agent-scope',
  'compiler/agent-spaces',
  'apps/turn-runner',
  'apps/cli-kit',
  'core/config',
  'drivers/execution',
  'drivers/harness-claude',
  'drivers/harness-codex',
  'drivers/harness-pi',
  'drivers/harness-pi-sdk',
  'contracts/harness-broker-protocol',
  'contracts/aspc-protocol',
  'contracts/harness-broker-client',
  'harness/harness-broker',
  'harness/harness-broker-pi-sdk',
  'harness/agent-harness-sdk',
  'harness/agent-harness',
  'harness/aspc',
  'core/runtime',
  'apps/cli/src/index.test.ts',
  'apps/cli/src/commands/agent/__tests__/build-bundle-ref-agent-project.test.ts',
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
