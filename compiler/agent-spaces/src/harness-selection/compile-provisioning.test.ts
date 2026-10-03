import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'

import {
  CompileProvisioningError,
  resolveCompileProvisioningLayers,
  resolveCompileSources,
} from './compile-provisioning.js'
import { resolveHarnessExecution } from './resolve.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { request: RuntimeCompileRequest; agentRoot: string; projectRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'asp-compile-provisioning-'))
  temporaryRoots.push(root)
  const agentRoot = join(root, 'cody')
  const projectRoot = join(root, 'project')
  mkdirSync(agentRoot)
  mkdirSync(projectRoot)
  const request = {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: 'cody' },
    identity: {},
    placement: {
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'cody', projectRoot },
    },
    requested: {},
    materialization: {},
    hrcPolicy: {},
    correlation: {},
  } as unknown as RuntimeCompileRequest
  return { request, agentRoot, projectRoot }
}

describe('compile provisioning source resolution', () => {
  test('loads profile, target, and directive layers without erasing explicit false', () => {
    const { request, agentRoot, projectRoot } = fixture()
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      'version = 4\n[provisioning]\nharness = "claude"\npresentation = true\n'
    )
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 2\n[targets.cody.provisioning]\nharness = "codex"\nmodel_provider = "openai-codex"\nmodel = "gpt-5.5"\n'
    )
    request.selectionContext = {
      summonDirectives: { harness: 'muse', presentation: false },
    }

    const layers = resolveCompileProvisioningLayers(request)
    expect(layers).toEqual({
      agentProfile: { harness: 'claude', presentation: true },
      projectTarget: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
      },
      summonDirectives: { harness: 'muse', presentation: false },
    })
  })

  test('feeds exact provenance precedence into the sole resolver', () => {
    const { request, agentRoot, projectRoot } = fixture()
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      'version = 4\n[provisioning]\nharness = "claude"\n'
    )
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 2\n[targets.cody.provisioning]\nharness = "codex"\n'
    )
    request.selectionContext = { summonDirectives: { harness: 'muse', presentation: true } }
    request.requested = { harness: 'agent-harness', presentation: false }

    const result = resolveHarnessExecution({
      agent: request.agent,
      provisioningLayers: resolveCompileProvisioningLayers(request),
      requested: request.requested,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection).toMatchObject({
      harness: 'agent-harness',
      presentation: false,
      provenance: { harness: 'compile-request', presentation: 'compile-request' },
    })
  })

  test('fails closed on legacy profile and project-target schemas', () => {
    const profileFixture = fixture()
    writeFileSync(join(profileFixture.agentRoot, 'agent-profile.toml'), 'version = 3\n')
    expect(() => resolveCompileProvisioningLayers(profileFixture.request)).toThrow(
      CompileProvisioningError
    )
    try {
      resolveCompileProvisioningLayers(profileFixture.request)
    } catch (error) {
      expect((error as CompileProvisioningError).code).toBe('agent_profile_invalid')
    }

    const targetFixture = fixture()
    writeFileSync(join(targetFixture.agentRoot, 'agent-profile.toml'), 'version = 4\n')
    writeFileSync(join(targetFixture.projectRoot, 'asp-targets.toml'), 'schema = 1\n')
    try {
      resolveCompileProvisioningLayers(targetFixture.request)
      throw new Error('expected project target rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(CompileProvisioningError)
      expect((error as CompileProvisioningError).code).toBe('project_targets_invalid')
    }
  })
})

describe('session metadata compile envelope sources', () => {
  test('layers dotted leaves independently without validating registered meanings', () => {
    const { request, agentRoot, projectRoot } = fixture()
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      `version = 4
[session.metadata]
title = "Profile"
[session.metadata.appearance]
color = "#123456"
terminalFg = "#FFFFFF"
`
    )
    writeFileSync(
      join(projectRoot, 'asp-targets.toml'),
      `schema = 2
[targets.cody.session.metadata.appearance]
color = "deliberately-invalid-color"
`
    )
    expect(resolveCompileSources(request).sessionMetadata).toEqual({
      title: 'Profile',
      'appearance.color': 'deliberately-invalid-color',
      'appearance.terminalFg': '#FFFFFF',
    })
    writeFileSync(join(projectRoot, 'asp-targets.toml'), 'schema = 2\n')
    expect(resolveCompileSources(request).sessionMetadata['appearance.color']).toBe('#123456')
  })

  test('absent metadata carries an empty set and grammar, prefix, and size violations drop', () => {
    const { request, agentRoot } = fixture()
    expect(resolveCompileSources(request).sessionMetadata).toEqual({})
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      `version = 4
[session.metadata]
valid = [1, 2, 3]
Bad = "invalid key"
"${'a'.repeat(65)}" = "long segment"
"${'a'.repeat(64)}.${'b'.repeat(64)}" = "129 byte key"
huge = "${'x'.repeat(4097)}"
"appearance" = "prefix"
"appearance.color" = "collision"
`
    )
    const result = resolveCompileSources(request)
    expect(result.sessionMetadata).toEqual({ valid: [1, 2, 3], appearance: 'prefix' })
    expect(result.metadataDiagnostics).toHaveLength(5)
  })

  test('limits the layered envelope to 64 distinct keys', () => {
    const { request, agentRoot } = fixture()
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      `version = 4\n[session.metadata]\n${Array.from({ length: 65 }, (_, i) => `key${i} = ${i}`).join('\n')}`
    )
    const result = resolveCompileSources(request)
    expect(Object.keys(result.sessionMetadata)).toHaveLength(64)
    expect(result.metadataDiagnostics).toHaveLength(1)
  })
})
