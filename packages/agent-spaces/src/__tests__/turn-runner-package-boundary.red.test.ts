import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
const compilerSrc = join(repoRoot, 'packages', 'agent-spaces', 'src')
const turnRunnerSrc = join(repoRoot, 'packages', 'turn-runner', 'src')

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return []

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      ? [path]
      : []
  })
}

describe('spaces-turn-runner package boundary', () => {
  test('AC1: the compiler source contains no SDK imports or session construction', () => {
    const productionSources = sourceFiles(compilerSrc).filter(
      (path) => !path.includes(`${join('src', '__tests__')}/`) && !path.endsWith('.test.ts')
    )
    const forbidden = [
      {
        label: 'spaces-harness-pi-sdk import',
        pattern: /from\s+['"]spaces-harness-pi-sdk(?:\/[^'"]*)?['"]/,
      },
      { label: 'createSession call', pattern: /\bcreateSession\s*\(/ },
      { label: 'PiSession construction', pattern: /\bnew\s+PiSession\s*\(/ },
      { label: 'loadPiSdkBundle call', pattern: /\bloadPiSdkBundle\s*\(/ },
    ]
    const violations = productionSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return forbidden
        .filter(({ pattern }) => pattern.test(source))
        .map(({ label }) => `${relative(repoRoot, path)}: ${label}`)
    })

    expect(violations).toEqual([])
  })

  test('AC2: turn-runner uses only declared agent-spaces package exports', () => {
    const turnRunnerSources = sourceFiles(turnRunnerSrc)
    expect(turnRunnerSources.length).toBeGreaterThan(0)

    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'agent-spaces', 'package.json'), 'utf8')
    ) as { exports?: Record<string, unknown> }
    const declaredExports = Object.keys(manifest.exports ?? {})
    const allowedExports = ['.', './turn-support']
    const imports = turnRunnerSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return Array.from(
        source.matchAll(
          /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](agent-spaces(?:\/[^'"]*)?)['"]/g
        ),
        (match) => ({ path, specifier: match[1] as string })
      )
    })
    expect(imports.length).toBeGreaterThan(0)

    for (const imported of imports) {
      const exportKey =
        imported.specifier === 'agent-spaces'
          ? '.'
          : `.${imported.specifier.slice('agent-spaces'.length)}`
      const location = relative(repoRoot, imported.path)
      expect(allowedExports, `${location}: ${imported.specifier}`).toContain(exportKey)
      expect(declaredExports, `${location}: ${imported.specifier}`).toContain(exportKey)
    }
  })

  test('AC3: relocated turn errors preserve the compiler CodedError identity and code', async () => {
    const [{ createAgentSpacesClient }, { CodedError }] = await Promise.all([
      import('spaces-turn-runner'),
      import('agent-spaces/turn-support'),
    ])
    const client = createAgentSpacesClient()
    let caught: unknown

    try {
      await client.runTurnNonInteractive({
        frontend: 'unsupported-test-frontend',
        cwd: '/tmp',
        prompt: 'coded-error identity probe',
        runId: 'turn-runner-coded-error',
        hostSessionId: 'turn-runner-coded-error',
        callbacks: { onEvent: () => {} },
      } as never)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodedError)
    expect((caught as { code?: string }).code).toBe('unsupported_frontend')
  })

  test('AC4: the turn-runner client exposes compiler capabilities and all turn methods', async () => {
    const [compilerModule, turnRunnerModule] = await Promise.all([
      import('agent-spaces'),
      import('spaces-turn-runner'),
    ])
    const compilerClient = compilerModule.createAgentSpacesClient()
    const turnRunnerClient = turnRunnerModule.createAgentSpacesClient()
    const compilerMethods = Object.entries(compilerClient)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    const turnMethods = [
      'runTurnNonInteractive',
      'runTurnInFlight',
      'queueInFlightInput',
      'interruptInFlightTurn',
    ]

    expect(compilerMethods.length).toBeGreaterThan(0)
    for (const method of [...compilerMethods, ...turnMethods]) {
      expect(turnRunnerClient[method as keyof typeof turnRunnerClient], method).toBeFunction()
    }
  })
})
