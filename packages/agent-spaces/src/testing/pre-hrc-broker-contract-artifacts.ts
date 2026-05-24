import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

import type { BrokerExecutionProfile, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { redactArtifact } from 'spaces-runtime-contracts'

import type {
  ContractHarnessFailure,
  PreHrcBrokerContractArtifactManifest,
  PreHrcBrokerContractAssertionReport,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'

export type PreHrcBrokerContractArtifactInput = {
  artifactDir: string
  compileRequest: RuntimeCompileRequest
  compiledPlan?: unknown | undefined
  selectedProfile?: BrokerExecutionProfile | undefined
  routeDecision?: PreHrcRouteDecision | undefined
  brokerEvents?: unknown[] | undefined
  assertionReport: PreHrcBrokerContractAssertionReport
  writeRawStartRequest?: boolean | undefined
}

function envForRedaction(
  profile: BrokerExecutionProfile | undefined
): Record<string, string> | undefined {
  return profile?.harnessInvocation.startRequest.spec.process.env
}

function tempDirContains(path: string): boolean {
  const root = resolve(tmpdir())
  const target = resolve(path)
  return target === root || target.startsWith(`${root}${sep}`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function writePreHrcBrokerContractArtifacts(
  input: PreHrcBrokerContractArtifactInput
): Promise<{
  manifest?: PreHrcBrokerContractArtifactManifest | undefined
  failures: ContractHarnessFailure[]
}> {
  const failures: ContractHarnessFailure[] = []
  if (!input.artifactDir) {
    return {
      failures: [
        {
          code: 'artifact_dir_required',
          message: 'artifactDir is required to write pre-HRC broker contract artifacts.',
        },
      ],
    }
  }
  if (input.writeRawStartRequest === true && !tempDirContains(input.artifactDir)) {
    return {
      failures: [
        {
          code: 'raw_start_request_requires_temp_dir',
          message:
            '--write-raw-start-request is only allowed when artifactDir is under the OS temp directory.',
          path: 'artifactDir',
          redactedDetails: { artifactDir: input.artifactDir, tempDir: tmpdir() },
        },
      ],
    }
  }

  const artifactDir = isAbsolute(input.artifactDir) ? input.artifactDir : resolve(input.artifactDir)
  const env = envForRedaction(input.selectedProfile)
  const startRequest = input.selectedProfile?.harnessInvocation.startRequest
  const brokerSpec = startRequest?.spec
  const files: Record<string, string> = {}
  const warnings: string[] = []

  try {
    await mkdir(artifactDir, { recursive: true })
    const artifacts: Array<[string, unknown]> = [
      ['compile-request.redacted.json', redactArtifact(input.compileRequest, { env })],
      ['compiled-plan.redacted.json', redactArtifact(input.compiledPlan ?? null, { env })],
      ['selected-profile.redacted.json', redactArtifact(input.selectedProfile ?? null, { env })],
      ['broker-spec.redacted.json', redactArtifact(brokerSpec ?? null, { env })],
      ['invocation-start-request.redacted.json', redactArtifact(startRequest ?? null, { env })],
      ['route-decision.pre-hrc.json', input.routeDecision ?? null],
      ['assertion-report.json', input.assertionReport],
    ]

    for (const [name, value] of artifacts) {
      const path = join(artifactDir, name)
      await writeJson(path, value)
      files[name] = path
    }

    const eventPath = join(artifactDir, 'broker-events.jsonl')
    const events = input.brokerEvents ?? []
    await writeFile(
      eventPath,
      events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''),
      'utf8'
    )
    files['broker-events.jsonl'] = eventPath

    let rawStartRequestWritten = false
    if (input.writeRawStartRequest === true) {
      const rawPath = join(artifactDir, 'invocation-start-request.RAW.UNSAFE.json')
      await writeJson(rawPath, startRequest ?? null)
      files['invocation-start-request.RAW.UNSAFE.json'] = rawPath
      rawStartRequestWritten = true
      warnings.push(
        'RAW broker start request was written by explicit request; keep this temp-only artifact out of logs and commits.'
      )
    }

    const summary = [
      'pre-HRC broker contract harness',
      `ok: ${input.assertionReport.ok}`,
      'redacted-by-default: true',
      `raw-start-request-written: ${rawStartRequestWritten}`,
      `failures: ${input.assertionReport.failures.length}`,
      ...input.assertionReport.failures.map((failure) => `- ${failure.code}: ${failure.message}`),
      ...warnings.map((warning) => `WARNING: ${warning}`),
      '',
    ].join('\n')
    const summaryPath = join(artifactDir, 'summary.txt')
    await writeFile(summaryPath, summary, 'utf8')
    files['summary.txt'] = summaryPath

    return {
      manifest: {
        schemaVersion: 'pre-hrc-broker-contract-artifacts/v1',
        artifactDir,
        files,
        redactedByDefault: true,
        rawStartRequestWritten,
        warnings,
      },
      failures,
    }
  } catch (error) {
    failures.push({
      code: 'artifact_write_failed',
      message: error instanceof Error ? error.message : String(error),
      path: artifactDir,
    })
    return { failures }
  }
}
