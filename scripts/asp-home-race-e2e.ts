/**
 * Concurrent ASP_HOME writers E2E (T-11833).
 *
 *   bun scripts/asp-home-race-e2e.ts <base> <out> <lock|snapshot> [n]
 *     Seed the T-11825 path-marker fixture at <base>, add n agents that each
 *     compose their own @dev space (scenario `lock`), plus the shared
 *     git-pinned space (scenario `snapshot`), then start
 *     n separate processes that compile one agent each, released together from
 *     one barrier, on the one scratch ASP_HOME. Writes <out>/result.json and
 *     exits 0 only when:
 *     - every compile succeeded (two cold writers of the same pinned snapshot
 *       both win: losing the content-addressed rename is not an error), and
 *     - global-lock.json holds every agent's space entry and target (the
 *       read-merge-write is serialized, so no merged entry is lost).
 *
 *   bun scripts/asp-home-race-e2e.ts child <base> <agent>
 *     One compile process (internal).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import {
  type Fixture,
  compileRequest,
  compilerRuntime,
  createFixture,
  loadAsp,
  writeAgent,
  writeSpace,
} from './path-markers-e2e.ts'

// Usage metrics from this script and its children stay out of the real day files (T-11824).
isolateUsageMetrics()

const raceAgent = (i: number) => `pm-race-${i}`
const raceSpace = (i: number) => `pm-race-space-${i}`

function fixtureAt(base: string): Fixture {
  return {
    base,
    agentsRoot: join(base, 'agents'),
    projectRoot: join(base, 'project'),
    aspHome: join(base, 'asp-home'),
  }
}

async function child(base: string, agent: string): Promise<void> {
  const asp = await loadAsp()
  const fixture = fixtureAt(base)
  const client = asp.compiler.createAgentSpacesClient({
    aspHome: fixture.aspHome,
    runtime: compilerRuntime(asp),
  })
  const request = compileRequest(asp, fixture, {
    id: agent,
    requested: { harness: 'claude', presentation: true },
    agent,
  })
  writeFileSync(join(base, 'barrier', `${agent}.ready`), '')
  while (!existsSync(join(base, 'barrier', 'go'))) await Bun.sleep(2)
  let outcome: Record<string, unknown>
  try {
    const result = (await client.compileRuntimePlan(request)) as {
      ok?: boolean
      diagnostics?: unknown
    }
    outcome = result.ok === true ? { ok: true } : { ok: false, diagnostics: result.diagnostics }
  } catch (error) {
    outcome = { ok: false, threw: String(error) }
  }
  process.stdout.write(`${JSON.stringify({ agent, ...outcome })}\n`)
}

type Scenario = 'lock' | 'snapshot'

async function race(base: string, out: string, scenario: Scenario, n: number): Promise<number> {
  const asp = await loadAsp()
  const fixture = createFixture(asp, base)
  const pinnedSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: new asp.config.PathResolver({ aspHome: fixture.aspHome }).immutableRepository(
      asp.config.PORTABLE_SPACES_REGISTRY.repository
    ),
  })
    .stdout.toString()
    .trim()
  for (let i = 0; i < n; i++) {
    writeSpace(fixture.agentsRoot, raceSpace(i))
    writeAgent(fixture.agentsRoot, raceAgent(i), [
      `space:${raceSpace(i)}@dev`,
      ...(scenario === 'snapshot' ? [`space:pm-pinned@git:${pinnedSha}`] : []),
    ])
  }
  mkdirSync(join(base, 'barrier'), { recursive: true })
  const env = { ...process.env, ASP_HOME: fixture.aspHome, ASP_AGENTS_ROOT: fixture.agentsRoot }
  const children = Array.from({ length: n }, (_, i) => {
    const proc = spawn(process.execPath, [import.meta.path, 'child', base, raceAgent(i)], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    return new Promise<string>((done) => proc.once('exit', () => done(stdout)))
  })
  for (let i = 0; i < n; i++) {
    while (!existsSync(join(base, 'barrier', `${raceAgent(i)}.ready`))) await Bun.sleep(5)
  }
  writeFileSync(join(base, 'barrier', 'go'), '')
  const outcomes = (await Promise.all(children)).map((stdout, i) => {
    const line = stdout.trim().split('\n').at(-1) ?? ''
    try {
      return JSON.parse(line) as { agent: string; ok: boolean }
    } catch {
      return { agent: raceAgent(i), ok: false, stdout }
    }
  })

  const lock = JSON.parse(readFileSync(join(fixture.aspHome, 'global-lock.json'), 'utf8')) as {
    spaces: Record<string, unknown>
    targets: Record<string, { compose: string[] }>
  }
  const missingSpaces: string[] = []
  const missingTargets: string[] = []
  for (let i = 0; i < n; i++) {
    if (!(`${raceSpace(i)}@dev` in lock.spaces)) missingSpaces.push(`${raceSpace(i)}@dev`)
    const ref = `space:${raceSpace(i)}@dev`
    if (!Object.values(lock.targets).some((target) => target.compose.includes(ref))) {
      missingTargets.push(raceAgent(i))
    }
  }
  const failed = outcomes.filter((outcome) => !outcome.ok)
  const result = {
    scenario,
    n,
    compiles: { ok: n - failed.length, failed },
    globalLock: {
      spaces: Object.keys(lock.spaces).length,
      targets: Object.keys(lock.targets).length,
      missingSpaces,
      missingTargets,
    },
    pass: failed.length === 0 && missingSpaces.length === 0 && missingTargets.length === 0,
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(
    `compiles ok ${result.compiles.ok}/${n}; global-lock missing spaces ${missingSpaces.length}, targets ${missingTargets.length}: ${result.pass ? 'PASS' : 'FAIL'}\n`
  )
  return result.pass ? 0 : 1
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'child' && args.length === 2) {
    await child(args[0] as string, args[1] as string)
  } else if (
    mode !== undefined &&
    mode !== 'child' &&
    (args[1] === 'lock' || args[1] === 'snapshot') &&
    args.length <= 3
  ) {
    process.exit(
      await race(resolve(mode), resolve(args[0] as string), args[1], Number(args[2] ?? '8'))
    )
  } else {
    process.stderr.write(
      'usage: bun scripts/asp-home-race-e2e.ts <base> <out> <lock|snapshot> [n]\n'
    )
    process.exit(2)
  }
}
