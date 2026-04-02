/**
 * RED tests for T-00994: Phase 4 harness adapter integration.
 *
 * Tests that agent-project effective config (priming_prompt, yolo, model)
 * from mergeAgentWithProjectTarget() is threaded through placementToSpec
 * and buildPlacementInvocationSpec, so the harness adapter pipeline
 * receives agent-profile defaults when the CLI request doesn't override them.
 *
 * PASS CONDITIONS:
 * 1. placementToSpec returns effectiveConfig (priming_prompt, yolo, model) for agent-project bundles.
 * 2. buildPlacementInvocationSpec uses effectiveConfig.priming_prompt as prompt default when req.prompt is unset.
 * 3. buildPlacementInvocationSpec uses effectiveConfig.yolo as default unless req.yolo overrides.
 * 4. buildPlacementInvocationSpec uses effectiveConfig.model as default unless req.model overrides.
 * 5. The synthetic ValidatedSpec from placementToSpec for agent-project feeds the
 *    materializeSpec pipeline normally (compose list is passed through as kind: 'spaces').
 *
 * wrkq task: T-00994
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8')

// Helper: extract a function body from source by name
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  if (start === -1) throw new Error(`Function ${name} not found`)
  const nextFn = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, nextFn > -1 ? nextFn : undefined)
}

// ===================================================================
// Test 1: placementToSpec returns effectiveConfig for agent-project
// ===================================================================
describe('placementToSpec returns effectiveConfig for agent-project (T-00994)', () => {
  test('placementToSpec return type includes effectiveConfig field', () => {
    // RED: Currently placementToSpec returns { spec, agentRoot, projectRoot }.
    // After Phase 4, it must also return effectiveConfig (at least for agent-project).
    // We verify the agent-project case returns an effectiveConfig object.
    const fn = extractFunction(clientSource, 'placementToSpec')

    // The agent-project case should return effectiveConfig in its return statement
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    expect(agentProjectStart).toBeGreaterThan(-1)

    // Find the return statement for agent-project case
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)
    // Must return effectiveConfig alongside spec
    expect(caseBody).toMatch(/effectiveConfig/)
  })

  test('effectiveConfig includes priming_prompt from merged config', () => {
    // RED: Currently the agent-project case in placementToSpec only extracts
    // .compose from mergeAgentWithProjectTarget result, discarding priming_prompt.
    const fn = extractFunction(clientSource, 'placementToSpec')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // The case must capture priming_prompt from the merge result
    expect(caseBody).toMatch(/priming_prompt/)
  })

  test('effectiveConfig includes yolo from merged config', () => {
    // RED: Currently the agent-project case discards yolo from merge result.
    const fn = extractFunction(clientSource, 'placementToSpec')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // The case must capture yolo from the merge result (beyond just compose)
    // We check that the return includes yolo as part of effectiveConfig
    expect(caseBody).toMatch(/effectiveConfig.*yolo|yolo.*effectiveConfig/)
  })

  test('effectiveConfig includes model from merged config', () => {
    // RED: Currently the agent-project case discards model from merge result.
    const fn = extractFunction(clientSource, 'placementToSpec')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // The case must capture model from the merge result
    expect(caseBody).toMatch(/effectiveConfig.*model|model.*effectiveConfig/)
  })
})

// ===================================================================
// Test 2: buildPlacementInvocationSpec uses effectiveConfig defaults
// ===================================================================
describe('buildPlacementInvocationSpec threads effectiveConfig defaults (T-00994)', () => {
  test('priming_prompt default: uses effectiveConfig.priming_prompt when req.prompt is unset', () => {
    // RED: Currently buildPlacementInvocationSpec only uses req.prompt
    // (line ~1500: `...(req.prompt ? { prompt: req.prompt } : {})`).
    // After Phase 4, when req.prompt is unset and placementToSpec returns
    // effectiveConfig.priming_prompt, it must be used as the prompt default.
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    // The function must reference effectiveConfig (from placementToSpec result)
    expect(fn).toMatch(/effectiveConfig/)

    // It must use effectiveConfig.priming_prompt or effectiveConfig?.priming_prompt
    // as a fallback for prompt in runOptions
    expect(fn).toMatch(/priming_prompt/)
  })

  test('yolo default: uses effectiveConfig.yolo when req.yolo is unset', () => {
    // RED: Currently buildPlacementInvocationSpec directly uses req.yolo
    // (line ~1499: `yolo: req.yolo`). After Phase 4, when req.yolo is
    // undefined, it must fall back to effectiveConfig.yolo.
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    // Must reference effectiveConfig for yolo fallback
    // Pattern: `req.yolo ?? effectiveConfig?.yolo` or similar
    expect(fn).toMatch(/effectiveConfig[.?]*yolo/)
  })

  test('model default: uses effectiveConfig.model when req.model is unset', () => {
    // RED: Currently buildPlacementInvocationSpec uses modelResolution.info.model
    // unconditionally (line ~1496). After Phase 4, effectiveConfig.model should
    // influence model selection (e.g., passed to resolveModel or used as fallback).
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    // Must use effectiveConfig.model somewhere in model resolution
    expect(fn).toMatch(/effectiveConfig[.?]*model/)
  })

  test('CLI req.yolo=true overrides effectiveConfig.yolo=false', () => {
    // RED: After Phase 4, when BOTH req.yolo and effectiveConfig.yolo are present,
    // req.yolo must win. We verify the precedence pattern in the source.
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    // The yolo line in runOptions must have req.yolo taking precedence:
    // Pattern: `req.yolo ?? effectiveConfig?.yolo` (nullish coalescing = req wins)
    // NOT: `effectiveConfig?.yolo ?? req.yolo` (that would be wrong precedence)
    const yoloLine = fn.match(/yolo:\s*(.+)/)?.[1] ?? ''
    // req.yolo must appear BEFORE effectiveConfig in the expression
    const reqIdx = yoloLine.indexOf('req.yolo')
    const effIdx = yoloLine.indexOf('effectiveConfig')
    expect(reqIdx).toBeGreaterThanOrEqual(0)
    expect(effIdx).toBeGreaterThan(reqIdx)
  })
})

// ===================================================================
// Test 3: Synthetic manifest for agent-project feeds pipeline normally
// ===================================================================
describe('agent-project synthetic manifest feeds harness pipeline (T-00994)', () => {
  test('placementToSpec agent-project returns spec.kind === "spaces" with compose list', () => {
    // GREEN (baseline): This already works — placementToSpec returns
    // { kind: 'spaces', spaces: compose } for agent-project.
    // We verify this still holds after Phase 4 changes.
    const fn = extractFunction(clientSource, 'placementToSpec')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // Must still return spec with kind: 'spaces'
    expect(caseBody).toMatch(/kind:\s*['"]spaces['"]/)
  })

  test('buildPlacementInvocationSpec passes placementToSpec spec to materializeSpec', () => {
    // GREEN (baseline): Verify the pipeline connection is maintained.
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')
    expect(fn).toMatch(/placementToSpec\(/)
    expect(fn).toMatch(/materializeSpec\(/)
  })

  test('placementToSpec agent-project uses mergeAgentWithProjectTarget for compose', () => {
    // GREEN (baseline): Verify agent-project case calls mergeAgentWithProjectTarget.
    const fn = extractFunction(clientSource, 'placementToSpec')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)
    expect(caseBody).toMatch(/mergeAgentWithProjectTarget/)
  })
})
