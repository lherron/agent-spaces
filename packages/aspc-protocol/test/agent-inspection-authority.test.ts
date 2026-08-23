import { describe, expect, test } from 'bun:test'

import {
  AspcCatalogAgentInspectionRequestValidationError,
  AspcInspectAgentSelectionRequestValidationError,
  AspcSharedAgentInspectionSchemaError,
  type AspcSharedSchema,
  agentCatalogResponseSchema,
  agentInspectionOutcomeSchema,
  agentInspectionRequestSchema,
  validateAspcCatalogAgentInspectionRequest,
  validateAspcCommand,
  validateAspcInspectAgentSelectionRequest,
} from '../src/index.js'

const identifiers = {
  agentId: 'cody',
  projectId: 'agent-spaces',
  mode: 'task',
  scope: 'agent:cody:project:agent-spaces',
  lane: 'main',
  harness: 'codex',
  frontend: 'codex-cli',
  interaction: 'interactive',
}

const request = {
  schemaVersion: 'agent-inspection-request/v1',
  identifiers,
  declaredOverrides: {},
}

describe('identifier-only ASPC inspection authority protocol', () => {
  test('validates both new methods and their command envelopes', () => {
    expect(validateAspcCatalogAgentInspectionRequest({})).toEqual({})
    expect(validateAspcCatalogAgentInspectionRequest({ projectId: 'agent-spaces' })).toEqual({
      projectId: 'agent-spaces',
    })
    expect(validateAspcInspectAgentSelectionRequest({ agentId: 'cody', request })).toEqual({
      agentId: 'cody',
      request,
    })
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: 'catalog',
        method: 'aspc.catalogAgentInspection',
        params: {},
      })
    ).toMatchObject({ method: 'aspc.catalogAgentInspection' })
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: 'inspect',
        method: 'aspc.inspectAgentSelection',
        params: { agentId: 'cody', request },
      })
    ).toMatchObject({ method: 'aspc.inspectAgentSelection' })
  })

  test.each([
    ['agentsRoot', '/caller/agents'],
    ['projectRoot', '/caller/project'],
    ['cwd', '/caller/cwd'],
    ['environment', { SECRET: 'caller' }],
    ['nowIso', '2026-08-23T00:00:00.000Z'],
    ['serviceProbeInputs', { responses: [] }],
    ['scaffoldPackets', []],
    ['compileContext', {}],
    ['evaluationContext', {}],
    ['executable', '/caller/bin/codex'],
  ])('rejects forbidden catalog input %s', (field, value) => {
    expect(() => validateAspcCatalogAgentInspectionRequest({ [field]: value })).toThrow()
  })

  test.each([
    ['agentsRoot', '/caller/agents'],
    ['projectRoot', '/caller/project'],
    ['cwd', '/caller/cwd'],
    ['environment', { SECRET: 'caller' }],
    ['nowIso', '2026-08-23T00:00:00.000Z'],
    ['serviceProbeInputs', { responses: [] }],
    ['scaffoldPackets', []],
    ['compileRequest', {}],
    ['evaluationContext', {}],
    ['executable', '/caller/bin/codex'],
  ])('rejects forbidden inspection input %s', (field, value) => {
    expect(() =>
      validateAspcInspectAgentSelectionRequest({ agentId: 'cody', request, [field]: value })
    ).toThrow()
  })

  test('rejects malformed ids and hidden context fields inside identifiers', () => {
    expect(() => validateAspcCatalogAgentInspectionRequest({ projectId: '../escape' })).toThrow(
      AspcCatalogAgentInspectionRequestValidationError
    )
    expect(() =>
      validateAspcInspectAgentSelectionRequest({
        agentId: 'cody/../../escape',
        request,
      })
    ).toThrow(AspcInspectAgentSelectionRequestValidationError)
    expect(() =>
      validateAspcInspectAgentSelectionRequest({
        agentId: 'cody',
        request: {
          ...request,
          identifiers: { ...identifiers, projectRoot: '/hidden/project' },
        },
      })
    ).toThrow()
  })

  test('exports strict shared request and catalog schemas', () => {
    const catalogSchema: AspcSharedSchema<unknown> = agentCatalogResponseSchema
    expect(catalogSchema).toBe(agentCatalogResponseSchema)
    expect(agentInspectionRequestSchema.parse(request)).toBe(request)
    const neutral = {
      projectId: null,
      agents: [
        {
          agentId: 'cody',
          displayName: 'Cody',
          role: null,
          sourceAvailability: { profile: true, soul: true, contextTemplate: true },
          diagnostics: [],
          warningCount: 0,
          errorCount: 0,
        },
      ],
      contexts: {},
    }
    expect(agentCatalogResponseSchema.parse(neutral)).toBe(neutral)
    expect(() => agentCatalogResponseSchema.parse({ ...neutral, agentsRoot: '/leak' })).toThrow(
      AspcSharedAgentInspectionSchemaError
    )
    expect(
      agentInspectionOutcomeSchema.parse({
        ok: false,
        diagnostics: [{ severity: 'error', code: 'unavailable', message: 'Unavailable' }],
      })
    ).toEqual({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'unavailable', message: 'Unavailable' }],
    })
    expect(() =>
      agentCatalogResponseSchema.parse({
        ...neutral,
        agents: [
          {
            ...neutral.agents[0],
            defaultContextSummary: {
              projectId: 'agent-spaces',
              mode: 'task',
              lane: 'main',
              harness: 'codex',
              frontend: 'codex-cli',
              interaction: 'interactive',
            },
          },
        ],
      })
    ).toThrow()
  })
})
