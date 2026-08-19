import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { writeClaudeHooksJson } from '../packages/config/src/materializer/hooks-toml.js'
import { writeMcpConfig } from '../packages/config/src/materializer/mcp-composer.js'
import { writePluginJson } from '../packages/config/src/materializer/plugin-json.js'
import { writeSettingsFile } from '../packages/config/src/materializer/settings-composer.js'
import { writeCacheMetadataAt } from '../packages/config/src/store/cache.js'
import { prepareCodexRuntimeHome } from '../packages/execution/src/run-codex.js'
import { CodexAdapter } from '../packages/harness-codex/src/adapters/codex-adapter.js'

const REPO_ROOT = join(import.meta.dir, '..')

const CANONICAL_JSON_HOME = 'packages/spaces-runtime-contracts/src/hash.ts'
const FORMER_CANONICAL_JSON_SITES = [
  'packages/aspc/src/manifest.ts',
  'packages/config/src/orchestration/install.ts',
  'packages/execution/src/run-codex.ts',
  'packages/harness-codex/src/adapters/codex-hooks.ts',
] as const

const HASH_MATERIAL_ORDERING_FILES = [
  'packages/config/src/orchestration/install.ts',
  'packages/config/src/resolver/filesystem-registry.ts',
  'packages/config/src/resolver/integrity.ts',
  // Snapshot verification must match resolver/integrity.ts byte-for-byte.
  'packages/config/src/store/snapshot.ts',
] as const

const AMBIENT_CLOCK_FILES = [
  'packages/config/src/core/types/lock.ts',
  'packages/config/src/materializer/materialize.ts',
  'packages/config/src/orchestration/install.ts',
  'packages/config/src/resolver/lock-generator.ts',
  'packages/config/src/store/temp-lifecycle.ts',
] as const

const ARTIFACT_WRITER_ROOTS = [
  'packages/config/src/materializer',
  'packages/config/src/store',
  'packages/execution/src/run-codex.ts',
] as const

const REQUIRED_ARTIFACT_WRITERS = new Set([
  'prepareCodexRuntimeHome',
  'writeCacheMetadataAt',
  'writeClaudeHooksJson',
  'writeCodexRuntimeMetadata',
  'writeMcpConfig',
  'writePluginJson',
  'writeSettingsFile',
])

const ARTIFACT_WRITER_EXCLUSIONS = new Map([
  ['writeCacheMetadata', 'delegates byte emission to the covered writeCacheMetadataAt writer'],
  [
    'writeRuntimeSystemPromptArtifact',
    'preserves caller-owned prompt bytes exactly; its content hash covers those exact bytes',
  ],
])

let cleanupRoot: string | undefined

afterEach(async () => {
  if (cleanupRoot !== undefined) {
    await rm(cleanupRoot, { recursive: true, force: true })
    cleanupRoot = undefined
  }
})

function parseSource(text: string, fileName = 'fixture.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

async function readSource(relativePath: string): Promise<ts.SourceFile> {
  const absolutePath = join(REPO_ROOT, relativePath)
  return parseSource(await readFile(absolutePath, 'utf8'), absolutePath)
}

function visit(node: ts.Node, inspect: (candidate: ts.Node) => void): void {
  inspect(node)
  node.forEachChild((child) => visit(child, inspect))
}

function isNamedPropertyCall(node: ts.Node, owner: string, property: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === owner &&
    node.expression.name.text === property
  )
}

function findObjectKeysSorts(sourceFile: ts.SourceFile): number[] {
  const positions: number[] = []
  visit(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'sort' &&
      isNamedPropertyCall(node.expression.expression, 'Object', 'keys')
    ) {
      positions.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
  })
  return positions
}

function importsSharedCanonicalizer(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'spaces-runtime-contracts' &&
      statement.importClause !== undefined &&
      statement.importClause.isTypeOnly === false
  )
}

function findLocaleCompareCalls(sourceFile: ts.SourceFile): number[] {
  const positions: number[] = []
  visit(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'localeCompare'
    ) {
      positions.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
  })
  return positions
}

function findAmbientClockReads(sourceFile: ts.SourceFile): number[] {
  const positions: number[] = []
  visit(sourceFile, (node) => {
    const isDateNow = isNamedPropertyCall(node, 'Date', 'now')
    const isZeroArgumentDate =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      (node.arguments?.length ?? 0) === 0
    if ((isDateNow || isZeroArgumentDate) && !isInjectedClockFallback(node)) {
      positions.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
  })
  return positions
}

function isInjectedClockFallback(node: ts.Node): boolean {
  const injectedClock = /\b(?:compileContext|nowIso|clock)\b|\.now\b/
  let ancestor = node.parent
  while (ancestor && !ts.isStatement(ancestor)) {
    if (
      ts.isBinaryExpression(ancestor) &&
      ancestor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      node.pos >= ancestor.right.pos &&
      node.end <= ancestor.right.end &&
      injectedClock.test(ancestor.left.getText())
    ) {
      return true
    }
    if (ts.isConditionalExpression(ancestor) && injectedClock.test(ancestor.condition.getText())) {
      return true
    }
    ancestor = ancestor.parent
  }
  return false
}

type OutputExclusion = {
  kind: string
  value: string | undefined
  reason: string | undefined
}

function objectStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): string | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText() === name
  )
  return property && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined
}

function parseOutputExclusions(sourceFile: ts.SourceFile): OutputExclusion[] {
  let declarations: OutputExclusion[] = []
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== 'DECLARED_OUTPUT_EXCLUSIONS' ||
      !node.initializer ||
      !ts.isArrayLiteralExpression(node.initializer)
    ) {
      return
    }
    declarations = node.initializer.elements.flatMap((element) => {
      if (!ts.isObjectLiteralExpression(element)) return []
      const matcherProperty = element.properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) && candidate.name.getText() === 'matcher'
      )
      if (!matcherProperty || !ts.isObjectLiteralExpression(matcherProperty.initializer)) return []
      const matcher = matcherProperty.initializer
      return [
        {
          kind: objectStringProperty(matcher, 'kind') ?? '',
          value: objectStringProperty(matcher, 'path') ?? objectStringProperty(matcher, 'filename'),
          reason: objectStringProperty(element, 'reason'),
        },
      ]
    })
  })
  return declarations
}

function nonLockOutputExclusions(sourceFile: ts.SourceFile): OutputExclusion[] {
  return parseOutputExclusions(sourceFile).filter((entry) => {
    if (entry.reason !== 'ephemeral-lock') return true
    if (entry.kind === 'bundle-scope-lock') return false
    return entry.value?.endsWith('.lock') !== true
  })
}

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const absoluteRoot = join(REPO_ROOT, root)
  if (root.endsWith('.ts')) return [absoluteRoot]
  const entries = await readdir(absoluteRoot, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(absoluteRoot, entry.name)
      if (entry.isDirectory()) return productionTypeScriptFiles(relative(REPO_ROOT, path))
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [path]
      return []
    })
  )
  return nested.flat()
}

function artifactWriterNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = []
  visit(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name) return
    if (node.name.text.startsWith('write') || node.name.text === 'prepareCodexRuntimeHome') {
      names.push(node.name.text)
    }
  })
  return names
}

function undeclaredArtifactWriters(sourceFile: ts.SourceFile): string[] {
  return artifactWriterNames(sourceFile).filter(
    (name) => !REQUIRED_ARTIFACT_WRITERS.has(name) && !ARTIFACT_WRITER_EXCLUSIONS.has(name)
  )
}

function hasExactlyOneTrailingNewline(content: string): boolean {
  return content.endsWith('\n') && !content.endsWith('\n\n')
}

async function renderDateInTimezone(nowIso: string, timezone: string): Promise<string> {
  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'packages/runtime/src/template-vars.ts')).href
  const script = `
    import { interpolateVariables } from ${JSON.stringify(moduleUrl)}
    const output = interpolateVariables('{{date}}|{{dateUtc}}', {
      agentRoot: '/agent',
      agentsRoot: '/agents',
      runMode: 'test',
      now: new Date(process.env.PINNED_NOW),
    })
    process.stdout.write(output)
  `
  const child = Bun.spawn([process.execPath, '--eval', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, PINNED_NOW: nowIso, TZ: timezone },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, stderr).toBe(0)
  return stdout
}

async function composeCodexToml(serverOrder: string[], outputRoot: string): Promise<string> {
  const artifactRoot = join(outputRoot, 'artifact')
  await mkdir(join(artifactRoot, 'mcp'), { recursive: true })
  const mcpServers: Record<string, { type: 'stdio'; command: string }> = {}
  for (const serverName of serverOrder) {
    mcpServers[serverName] = { type: 'stdio', command: `run-${serverName}` }
  }
  await writeFile(
    join(artifactRoot, 'mcp', 'mcp.json'),
    `${JSON.stringify({ mcpServers }, null, 2)}\n`
  )

  const adapter = new CodexAdapter()
  await adapter.composeTarget(
    {
      targetName: 'epoch-test',
      compose: [],
      roots: [],
      loadOrder: [],
      artifacts: [
        {
          spaceKey: 'epoch-test@abc123' as never,
          spaceId: 'epoch-test',
          artifactPath: artifactRoot,
          pluginName: 'epoch-test',
          pluginVersion: '1.0.0',
        },
      ],
      settingsInputs: [],
    },
    join(outputRoot, 'output'),
    { clean: true }
  )
  return readFile(join(outputRoot, 'output', 'codex.home', 'config.toml'), 'utf8')
}

describe('P0 single blessed hash epoch acceptance', () => {
  test('A1: one shared canonical JSON implementation owns every former call site', async () => {
    const fixture = parseSource(`
      function localCanonical(value: Record<string, unknown>) {
        return Object.keys(value).sort().map((key) => JSON.stringify(value[key]))
      }
    `)
    expect(findObjectKeysSorts(fixture)).toHaveLength(1)

    const home = await readSource(CANONICAL_JSON_HOME)
    expect(
      findObjectKeysSorts(home),
      `${CANONICAL_JSON_HOME} must own canonical key ordering`
    ).toHaveLength(1)

    const residual: string[] = []
    const missingImports: string[] = []
    for (const relativePath of FORMER_CANONICAL_JSON_SITES) {
      const sourceFile = await readSource(relativePath)
      for (const line of findObjectKeysSorts(sourceFile)) residual.push(`${relativePath}:${line}`)
      if (!importsSharedCanonicalizer(sourceFile)) missingImports.push(relativePath)
    }
    expect(residual, 'local canonical-JSON implementations remain').toEqual([])
    expect(
      missingImports,
      'former sites must import the shared runtime-contract implementation'
    ).toEqual([])
  })

  test('A2: hash-material ordering uses codepoint order without localeCompare', async () => {
    const fixture = parseSource('values.sort((left, right) => left.path.localeCompare(right.path))')
    expect(findLocaleCompareCalls(fixture)).toHaveLength(1)

    const violations: string[] = []
    for (const relativePath of HASH_MATERIAL_ORDERING_FILES) {
      const sourceFile = await readSource(relativePath)
      for (const line of findLocaleCompareCalls(sourceFile))
        violations.push(`${relativePath}:${line}`)
    }
    expect(violations, 'ICU-dependent ordering remains in hash material').toEqual([])
  })

  test('B1: compiler output clocks are injected and Mode B exclusions bless locks only', async () => {
    const fixture = parseSource('const now = Date.now(); const stamp = new Date().toISOString()')
    expect(findAmbientClockReads(fixture)).toHaveLength(2)
    const injectedFallback = parseSource(
      'const stamp = options.compileContext?.nowIso ?? new Date().toISOString()'
    )
    expect(findAmbientClockReads(injectedFallback)).toEqual([])

    const ambientReads: string[] = []
    for (const relativePath of AMBIENT_CLOCK_FILES) {
      const sourceFile = await readSource(relativePath)
      for (const line of findAmbientClockReads(sourceFile))
        ambientReads.push(`${relativePath}:${line}`)
    }
    expect(ambientReads, 'listed compiler output paths still read the ambient clock').toEqual([])

    const manifestSource = await readSource('packages/aspc/src/manifest.ts')
    expect(parseOutputExclusions(manifestSource).length).toBeGreaterThan(0)
    expect(
      nonLockOutputExclusions(manifestSource),
      'Mode B may exclude lock artifacts only'
    ).toEqual([])

    const invalidExclusion = parseSource(`
      const DECLARED_OUTPUT_EXCLUSIONS = [
        { matcher: { kind: 'exact-path', path: 'output.json' }, reason: 'generated-metadata' },
      ]
    `)
    expect(nonLockOutputExclusions(invalidExclusion)).toHaveLength(1)
  })

  test('B2: date variables are deterministic functions of the injected UTC clock', async () => {
    const first = await renderDateInTimezone('2026-01-02T01:02:03.000Z', 'Pacific/Honolulu')
    const second = await renderDateInTimezone('2026-07-04T23:59:58.000Z', 'Pacific/Kiritimati')

    expect(first).toBe('2026-01-02|2026-01-02T01:02:03.000Z')
    expect(second).toBe('2026-07-04|2026-07-04T23:59:58.000Z')
    expect(first).not.toBe(second)
  })

  test('C1: Codex TOML bytes are key-sorted independent of insertion order', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'p0-sorted-toml-'))
    const composeRoot = join(cleanupRoot, 'compose')
    const forward = await composeCodexToml(['alpha', 'omega'], composeRoot)
    const reverse = await composeCodexToml(['omega', 'alpha'], composeRoot)

    expect(forward).toBe(reverse)
    expect(hasExactlyOneTrailingNewline(forward)).toBe(true)
  })

  test('C2: artifact writer census emits exactly one trailing newline', async () => {
    const discovered = new Set<string>()
    for (const root of ARTIFACT_WRITER_ROOTS) {
      for (const absolutePath of await productionTypeScriptFiles(root)) {
        const sourceFile = parseSource(await readFile(absolutePath, 'utf8'), absolutePath)
        for (const name of artifactWriterNames(sourceFile)) discovered.add(name)
        expect(
          undeclaredArtifactWriters(sourceFile),
          `uncensused writer in ${absolutePath}`
        ).toEqual([])
      }
    }
    expect([...discovered].sort()).toEqual(
      [...REQUIRED_ARTIFACT_WRITERS, ...ARTIFACT_WRITER_EXCLUSIONS.keys()].sort()
    )
    expect(
      undeclaredArtifactWriters(
        parseSource(
          `async function writeUnregisteredArtifact() { await writeFile('x.json', '{}') }`
        )
      )
    ).toEqual(['writeUnregisteredArtifact'])

    cleanupRoot = await mkdtemp(join(tmpdir(), 'p0-artifact-newlines-'))
    const pluginRoot = join(cleanupRoot, 'plugin')
    const settingsPath = join(cleanupRoot, 'settings.json')
    const mcpPath = join(cleanupRoot, 'mcp.json')
    const hooksRoot = join(cleanupRoot, 'hooks')
    const cacheRoot = join(cleanupRoot, 'cache')
    await mkdir(hooksRoot, { recursive: true })

    await writePluginJson({ schema: 1, id: 'epoch-test' as never }, pluginRoot)
    await writeSettingsFile({ model: 'gpt-5' }, settingsPath)
    await writeMcpConfig({ mcpServers: {} }, mcpPath)
    await writeClaudeHooksJson([], hooksRoot)
    await writeCacheMetadataAt(cacheRoot, {
      pluginName: 'epoch-test',
      pluginVersion: '1.0.0',
      integrity: 'sha256:abc' as never,
      cacheKey: 'cache-key',
      createdAt: '2026-01-02T01:02:03.000Z',
      spaceKey: 'epoch-test@abc123' as never,
    })

    const templateHome = join(cleanupRoot, 'template-home')
    const bundleRoot = join(cleanupRoot, 'bundle')
    const projectRoot = join(cleanupRoot, 'project')
    await mkdir(templateHome, { recursive: true })
    await mkdir(bundleRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), 'agent instructions\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5"\n')
    await writeFile(join(templateHome, 'hooks.json'), '{}\n')
    const runtimeHome = await prepareCodexRuntimeHome(
      {
        targetName: 'epoch-test',
        rootDir: bundleRoot,
        codex: { homeTemplatePath: templateHome },
      } as never,
      {
        aspHome: join(cleanupRoot, 'asp-home'),
        cwd: projectRoot,
        projectPath: projectRoot,
        interactive: true,
        codexRuntimeTargetName: 'epoch-test',
      } as never
    )

    const artifacts = [
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      settingsPath,
      mcpPath,
      join(hooksRoot, 'hooks.json'),
      join(cacheRoot, '.asp-cache.json'),
      join(runtimeHome, '.asp-runtime.json'),
      join(runtimeHome, 'hooks.json'),
    ]
    const invalid: string[] = []
    for (const artifactPath of artifacts) {
      const content = await readFile(artifactPath, 'utf8')
      if (!hasExactlyOneTrailingNewline(content)) invalid.push(relative(REPO_ROOT, artifactPath))
    }
    expect(invalid, 'artifact bytes must end in exactly one newline').toEqual([])
  })
})
