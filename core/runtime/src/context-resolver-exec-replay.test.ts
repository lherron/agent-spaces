/**
 * Dynamic sections in the context resolver: live exec sections skip on timeout
 * or non-zero exit, and recorded exec / service-probe ledgers replay through
 * the live formatting path, fail closed on missing/stale/duplicate records, and
 * never launch a child process.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseContextTemplate } from './context-template.js'
import type { RecordedExecResult } from './dynamic-replay.js'
import {
  type ResolverRoots,
  createResolverRoots,
  removeResolverRoots,
  resolveDetailed,
  resolveZones,
} from './test-support/context-resolver-fixture.js'

function recordedExec(
  sectionName: string,
  command: string,
  stdout: string,
  overrides: Partial<RecordedExecResult> = {}
): RecordedExecResult {
  return { sectionName, command, occurrence: 1, exitStatus: 0, stdout, stderr: '', ...overrides }
}

describe('resolveContextTemplate exec sections and recorded replay', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('skips exec sections when commands time out or exit non-zero', async () => {
    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "timeout"
type = "exec"
command = "sleep 1"
timeout = 10

[[prompt]]
name = "failure"
type = "exec"
command = "exit 7"

[[prompt]]
name = "success"
type = "exec"
command = "printf 'ok'"
`)
    )

    expect(resolved).toEqual({
      prompt: {
        content: 'ok',
        mode: 'replace',
      },
      reminder: undefined,
    })
  })

  test('replays recorded exec success and failure through the live formatting path', async () => {
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "success"
type = "exec"
command = "printf 'live-success'"

[[prompt]]
name = "failure"
type = "exec"
command = "printf 'live-failure'; exit 23"
`)
    const live = await resolveDetailed(roots, template)
    const replayed = await resolveDetailed(roots, template, {
      execResults: [
        recordedExec('success', "printf 'live-success'", 'live-success'),
        recordedExec('failure', "printf 'live-failure'; exit 23", 'live-failure', {
          exitStatus: 23,
          stderr: 'recorded stderr',
        }),
      ],
    })

    expect(replayed.prompt).toEqual(live.prompt)
    expect(replayed.promptSections[1]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'exec', command: "printf 'live-failure'; exit 23" },
    })
    if (replayed.promptSections[1]?.disposition.kind === 'failed') {
      expect(replayed.promptSections[1].disposition.reason).toContain('exit code: 23')
      expect(replayed.promptSections[1].disposition.reason).toContain('recorded stderr')
    }
  })

  test('fails closed when a recorded exec collection is missing or leaves a stale record', async () => {
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "dynamic"
type = "exec"
command = "printf 'must-not-run'"
`)
    const command = "printf 'must-not-run'"

    await expect(resolveDetailed(roots, template, { execResults: [] })).rejects.toThrow(
      'Missing recorded exec result'
    )

    await expect(
      resolveDetailed(roots, template, {
        execResults: [
          recordedExec('dynamic', command, 'recorded'),
          recordedExec('stale', "printf 'stale'", 'stale'),
        ],
      })
    ).rejects.toThrow('Unused recorded exec result')

    await expect(
      resolveDetailed(roots, template, {
        execResults: [
          recordedExec('dynamic', command, 'first'),
          recordedExec('dynamic', command, 'duplicate'),
        ],
      })
    ).rejects.toThrow('Duplicate recorded exec result')
  })

  test('fails closed on missing and duplicate recorded service probes', async () => {
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "services"
type = "service-probe"
services = [{ name = "broker", endpoint = "not-a-live-endpoint" }]
`)

    await expect(resolveDetailed(roots, template, { serviceProbeResponses: [] })).rejects.toThrow(
      'Missing recorded service probe response'
    )

    await expect(
      resolveDetailed(roots, template, {
        serviceProbeResponses: [
          { name: 'broker', endpoint: 'not-a-live-endpoint', up: true },
          { name: 'broker', endpoint: 'not-a-live-endpoint', up: false },
        ],
      })
    ).rejects.toThrow('Duplicate recorded service probe response')
  })

  test('never launches a child process while exec replay is active', async () => {
    const sentinel = join(roots.tempRoot, 'exec-replay-sentinel')
    const command = `touch '${sentinel}'`
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "replayed"
type = "exec"
command = "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"
`)
    const resolved = await resolveDetailed(roots, template, {
      execResults: [recordedExec('replayed', command, 'replayed output')],
    })

    expect(resolved.prompt?.content).toBe('replayed output')
    expect(existsSync(sentinel)).toBe(false)
  })
})
