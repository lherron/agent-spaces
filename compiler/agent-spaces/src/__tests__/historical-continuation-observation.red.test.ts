/** T-08563 rev 5 historical-continuation reds through the public compiler entrypoint. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as AgentSpaces from '../index.js'

type Observation = Record<string, any> & { ok: boolean }
type ObserveContinuationArtifact = (
  request: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<Observation>

const KEY = '018f4f75-8a01-7b90-b92d-runtime-key'
let root = ''
let aspHome = ''
let h1 = ''
let h2 = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'historical-continuation-red-'))
  aspHome = join(root, 'asp-home')
  h1 = join(aspHome, 'codex-homes', 'r1_smokey')
  h2 = join(root, 'newer-unbound-H2')
  await Promise.all([mkdir(h1, { recursive: true }), mkdir(h2, { recursive: true })])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('T-08563 historical continuation observation', () => {
  test('positive control: fixture uses exact CODEX_HOME/sessions rollout layout', async () => {
    const path = await writeRollout(h1, KEY)
    expect(path).toContain(`${h1}/sessions/`)
    expect(path.endsWith(`-${KEY}.jsonl`)).toBe(true)
  })

  test('requires key-bound frozen evidence and prefers retained R1/H1 over newer unbound R2/H2', async () => {
    await writeRollout(h1, KEY)
    await mkdir(join(h2, 'sessions'), { recursive: true })
    const response = await operation()(
      codexRequest({
        frozenStartRequest: frozenEvidence(h1),
        recordedPlacement: recordedEvidence(h2),
      }),
      { aspHome }
    )

    expect(response).toMatchObject({
      ok: true,
      requested: { provider: 'codex', key: KEY, artifactFormat: 'codex' },
      artifactFormat: 'codex',
      artifact: { state: 'present', code: 'artifact_present' },
      basis: 'frozen-home',
    })
    expect(response.diagnostics).toEqual(expect.any(Array))

    const invalid = await operation()(
      codexRequest({
        frozenStartRequest: { ...frozenEvidence(h1), keyBinding: undefined },
      }),
      { aspHome }
    )
    expect(invalid).toMatchObject({
      ok: false,
      failure: { kind: 'incompatible', code: 'evidence_invalid' },
    })
  })

  test('returns missing only from the exact key-bound frozen home', async () => {
    await mkdir(join(h1, 'sessions'), { recursive: true })
    await writeRollout(h2, KEY)
    const response = await operation()(
      codexRequest({
        frozenStartRequest: frozenEvidence(h1),
        recordedPlacement: recordedEvidence(h2),
      }),
      { aspHome }
    )

    expect(response).toMatchObject({
      ok: true,
      artifact: { state: 'missing', code: 'artifact_missing' },
      basis: 'frozen-home',
    })
    expect(response.artifact.state).not.toBe('present')
  })

  test('treats unbound recorded placement as presence-only, including its negative guard', async () => {
    const derivedHome = join(aspHome, 'codex-homes', 'agent-spaces_smokey')
    await writeRollout(derivedHome, KEY)
    const present = await operation()(
      codexRequest({
        recordedPlacement: recordedEvidence(aspHome),
      }),
      { aspHome: join(root, 'different-daemon-default') }
    )
    expect(present).toMatchObject({
      ok: true,
      artifact: { state: 'present', code: 'artifact_present' },
      basis: 'recorded-placement-rule',
    })

    await rm(derivedHome, { recursive: true, force: true })
    const notHistorical = await operation()(
      codexRequest({
        recordedPlacement: recordedEvidence(aspHome),
      }),
      { aspHome: h2 }
    )
    expect(notHistorical).toMatchObject({
      ok: true,
      artifact: { state: 'unknown', code: 'home_not_historical' },
      basis: 'recorded-placement-rule',
    })
    expect(notHistorical.artifact.state).not.toBe('missing')
  })

  test('preserves absolute Pi present/missing and rejects a relative key as unknown', async () => {
    const piKey = join(root, 'pi-session.jsonl')
    await writeFile(piKey, '{}\n')
    const present = await operation()(continuationRequest('pi-sdk', piKey, 'pi'))
    expect(present).toMatchObject({
      ok: true,
      artifactFormat: 'pi',
      artifact: { state: 'present', code: 'artifact_present' },
      basis: 'absolute-key',
    })

    await rm(piKey)
    const missing = await operation()(continuationRequest('pi-sdk', piKey, 'pi'))
    expect(missing.artifact).toEqual({ state: 'missing', code: 'artifact_missing' })
    const relative = await operation()(continuationRequest('pi-sdk', 'relative.jsonl', 'pi'))
    expect(relative.artifact).toEqual({ state: 'unknown', code: 'key_not_absolute' })
  })

  test('never guesses an ambiguous bare-openai artifact format or fresh-session fallback', async () => {
    const response = await operation()({
      schemaVersion: 'aspc-observe-continuation-artifact-request/v1',
      continuation: { provider: 'openai', key: KEY },
    })
    expect(response).toMatchObject({
      ok: true,
      artifactFormat: 'unknown',
      artifact: { state: 'unknown', code: 'artifact_format_ambiguous' },
      basis: 'none',
    })
    expect(JSON.stringify(response)).not.toContain('start-fresh')
  })
})

function operation(): ObserveContinuationArtifact {
  const value = (AgentSpaces as Record<string, unknown>)['observeContinuationArtifact']
  expect(
    value,
    'agent-spaces must expose observeContinuationArtifact over durable historical evidence'
  ).toBeFunction()
  return value as ObserveContinuationArtifact
}

function codexRequest(historicalExecution: Record<string, unknown>): Record<string, unknown> {
  return {
    ...continuationRequest('codex', KEY, 'codex'),
    historicalExecution,
  }
}

function continuationRequest(provider: string, key: string, artifactFormat?: string) {
  return {
    schemaVersion: 'aspc-observe-continuation-artifact-request/v1',
    continuation: { provider, key, ...(artifactFormat ? { artifactFormat } : {}) },
  }
}

function frozenEvidence(codexHome: string): Record<string, unknown> {
  return {
    keyBinding: 'runtime-continuation',
    placement: placement(),
    brokerDriver: 'codex-app-server',
    startRequest: {
      spec: {
        process: { lockedEnv: { CODEX_HOME: codexHome } },
        driver: { kind: 'codex-app-server', resumeFallback: 'fail' },
      },
    },
  }
}

function recordedEvidence(recordedAspHome: string): Record<string, unknown> {
  const value = placement()
  return {
    placement: value,
    bundle: value.bundle,
    aspHome: recordedAspHome,
  }
}

function placement(): Record<string, unknown> {
  return {
    agentRoot: '/agents/smokey',
    projectRoot: '/projects/agent-spaces',
    runMode: 'task',
    bundle: {
      kind: 'agent-project',
      agentName: 'smokey',
      projectRoot: '/projects/agent-spaces',
    },
  }
}

async function writeRollout(codexHome: string, key: string): Promise<string> {
  const dir = join(codexHome, 'sessions', '2026', '09', '17')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-2026-09-17T04-00-00-${key}.jsonl`)
  await writeFile(path, '{}\n')
  return path
}
