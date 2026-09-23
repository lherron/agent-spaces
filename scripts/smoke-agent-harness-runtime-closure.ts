#!/usr/bin/env bun
/** Exercise the published Pi runtime from a fresh registry-only consumer. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const version = process.argv[2]
const registry = process.argv[3] ?? 'http://mini:4873'
if (!version || !/^0\.1\.1-dev\.[0-9]+$/.test(version)) {
  throw new Error('usage: smoke-agent-harness-runtime-closure.ts <exact-release> [registry-url]')
}
const root = mkdtempSync(join(tmpdir(), 'agent-harness-runtime-closure-'))
writeFileSync(join(root, '.npmrc'), `registry=${registry}\n`)
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies: { 'agent-harness-runtime': version, 'agent-harness': version },
    },
    null,
    2
  )
)

function command(cmd: string[], cwd = root): string {
  const result = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed (${result.exitCode}):\n${output}`)
  return output.trim()
}

command(['bun', 'install'])
command(['bun', 'install', '--frozen-lockfile'])
const lock = readFileSync(join(root, 'bun.lock'), 'utf8')
if (!lock.includes(version)) throw new Error('exact release missing from consumer lock')
const lockPackages = (Bun.JSONC.parse(lock) as { packages: Record<string, unknown[]> }).packages
const releasePackages = Object.entries(lockPackages)
  .filter(
    ([name, value]) =>
      /^(?:agent-harness|agent-scope|spaces-)/.test(name) &&
      String(value[0]).endsWith(`@${version}`)
  )
  .map(([name, value]) => ({ name, version, url: value[1], integrity: value.at(-1) }))
const packageName = 'agent-harness-runtime'
const visited = new Set<string>()
const closure: string[] = []
function resolveManifest(from: string, name: string): string {
  let dir = from
  while (true) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (Bun.file(candidate).size > 0) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Could not resolve ${name} from ${from}`)
    dir = parent
  }
}
function walk(name: string, from: string): void {
  const path = resolveManifest(from, name)
  if (visited.has(path)) return
  visited.add(path)
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    name: string
    version: string
    dependencies?: Record<string, string>
  }
  closure.push(`${manifest.name}@${manifest.version}`)
  for (const dep of Object.keys(manifest.dependencies ?? {})) walk(dep, dirname(path))
}
walk(packageName, root)
const forbiddenDeps = closure.filter((name) => name.startsWith('spaces-harness-codex@'))

const entry = join(root, 'closure-entry.ts')
writeFileSync(entry, "export * from 'agent-harness-runtime'\n")
const build = await Bun.build({
  entrypoints: [entry],
  target: 'bun',
  outdir: join(root, 'bundle'),
  sourcemap: 'external',
})
if (!build.success)
  throw new Error(`bundle failed: ${build.logs.map((log) => log.message).join('; ')}`)
const map = build.outputs.find((output) => output.kind === 'sourcemap')
if (!map) throw new Error('bundle emitted no source map')
const sources = (JSON.parse(readFileSync(map.path, 'utf8')) as { sources: string[] }).sources
const forbiddenModules = sources.filter((source) =>
  /(?:spaces-harness-codex|spaces-execution\/dist\/run-codex|spaces-execution\/dist\/run\/space-codex-model|spaces-harness-codex\/.*(?:codex-session|codex-adapter|rpc-client))/.test(
    source
  )
)

const smoke = join(root, 'pi-smoke.ts')
const agentRoot = join(root, 'agent')
mkdirSync(agentRoot)
writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 4\n')
writeFileSync(join(agentRoot, 'SOUL.md'), '# Probe\n')
writeFileSync(
  smoke,
  `import { loadAgent, createAgentHarnessRuntime } from 'agent-harness-runtime'\nimport { createResidentSurfaceController } from 'agent-harness'\nconst agent = await loadAgent({ agentId: 'probe', agentRoot: ${JSON.stringify(agentRoot)}, aspHome: ${JSON.stringify(join(root, 'asp-home'))}, model: 'gpt-5.6-sol', provider: 'openai-codex', baseEnvironment: { PATH: process.env.PATH ?? '' } })\nif (agent.agentId !== 'probe' || agent.model.piProvider !== 'openai-codex') throw new Error('Pi loadAgent returned wrong identity/model')\nif (typeof createAgentHarnessRuntime !== 'function' || typeof createResidentSurfaceController !== 'function') throw new Error('Pi runtime/resident public path missing')\nconst identity = { surfaceId: 'surface', runtimeId: 'runtime', sessionId: 'session', incarnationId: 'incarnation' }\nconst controller = createResidentSurfaceController({ identity, transport: { setReadOnly() {}, detachClient() {} }, disposeHost() {} })\nawait controller.attachClient('first')\nawait controller.detachWriter('quit')\nif (controller.snapshot().disposed || controller.snapshot().identity.sessionId !== 'session') throw new Error('resident detach lost live session')\nawait controller.attachClient('second')\nif (controller.snapshot().writer !== 'second') throw new Error('resident reattach failed')\nawait controller.dispose()\nconsole.log('PI_PUBLIC_PATH_PASS', agent.agentId, agent.model.piModelId, 'RESIDENT_REATTACH_PASS')\n`
)
const smokeOutput = command(['bun', 'run', smoke])
const report = {
  root,
  version,
  registry,
  lock: join(root, 'bun.lock'),
  lockSha256: createHash('sha256').update(lock).digest('hex'),
  releasePackages,
  runtimeManifest: JSON.parse(readFileSync(resolveManifest(root, packageName), 'utf8')),
  dependencyClosure: closure.sort(),
  forbiddenDeps,
  moduleCount: sources.length,
  forbiddenModules,
  smokeOutput,
  verdict: forbiddenDeps.length === 0 && forbiddenModules.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (report.verdict !== 'PASS') process.exitCode = 1
