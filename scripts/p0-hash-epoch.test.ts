import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { writeClaudeHooksJson } from '../core/config/src/materializer/hooks-toml.js'
import { writeMcpConfig } from '../core/config/src/materializer/mcp-composer.js'
import { writePluginJson } from '../core/config/src/materializer/plugin-json.js'
import { writeSettingsFile } from '../core/config/src/materializer/settings-composer.js'
import { writeCacheMetadataAt } from '../core/config/src/store/cache.js'
import { prepareCodexRuntimeHome } from '../drivers/execution/src/run-codex.js'
import { CodexAdapter } from '../drivers/harness-codex/src/adapters/codex-adapter.js'

const REPO_ROOT = join(import.meta.dir, '..')

const SHARED_CANONICAL_JSON_MODULE = 'spaces-runtime-contracts'
const CANONICAL_JSON_HOME = 'contracts/spaces-runtime-contracts/src/hash.ts'

/**
 * Census sites are keyed `<repo-relative path>#<outermost enclosing declaration>` so the
 * declarations survive unrelated edits that shift line numbers.
 */

/** In-scope residual canonical-JSON implementations: each must collapse into the shared home. */
const MIGRATING_CANONICAL_JSON_SITES = new Map([
  [
    'compiler/agent-spaces/src/agent-inspection.ts#sortJson',
    'sortJson feeds stableHash (sha256 over JSON.stringify) for the inspection seed and contextHash',
  ],
  [
    'compiler/aspc/src/manifest.ts#sortKeys',
    'sortKeys backs the local canonicalJson used for manifest hashes',
  ],
  [
    'core/config/src/orchestration/install.ts#stableJson',
    'local stableJson serializer on the install hash path',
  ],
  [
    'drivers/execution/src/run-codex.ts#stableJson',
    'local stableJson serializer on the codex runtime metadata path',
  ],
  [
    'drivers/harness-codex/src/adapters/codex-hooks.ts#canonicalJson',
    'local canonicalJson serializer on the codex hooks artifact path',
  ],
])

/** Discovered-but-out-of-scope canonicalization sites, each with the reason it is not migrated. */
const CANONICAL_JSON_CENSUS_EXCLUSIONS = new Map([
  [
    'compiler/aspc/src/agent-inspection-authority.ts#sameRecord',
    'Object.keys(...).sort() compares two record key NAME LISTS; it serializes no values',
  ],
  [
    'compiler/agent-spaces/src/compile-runtime-plan.ts#compileBrokerPlan',
    'Object.keys(lockedEnv).sort() emits a sorted key NAME LIST field; it serializes no values',
  ],
  [
    'compiler/agent-spaces/src/compile-runtime-plan.ts#compileForegroundPlan',
    'Object.keys(lockedEnv).sort() emits a sorted key NAME LIST field; it serializes no values',
  ],
  [
    'compiler/agent-spaces/src/compile-runtime-plan.ts#compilePiSdkBrokerPlan',
    'Object.keys(lockedEnv).sort() emits a sorted key NAME LIST field; it serializes no values',
  ],
  [
    'compiler/agent-spaces/src/compile-runtime-plan.ts#compileTmuxBrokerPlan',
    'Object.keys(lockedEnv).sort() emits a sorted key NAME LIST field; it serializes no values',
  ],
  [
    'drivers/harness-codex/src/adapters/codex-adapter.ts#CodexAdapter',
    'Object.keys(mcpConfig.mcpServers).sort() emits a sorted server NAME LIST field; it serializes no values',
  ],
  [
    'harness/harness-broker-pi-sdk/src/driver.ts#canonicalize',
    'live broker structured-response canonicalization; not compiled artifact bytes, and already codepoint-ordered',
  ],
  [
    'contracts/harness-broker-protocol/src/lifecycle.ts#canonicalizeJson',
    'broker lifecycle/resume-token hashing over live process events; not compiled artifact bytes',
  ],
  [
    'harness/harness-broker/src/event-ledger.ts#sortJson',
    'event-ledger row canonicalization for runtime telemetry; not compiled artifact bytes',
  ],
])

/** localeCompare sites that feed a digest or artifact hash: these must become codepoint ordering. */
const HASH_MATERIAL_LOCALE_COMPARE_SITES = new Map([
  [
    'compiler/agent-spaces/src/agent-inspection.ts#sortJson',
    'key order feeds stableHash (sha256) for the inspection seed and contextHash',
  ],
  [
    'core/config/src/orchestration/install.ts#hashDirectory',
    'entry order feeds the sha256 directory hash',
  ],
  [
    'core/config/src/resolver/filesystem-registry.ts#computeFilesystemRegistryCommit',
    'entry order feeds the registry commit sha256',
  ],
  [
    'core/config/src/resolver/integrity.ts#computeFilesystemIntegrity',
    'entry order feeds the canonical integrity representation',
  ],
  [
    'core/config/src/resolver/integrity.ts#computeIntegrity',
    'entry order feeds the canonical integrity representation',
  ],
  [
    'core/config/src/store/snapshot.ts#computeSnapshotIntegrity',
    'entry order must match resolver/integrity.ts byte-for-byte',
  ],
])

/** localeCompare sites that never reach hash material or emitted artifact bytes. */
const DISPLAY_ONLY_LOCALE_COMPARE_SITES = new Map([
  [
    'compiler/agent-spaces/src/agent-inspection.ts#listAgentDirectories',
    'agent-id listing order in inspection output; not hashed',
  ],
  [
    'compiler/agent-spaces/src/compile-runtime-plan.ts#sortHygieneFindings',
    'diagnostic finding order only',
  ],
  ['apps/cli/src/agent-roots.ts#buildAgentRootReport', 'CLI agent-root report ordering'],
  [
    'apps/cli/src/commands/self/lib.ts#filterInjectedEnv',
    'read-side env lookup for `asp self`; emits no artifact bytes',
  ],
  ['apps/cli/src/commands/spaces/list.ts#listSpaces', 'CLI spaces listing order'],
  [
    'core/config/src/lint/hygiene/baseline.ts#writeBaseline',
    'suppression-baseline row order; each entry fingerprint is computed before ordering, and the baseline is lint tooling output',
  ],
  [
    'core/config/src/lint/hygiene/rules/W42x-reference-graph.ts#listFiles',
    'lint traversal order feeding warning order',
  ],
  ['core/config/src/lint/hygiene/run.ts#lintHygiene', 'hygiene warning display order'],
  ['core/config/src/lint/index.ts#lint', 'lint warning display order'],
  ['core/config/src/store/gc.ts#pruneBundleVersions', 'GC deletion tiebreak; emits no bytes'],
  ['harness/harness-broker/src/event-ledger.ts#rewriteLedger', 'runtime telemetry row order'],
  [
    'harness/harness-broker/src/runtime/event-normalize.ts#truncateToBudget',
    'truncation priority for runtime telemetry',
  ],
])

const AMBIENT_CLOCK_FILES = [
  'core/config/src/core/types/lock.ts',
  'core/config/src/materializer/materialize.ts',
  'core/config/src/orchestration/install.ts',
  'core/config/src/resolver/lock-generator.ts',
  'core/config/src/store/temp-lifecycle.ts',
] as const

const ARTIFACT_WRITER_ROOTS = [
  'core/config/src/materializer',
  'core/config/src/store',
  'drivers/execution/src/run-codex.ts',
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

/** Outermost named declaration containing `node`; stable across unrelated edits in the same file. */
function enclosingDeclarationName(node: ts.Node): string {
  let name = '<module>'
  let ancestor: ts.Node | undefined = node.parent
  while (ancestor) {
    if (ts.isFunctionDeclaration(ancestor) && ancestor.name) name = ancestor.name.text
    else if (ts.isClassDeclaration(ancestor) && ancestor.name) name = ancestor.name.text
    else if (ts.isMethodDeclaration(ancestor) && ts.isIdentifier(ancestor.name))
      name = ancestor.name.text
    else if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name))
      name = ancestor.name.text
    ancestor = ancestor.parent
  }
  return name
}

type CensusSite = { key: string; file: string; line: number }

function isCanonicalKeyOrdering(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'sort' &&
    (isNamedPropertyCall(node.expression.expression, 'Object', 'keys') ||
      isNamedPropertyCall(node.expression.expression, 'Object', 'entries'))
  )
}

function isLocaleCompareCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'localeCompare'
  )
}

function fixtureMatches(text: string, match: (candidate: ts.Node) => boolean): number[] {
  const sourceFile = parseSource(text)
  const lines: number[] = []
  visit(sourceFile, (node) => {
    if (match(node)) lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
  })
  return lines
}

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const absoluteRoot = join(REPO_ROOT, root)
  if (root.endsWith('.ts')) return [absoluteRoot]
  const dirents = await readdir(absoluteRoot, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    dirents.map(async (entry) => {
      const path = join(absoluteRoot, entry.name)
      if (entry.isDirectory()) return productionTypeScriptFiles(relative(REPO_ROOT, path))
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [path]
      return []
    })
  )
  return nested.flat()
}

let packageSourceCache: Promise<ts.SourceFile[]> | undefined

/** Every non-test .ts under <root>/<pkg>/src — the census surface required by A1/A2. */
function packageSources(): Promise<ts.SourceFile[]> {
  packageSourceCache ??= (async () => {
    const workspaceRoots = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']
    const grouped = await Promise.all(
      workspaceRoots.flatMap(async (workspaceRoot) => {
        const packageDirs = await readdir(join(REPO_ROOT, workspaceRoot), {
          withFileTypes: true,
        })
        return Promise.all(
          packageDirs
            .filter((entry) => entry.isDirectory())
            .map((entry) => productionTypeScriptFiles(join(workspaceRoot, entry.name, 'src')))
        )
      })
    )
    const absolutePaths = grouped.flat(2).sort()
    return Promise.all(
      absolutePaths.map(async (absolutePath) =>
        parseSource(await readFile(absolutePath, 'utf8'), absolutePath)
      )
    )
  })()
  return packageSourceCache
}

async function collectCensus(match: (candidate: ts.Node) => boolean): Promise<CensusSite[]> {
  const sites: CensusSite[] = []
  for (const sourceFile of await packageSources()) {
    const file = relative(REPO_ROOT, sourceFile.fileName)
    visit(sourceFile, (node) => {
      if (!match(node)) return
      sites.push({
        key: `${file}#${enclosingDeclarationName(node)}`,
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      })
    })
  }
  return sites
}

function formatSites(sites: CensusSite[]): string[] {
  return [...new Set(sites.map((site) => `${site.file}:${site.line}`))].sort()
}

function undeclaredCanonicalSites(sites: CensusSite[]): string[] {
  return formatSites(
    sites.filter(
      (site) =>
        site.file !== CANONICAL_JSON_HOME &&
        !MIGRATING_CANONICAL_JSON_SITES.has(site.key) &&
        !CANONICAL_JSON_CENSUS_EXCLUSIONS.has(site.key)
    )
  )
}

function unclassifiedLocaleCompareSites(sites: CensusSite[]): string[] {
  return formatSites(
    sites.filter(
      (site) =>
        !HASH_MATERIAL_LOCALE_COMPARE_SITES.has(site.key) &&
        !DISPLAY_ONLY_LOCALE_COMPARE_SITES.has(site.key)
    )
  )
}

function importsSharedCanonicalizer(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return false
    if (statement.moduleSpecifier.text !== SHARED_CANONICAL_JSON_MODULE) return false
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) return false
    const bindings = clause.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false
    return bindings.elements.some(
      (element) => element.isTypeOnly === false && /canonical/i.test(element.name.text)
    )
  })
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
  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'core/runtime/src/template-vars.ts')).href
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
    expect(
      fixtureMatches('const a = Object.keys(value).sort()', isCanonicalKeyOrdering)
    ).toHaveLength(1)
    expect(
      fixtureMatches(
        'const b = Object.entries(value).sort(([l], [r]) => (l < r ? -1 : 1))',
        isCanonicalKeyOrdering
      )
    ).toHaveLength(1)
    expect(fixtureMatches('const c = values.sort()', isCanonicalKeyOrdering)).toEqual([])
    expect(
      undeclaredCanonicalSites([
        {
          key: 'core/new-pkg/src/x.ts#canonicalize',
          file: 'core/new-pkg/src/x.ts',
          line: 7,
        },
      ]),
      'an unclassified canonicalizer must be reported'
    ).toEqual(['core/new-pkg/src/x.ts:7'])

    const sites = await collectCensus(isCanonicalKeyOrdering)
    expect(sites.length, 'repo-wide canonicalizer census discovered nothing').toBeGreaterThan(0)

    expect(
      undeclaredCanonicalSites(sites),
      'every canonicalizer under the workspace roots must be declared as migrating or excluded with a reason'
    ).toEqual([])

    const observed = new Set(sites.map((site) => site.key))
    expect(
      [...CANONICAL_JSON_CENSUS_EXCLUSIONS.keys()].filter((key) => !observed.has(key)),
      'stale exclusion: declared out-of-scope canonicalizer no longer exists'
    ).toEqual([])

    expect(
      sites.filter((site) => site.file === CANONICAL_JSON_HOME).length,
      `${CANONICAL_JSON_HOME} must own exactly one canonical key ordering`
    ).toBe(1)

    expect(
      formatSites(sites.filter((site) => MIGRATING_CANONICAL_JSON_SITES.has(site.key))),
      'local canonical-JSON implementations remain'
    ).toEqual([])

    const migratingFiles = [
      ...new Set(
        [...MIGRATING_CANONICAL_JSON_SITES.keys()].flatMap((key) => key.split('#').slice(0, 1))
      ),
    ].sort()
    const missingImports: string[] = []
    for (const relativePath of migratingFiles) {
      if (!importsSharedCanonicalizer(await readSource(relativePath))) {
        missingImports.push(relativePath)
      }
    }
    expect(
      missingImports,
      'former sites must import the shared runtime-contract implementation'
    ).toEqual([])
  })

  test('A2: hash-material ordering uses codepoint order without localeCompare', async () => {
    expect(
      fixtureMatches(
        'values.sort((left, right) => left.path.localeCompare(right.path))',
        isLocaleCompareCall
      )
    ).toHaveLength(1)
    expect(
      fixtureMatches('values.sort((left, right) => (left < right ? -1 : 1))', isLocaleCompareCall)
    ).toEqual([])
    expect(
      unclassifiedLocaleCompareSites([
        {
          key: 'core/new-pkg/src/y.ts#orderThings',
          file: 'core/new-pkg/src/y.ts',
          line: 12,
        },
      ]),
      'an unclassified localeCompare must be reported'
    ).toEqual(['core/new-pkg/src/y.ts:12'])

    const sites = await collectCensus(isLocaleCompareCall)
    expect(sites.length, 'repo-wide localeCompare census discovered nothing').toBeGreaterThan(0)

    expect(
      unclassifiedLocaleCompareSites(sites),
      'every localeCompare under the workspace roots must be classified hash-material or display-only with a reason'
    ).toEqual([])

    const observed = new Set(sites.map((site) => site.key))
    expect(
      [...DISPLAY_ONLY_LOCALE_COMPARE_SITES.keys()].filter((key) => !observed.has(key)),
      'stale classification: declared display-only localeCompare no longer exists'
    ).toEqual([])

    expect(
      formatSites(sites.filter((site) => HASH_MATERIAL_LOCALE_COMPARE_SITES.has(site.key))),
      'ICU-dependent ordering remains in hash material'
    ).toEqual([])
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

    const manifestSource = await readSource('compiler/aspc/src/manifest.ts')
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

    const alphaIndex = forward.indexOf('[mcp_servers.alpha]')
    const omegaIndex = forward.indexOf('[mcp_servers.omega]')
    expect(
      alphaIndex,
      'composed TOML must actually emit the alpha server table'
    ).toBeGreaterThanOrEqual(0)
    expect(
      omegaIndex,
      'composed TOML must actually emit the omega server table'
    ).toBeGreaterThanOrEqual(0)
    expect(alphaIndex, 'alpha must precede omega in ascending key order').toBeLessThan(omegaIndex)

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
