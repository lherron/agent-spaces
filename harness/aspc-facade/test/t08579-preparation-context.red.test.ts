/**
 * T-08579 Phase 2 reds: one preparation execution context.
 *
 * PROPOSAL revision 5 (sha256 1620ecf8…c567cf; Daedalus APPROVE EN-14413;
 * T-08563 rev 5.2; T-08564 §8 amended). Every case runs the real in-process
 * runtime compiler (createRuntimeCompiler) and the real ASPC service against a
 * hermetic fixture; only the codex binary is a version-answering stub.
 *
 * - P0 guard: compile outputs for the fixture equal the golden bytes captured
 *   from origin/main 5a018ce5 before any implementation (launch unchanged).
 * - P1 discriminators: HRC-shaped compile + inspect pairs are byte-equal
 *   (fail on 5a018ce5: ND-1 dispatchEnv, ND-2 lane, ND-3 correlation env,
 *   ND-4 bare file base, ND-5 template discovery).
 * - P3 prepareProcessInvocation shares the same bytes and hash; Q8 hints.
 * - P4 Q3 identity conflicts refuse; P6 capability key; P7 source arms.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type AspcService, createAspcService } from 'spaces-aspc'
import { validateAspcInspectRuntimePlacementRequest } from 'spaces-aspc-protocol'
import { createRuntimeCompiler, runtimeDependencies } from '../src/runtime-compiler.js'

type UnknownRecord = Record<string, any>

const GOLDEN_PATH = join(import.meta.dir, 'fixtures', 't08579-p0-golden.json')
const SCRUBBED_ENV_PREFIXES = ['ASP_', 'AGENT_', 'HRC_', 'WRKQ_', 'AGENTCHAT_ID', 'T08579_']
const WRITE_GOLDEN = process.env['T08579_WRITE_GOLDEN'] === '1'
const DISPATCH = { T08579_PARITY_PROBE: 'caller-value', HRC_TASK_ID: 'T-08579' }

let savedEnv: Record<string, string | undefined> = {}
let root = ''
let service: AspcService & UnknownRecord

beforeAll(() => {
  savedEnv = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key]
  }
  root = realpathSync.native(mkdtempSync('/tmp/t08579-ctx-'))
  buildFixture(root)
  process.env['ASP_HOME'] = join(root, 'ambient-home')
  process.env['ASP_CODEX_PATH'] = join(root, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  service = createAspcService({
    compiler: createRuntimeCompiler(),
    runtimeDependencies,
  }) as AspcService & UnknownRecord
})

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  process.env['ASP_HOME'] = join(root, 'ambient-home')
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const PROFILE = 'version = 4\n\n[spaces]\nbase = []\n\n[provisioning]\nharness = "codex"\n'

const POV_TEMPLATE = `schema_version = 2
mode = "append"

[[prompt]]
name = "soul"
type = "file"
path = "agent-root:///SOUL.md"

[[prompt]]
name = "motd-bare"
type = "file"
path = "MOTD.md"

[[prompt]]
name = "ident"
type = "inline"
content = "IDENT agent={{agentId}} project={{projectId}} task={{taskId}} lane={{lane}}"

[[prompt]]
name = "interp"
type = "inline"
content = "INTERP={{env.T08579_PARITY_PROBE}}"

[[prompt]]
name = "dispatch-gated"
type = "inline"
when = { envSet = "HRC_TASK_ID" }
content = "TASKCTX={{env.HRC_TASK_ID}}"

[[prompt]]
name = "probe-exec"
type = "exec"
command = "printf 'PROBE=%s' \\"\${T08579_PARITY_PROBE:-unset}\\""
timeout = 3000

[[prompt]]
name = "ctx-exec"
type = "exec"
command = "for k in AGENT_ID AGENT_LANE AGENT_LANE_REF AGENT_PROJECT AGENT_PROJECT_ROOT AGENT_SCOPE_REF AGENT_SESSION_REF AGENT_TASK AGENT_ACTOR WRKQ_PRINCIPAL_REF AGENTCHAT_ID ASP_PROJECT HRC_SESSION_REF; do printf '%s=%s;' \\"$k\\" \\"\${!k-}\\"; done"
timeout = 3000
`

function rosterTemplate(tag: string): string {
  return `schema_version = 2
mode = "append"

[[prompt]]
name = "tpl"
type = "inline"
content = "TPL=${tag}"

[[prompt]]
name = "user-bare"
type = "file"
path = "USER.md"
`
}

function inlineTemplate(tag: string): string {
  return `schema_version = 2
mode = "append"

[[prompt]]
name = "tpl"
type = "inline"
content = "TPL=${tag}"
`
}

function buildFixture(base: string): void {
  write(
    join(base, 'ambient-home', 'config.toml'),
    `agents-root = ${JSON.stringify(join(base, 'ambient-roster'))}\n`
  )
  write(join(base, 'ambient-home', 'context-template.toml'), inlineTemplate('ambient-home'))
  write(join(base, 'ambient-roster', 'context-template.toml'), rosterTemplate('ambient-roster'))
  write(join(base, 'ambient-roster', 'USER.md'), 'USER=ambient')
  write(join(base, 'ambient-roster', 'MOTD.md'), 'MOTD=ambient-roster')
  write(
    join(base, 'explicit-home', 'config.toml'),
    `agents-root = ${JSON.stringify(join(base, 'explicit-roster'))}\n`
  )
  write(join(base, 'explicit-home', 'context-template.toml'), inlineTemplate('explicit-home'))
  write(join(base, 'explicit-roster', 'context-template.toml'), rosterTemplate('explicit-roster'))
  write(join(base, 'explicit-roster', 'USER.md'), 'USER=explicit')
  write(join(base, 'roster', 'MOTD.md'), 'MOTD=roster')
  write(join(base, 'roster', 'pov', 'agent-profile.toml'), PROFILE)
  write(join(base, 'roster', 'pov', 'SOUL.md'), '# pov soul')
  write(join(base, 'roster', 'pov', 'MOTD.md'), 'MOTD=agent-local')
  write(join(base, 'roster', 'pov', 'context-template.toml'), POV_TEMPLATE)
  write(join(base, 'roster', 'pov2', 'agent-profile.toml'), PROFILE)
  write(join(base, 'roster', 'pov2', 'SOUL.md'), '# pov2 soul')
  write(join(base, 'projplain', 'asp-targets.toml'), 'schema = 2\n')
  write(join(base, 'projoverlay', 'asp-targets.toml'), 'schema = 2\nagents-root = "agents"\n')
  write(join(base, 'projoverlay', 'agents', 'MOTD.md'), 'MOTD=project-overlay')
  const codex = join(base, 'codex')
  writeFileSync(
    codex,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 999.0.0"; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then echo app-server; exit 0; fi\nexit 97\n'
  )
  chmodSync(codex, 0o755)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Case = {
  agent: 'pov' | 'pov2'
  project: 'projplain' | 'projoverlay'
  sessionRef?: boolean
  dispatchEnv?: Record<string, string>
  compileAspHome?: 'ambient-home' | 'explicit-home' | 'none'
}

function correlation(c: Case) {
  return c.sessionRef === false
    ? {}
    : {
        sessionRef: {
          scopeRef: `agent:${c.agent}:project:${c.project}:task:T-08579`,
          laneRef: 'main',
        },
      }
}

function compileRequest(c: Case): UnknownRecord {
  const agentRoot = join(root, 'roster', c.agent)
  const projectRoot = join(root, c.project)
  const ids = {
    requestId: 'dry-req-t08579',
    operationId: 'dry-op-t08579',
    hostSessionId: 'dry-run-host-session',
    generation: 0,
    runtimeId: 'dry-rt-t08579',
    invocationId: 'dry-inv-t08579',
    traceId: 'dry-trace-t08579',
  }
  const aspHome = c.compileAspHome ?? 'ambient-home'
  return {
    compileRequest: {
      schemaVersion: 'agent-runtime-compile-request/v1',
      identity: ids,
      placement: {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        bundle: { kind: 'agent-project', agentName: c.agent, projectRoot },
        correlation: correlation(c),
        dryRun: true,
        ...(c.dispatchEnv ? { dispatchEnv: c.dispatchEnv } : {}),
      },
      requested: {
        modelProvider: 'openai',
        harnessFamily: 'codex',
        preferredHarnessRuntime: 'codex-cli',
        interactionMode: 'headless',
      },
      materialization: {},
      hrcPolicy: {},
      correlation: ids,
    },
    profileSelector: { brokerDriver: 'codex-app-server' },
    ...(c.dispatchEnv ? { dispatchEnv: c.dispatchEnv } : {}),
    ...(aspHome === 'none' ? {} : { aspHome: join(root, aspHome) }),
  }
}

function inspectContext(c: Case, extra: UnknownRecord = {}): UnknownRecord {
  const projectRoot = join(root, c.project)
  return {
    agentId: c.agent,
    agentRoot: join(root, 'roster', c.agent),
    project: { mode: 'root', projectRoot, projectId: c.project },
    cwd: projectRoot,
    runMode: 'task',
    taskId: 'T-08579',
    ...extra,
  }
}

function inspectRequest(c: Case, extra: UnknownRecord = {}, withCorrelation = true): UnknownRecord {
  return {
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: inspectContext(c, extra),
    ...(withCorrelation ? { preparationCorrelation: correlation(c) } : {}),
    ...(c.dispatchEnv ? { dispatchEnv: c.dispatchEnv } : {}),
  }
}

function normalize(value: string | undefined): string | undefined {
  return value?.split(root).join('<ROOT>')
}

async function compile(c: Case): Promise<{ prompt: string; response: UnknownRecord }> {
  const response = (await service.compileHarnessInvocation(
    compileRequest(c) as never
  )) as UnknownRecord
  expect(response.ok, JSON.stringify(response.diagnostics ?? response)).toBe(true)
  const file = response.plan.artifacts.systemPromptFile as string
  return { prompt: readFileSync(file, 'utf8'), response }
}

async function inspect(c: Case, extra: UnknownRecord = {}): Promise<UnknownRecord> {
  return (await service.inspectRuntimePlacement(inspectRequest(c, extra) as never)) as UnknownRecord
}

function caseKey(c: Case): string {
  return `${c.agent}/${c.project}/${c.dispatchEnv ? 'dispatch' : 'nodispatch'}/${c.compileAspHome ?? 'ambient-home'}${c.sessionRef === false ? '/nosession' : ''}`
}

const P0_CASES: Case[] = [
  { agent: 'pov', project: 'projplain' },
  { agent: 'pov', project: 'projplain', dispatchEnv: DISPATCH },
  { agent: 'pov', project: 'projoverlay', dispatchEnv: DISPATCH },
  { agent: 'pov', project: 'projplain', sessionRef: false },
  { agent: 'pov2', project: 'projplain' },
  { agent: 'pov2', project: 'projoverlay' },
  { agent: 'pov2', project: 'projoverlay', compileAspHome: 'none' },
  { agent: 'pov2', project: 'projplain', compileAspHome: 'none' },
]

// ---------------------------------------------------------------------------
// P0: launch-unchanged guard
// ---------------------------------------------------------------------------

describe('T-08579 P0 launch-unchanged guard (golden from origin/main 5a018ce5)', () => {
  test('compile prompt and dispatch bytes equal the pre-change golden for every fixture case', async () => {
    const observed: Record<string, UnknownRecord> = {}
    for (const c of P0_CASES) {
      const { prompt, response } = await compile(c)
      observed[caseKey(c)] = {
        systemPrompt: normalize(prompt),
        dispatchEnv: response.dispatchRequest.dispatchEnv ?? null,
      }
    }
    if (WRITE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(observed, null, 2)}\n`)
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, UnknownRecord>
    expect(observed).toEqual(golden)
  })
})

// ---------------------------------------------------------------------------
// P1: preview parity discriminators (HRC-shaped pairs)
// ---------------------------------------------------------------------------

describe('T-08579 P1 preview/compile parity', () => {
  for (const c of [
    { agent: 'pov', project: 'projplain', dispatchEnv: DISPATCH },
    { agent: 'pov', project: 'projoverlay', dispatchEnv: DISPATCH },
    { agent: 'pov', project: 'projplain' },
    { agent: 'pov2', project: 'projplain', dispatchEnv: DISPATCH },
  ] as Case[]) {
    test(`inspection systemPrompt and environment hash equal compile for ${caseKey(c)}`, async () => {
      const { prompt, response } = await compile(c)
      const inspected = await inspect(c)
      expect(inspected.ok, JSON.stringify(inspected.declaration)).toBe(true)
      expect(normalize(inspected.prompt?.value?.systemPrompt)).toEqual(normalize(prompt))
      expect(inspected.effectiveEnvironmentHash).toEqual(expect.any(String))
      expect(response.effectiveEnvironmentHash).toBe(inspected.effectiveEnvironmentHash)
      // T-08701: the declaration carries closed-vocabulary scalars only; the
      // v1 driver label stays on the compile response.
      expect(inspected.declaration.provisioning.effectiveHarness).toBe('codex')
      expect(response.selectedProfile.harnessInvocation.startRequest.spec.harness.driver).toBe(
        'codex-app-server'
      )
    })
  }

  test('T-08580: inspection is read-only for the already prepared Codex home', async () => {
    const c: Case = { agent: 'pov', project: 'projplain' }
    const { response } = await compile(c)
    const codexHome = response.selectedProfile.harnessInvocation.startRequest.spec.process.lockedEnv
      .CODEX_HOME as string
    const agentsPath = join(codexHome, 'AGENTS.md')
    const before = readFileSync(agentsPath, 'utf8')
    const beforeMtime = statSync(agentsPath).mtimeMs

    const inspected = await inspect(c)

    expect(inspected.ok, JSON.stringify(inspected.declaration)).toBe(true)
    expect(readFileSync(agentsPath, 'utf8')).toBe(before)
    expect(statSync(agentsPath).mtimeMs).toBe(beforeMtime)
  })

  test('ND-1: dispatchEnv changes neither inspection prompt nor environment hash', async () => {
    const base: Case = { agent: 'pov', project: 'projplain' }
    const without = await inspect(base)
    const withDispatch = await inspect({ ...base, dispatchEnv: DISPATCH })
    const other = await inspect({
      ...base,
      dispatchEnv: { ...DISPATCH, T08579_PARITY_PROBE: 'other' },
    })
    expect(withDispatch.prompt.value.systemPrompt).toBe(without.prompt.value.systemPrompt)
    expect(other.prompt.value.systemPrompt).toBe(without.prompt.value.systemPrompt)
    expect(withDispatch.effectiveEnvironmentHash).toBe(without.effectiveEnvironmentHash)
    expect(other.effectiveEnvironmentHash).toBe(without.effectiveEnvironmentHash)
    expect(without.prompt.value.systemPrompt).toContain('PROBE=unset')
    expect(without.prompt.value.systemPrompt).not.toContain('TASKCTX=')
  })

  test('ND-2/ND-3: lane and correlation environment come from preparationCorrelation', async () => {
    const inspected = await inspect({ agent: 'pov', project: 'projplain' })
    const prompt = inspected.prompt.value.systemPrompt as string
    expect(prompt).toContain('lane=main')
    expect(prompt).toContain('AGENT_SCOPE_REF=agent:pov:project:projplain:task:T-08579;')
    expect(prompt).toContain('HRC_SESSION_REF=agent:pov:project:projplain:task:T-08579/lane:main;')
    expect(prompt).toContain('AGENTCHAT_ID=pov;')
  })

  test('ND-4: bare relative file paths use the shared search path, never agentRoot', async () => {
    const plain = await inspect({ agent: 'pov', project: 'projplain' })
    const overlay = await inspect({ agent: 'pov', project: 'projoverlay' })
    expect(plain.prompt.value.systemPrompt).toContain('MOTD=roster')
    expect(overlay.prompt.value.systemPrompt).toContain('MOTD=project-overlay')
    expect(plain.prompt.value.systemPrompt).not.toContain('MOTD=agent-local')
  })

  test('ND-5: template discovery does not inject the daemon-default agentsRoot', async () => {
    const inspected = await inspect({ agent: 'pov2', project: 'projplain' })
    expect(inspected.prompt.value.systemPrompt).not.toContain('TPL=ambient-roster')
    expect(inspected.prompt.value.systemPrompt).toContain('TPL=ambient-home')
  })
})

// ---------------------------------------------------------------------------
// P3: direct preparation shares the context (Q7, Q8)
// ---------------------------------------------------------------------------

function prepareRequest(
  c: Case,
  contextExtra: UnknownRecord = {},
  withCorrelation = true
): UnknownRecord {
  return {
    schemaVersion: 'aspc-prepare-process-invocation-request/v1',
    context: inspectContext(c, contextExtra),
    preparationCorrelation: withCorrelation ? correlation(c) : {},
    expected: { provider: 'openai', frontend: 'codex-cli' },
    launch: { interactionMode: 'headless', ioMode: 'pipes' },
    ...(c.dispatchEnv ? { dispatchEnv: c.dispatchEnv } : {}),
  }
}

describe('T-08579 P3 prepareProcessInvocation', () => {
  test('system prompt and effectiveEnvironmentHash equal inspection for the same context', async () => {
    const c: Case = { agent: 'pov', project: 'projplain', dispatchEnv: DISPATCH }
    const prepared = (await service.prepareProcessInvocation(
      prepareRequest(c) as never
    )) as UnknownRecord
    const inspected = await inspect(c)
    expect(prepared.ok, JSON.stringify(prepared.failure)).toBe(true)
    expect(prepared.spec.prompts.system.content).toBe(inspected.prompt.value.systemPrompt)
    expect(prepared.effectiveEnvironmentHash).toBe(inspected.effectiveEnvironmentHash)
  })

  test('ND-11(a): context identity hints render when sessionRef is absent', async () => {
    const c: Case = { agent: 'pov', project: 'projplain' }
    const prepared = (await service.prepareProcessInvocation(
      prepareRequest(
        c,
        { project: { mode: 'root', projectRoot: join(root, 'projplain'), projectId: 'hinted' } },
        false
      ) as never
    )) as UnknownRecord
    expect(prepared.ok, JSON.stringify(prepared.failure)).toBe(true)
    expect(prepared.spec.prompts.system.content).toContain(
      'IDENT agent=pov project=hinted task=T-08579 lane='
    )
  })
})

// ---------------------------------------------------------------------------
// P4 (Q3): identity conflicts are refused before materialization
// ---------------------------------------------------------------------------

describe('T-08579 P4 identity conflict refusal', () => {
  const conflicts: Array<[string, UnknownRecord]> = [
    ['projectId', { project: { mode: 'root', projectRoot: '', projectId: 'other' } }],
    ['taskId', { taskId: 'T-00001' }],
    ['agentId', { agentId: 'someone-else' }],
  ]
  for (const [name, extra] of conflicts) {
    test(`inspect and prepare refuse a scopeRef/${name} conflict`, async () => {
      const c: Case = { agent: 'pov', project: 'projplain' }
      const fixed =
        name === 'projectId'
          ? { project: { mode: 'root', projectRoot: join(root, 'projplain'), projectId: 'other' } }
          : extra
      const inspected = await inspect(c, fixed)
      expect(inspected).toMatchObject({
        ok: false,
        declaration: {
          ok: false,
          failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
        },
      })
      const prepared = (await service.prepareProcessInvocation(
        prepareRequest(c, fixed) as never
      )) as UnknownRecord
      expect(prepared).toMatchObject({
        ok: false,
        failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
      })
      expect(Object.hasOwn(prepared, 'spec')).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// P6: capability key; P7: explicit vs ambient source arms (Q5, Q6)
// ---------------------------------------------------------------------------

describe('T-08579 P6 capability', () => {
  test('hello advertises inspectRuntimePlacementPreparationCorrelation exactly', async () => {
    const hello = (await service.hello({
      clientInfo: { name: 't08579' },
      protocolVersions: ['aspc/0.1'],
    })) as UnknownRecord
    expect(hello.capabilities.inspectRuntimePlacementPreparationCorrelation).toBe(true)
  })

  test('the inspect request validator accepts preparationCorrelation', () => {
    expect(() =>
      validateAspcInspectRuntimePlacementRequest(
        inspectRequest({ agent: 'pov', project: 'projplain' })
      )
    ).not.toThrow()
  })
})

describe('T-08579 P7 explicit source arms never merge with ambient', () => {
  test('compile: request aspHome anchors the canonical root and the aspHome template', async () => {
    const overlay = await compile({
      agent: 'pov2',
      project: 'projoverlay',
      compileAspHome: 'explicit-home',
    })
    expect(overlay.prompt).toContain('TPL=explicit-roster')
    expect(overlay.prompt).toContain('USER=explicit')
    expect(overlay.prompt).not.toContain('ambient')
    const plain = await compile({
      agent: 'pov2',
      project: 'projplain',
      compileAspHome: 'explicit-home',
    })
    expect(plain.prompt).toContain('TPL=explicit-home')
  })

  test('compile without request aspHome keeps the ambient arm', async () => {
    const overlay = await compile({ agent: 'pov2', project: 'projoverlay', compileAspHome: 'none' })
    expect(overlay.prompt).toContain('TPL=ambient-roster')
    expect(overlay.prompt).toContain('USER=ambient')
  })

  test('inspect: validated caller agentSources anchor discovery exclusively', async () => {
    const sources = { agentSources: { aspHome: join(root, 'explicit-home') } }
    const overlay = await inspect({ agent: 'pov2', project: 'projoverlay' }, sources)
    expect(overlay.ok, JSON.stringify(overlay.declaration)).toBe(true)
    expect(overlay.prompt.value.systemPrompt).toContain('TPL=explicit-roster')
    expect(overlay.prompt.value.systemPrompt).toContain('USER=explicit')
    expect(overlay.prompt.value.systemPrompt).not.toContain('ambient')
    const plain = await inspect({ agent: 'pov2', project: 'projplain' }, sources)
    expect(plain.prompt.value.systemPrompt).toContain('TPL=explicit-home')
  })

  test('inspect and compile agree on the explicit arm', async () => {
    const compiled = await compile({
      agent: 'pov2',
      project: 'projoverlay',
      compileAspHome: 'explicit-home',
    })
    const inspected = await inspect(
      { agent: 'pov2', project: 'projoverlay' },
      { agentSources: { aspHome: join(root, 'explicit-home') } }
    )
    expect(normalize(inspected.prompt.value.systemPrompt)).toBe(normalize(compiled.prompt))
  })
})
