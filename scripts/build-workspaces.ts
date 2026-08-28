import { availableParallelism } from 'node:os'

import { discoverWorkspacePackages, topologicalWorkspaceLayers } from './lib/workspace-graph.ts'

const root = `${import.meta.dir}/..`
const requestedConcurrency = Number.parseInt(
  process.env['ASP_BUILD_CONCURRENCY'] ?? String(Math.min(6, availableParallelism())),
  10
)
const concurrency =
  Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1

interface BuildResult {
  name: string
  exitCode: number
  durationMs: number
  output: string
}

async function build(
  workspace: Awaited<ReturnType<typeof discoverWorkspacePackages>>[number]
): Promise<BuildResult> {
  const started = performance.now()
  const child = Bun.spawn(['bun', 'run', 'build'], {
    cwd: workspace.absolutePath,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    name: workspace.name,
    exitCode,
    durationMs: performance.now() - started,
    output: `${stdout}${stderr}`,
  }
}

async function buildLayer(
  layer: Awaited<ReturnType<typeof discoverWorkspacePackages>>
): Promise<BuildResult[]> {
  const results: BuildResult[] = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, layer.length) }, async () => {
    while (nextIndex < layer.length) {
      const workspace = layer[nextIndex]
      nextIndex += 1
      if (!workspace) return
      results.push(await build(workspace))
    }
  })
  await Promise.all(workers)
  return results.sort((left, right) => left.name.localeCompare(right.name))
}

const packages = (await discoverWorkspacePackages(root)).filter(
  (workspace) => typeof workspace.scripts.build === 'string'
)
const layers = topologicalWorkspaceLayers(packages)
const started = performance.now()

console.log(
  `[build] ${packages.length} workspaces in ${layers.length} dependency layers (concurrency=${concurrency})`
)
for (const [index, layer] of layers.entries()) {
  const results = await buildLayer(layer)
  for (const result of results) {
    if (result.output.trim() !== '') process.stdout.write(result.output)
    console.log(
      `[build] ${result.name} ${result.exitCode === 0 ? 'passed' : 'failed'} ${(result.durationMs / 1000).toFixed(2)}s`
    )
  }
  const failures = results.filter((result) => result.exitCode !== 0)
  if (failures.length > 0) {
    console.error(
      `[build] layer ${index + 1} failed: ${failures.map(({ name }) => name).join(', ')}`
    )
    process.exit(1)
  }
}

console.log(`[build] completed in ${((performance.now() - started) / 1000).toFixed(2)}s`)
