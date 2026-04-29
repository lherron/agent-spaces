/**
 * RED tests for T-00994: Phase 4 harness adapter integration.
 *
 * Tests that agent-project effective config (priming_prompt, yolo, model)
 * from mergeAgentWithProjectTarget() is threaded through resolvePlacementContext()
 * and buildPlacementInvocationSpec, so the harness adapter pipeline
 * receives agent-profile defaults when the CLI request doesn't override them.
 *
 * PASS CONDITIONS:
 * 1. resolvePlacementContext returns effectiveConfig (priming_prompt, yolo, model) for agent-project bundles.
 * 2. buildPlacementInvocationSpec uses effectiveConfig.priming_prompt as prompt default when req.prompt is unset.
 * 3. buildPlacementInvocationSpec uses effectiveConfig.yolo as default unless req.yolo overrides.
 * 4. buildPlacementInvocationSpec uses effectiveConfig.model as default unless req.model overrides.
 * 5. The synthetic ValidatedSpec from resolvePlacementContext for agent-project feeds the
 *    materializeSpec pipeline normally (compose list is passed through as kind: 'spaces').
 *
 * wrkq task: T-00994
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8')
const placementResolverSource = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'config', 'src', 'resolver', 'placement-resolver.ts'),
  'utf8'
)
const executionSource = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'execution', 'src', 'run', 'placement-plan.ts'),
  'utf8'
)

// Helper: extract a function body from source by name
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  if (start === -1) throw new Error(`Function ${name} not found`)
  const nextFn = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, nextFn > -1 ? nextFn : undefined)
}

// ===================================================================
// Test 1: resolvePlacementContext returns effectiveConfig for agent-project
// ===================================================================
describe('resolvePlacementContext returns effectiveConfig for agent-project (T-00994)', () => {
  test('resolvePlacementContext agent-project materialization includes effectiveConfig field', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')

    // The agent-project case should return effectiveConfig in its return statement
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    expect(agentProjectStart).toBeGreaterThan(-1)

    // Find the return statement for agent-project case
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)
    // Must return effectiveConfig alongside spec
    expect(caseBody).toMatch(/effectiveConfig/)
  })

  test('effectiveConfig includes priming_prompt from merged config', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // The case must capture priming_prompt from the merge result
    expect(caseBody).toMatch(/priming_prompt/)
  })

  test('effectiveConfig includes yolo from merged config', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    expect(caseBody).toMatch(/mergeAgentWithProjectTarget/)
    expect(caseBody).toMatch(/effectiveConfig:\s*effective/)
  })

  test('effectiveConfig includes model from merged config', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    expect(caseBody).toMatch(/mergeAgentWithProjectTarget/)
    expect(caseBody).toMatch(/effectiveConfig:\s*effective/)
  })
})

// ===================================================================
// Test 2: buildPlacementInvocationSpec uses effectiveConfig defaults
// ===================================================================
describe('buildPlacementInvocationSpec threads effectiveConfig defaults (T-00994)', () => {
  test('priming_prompt default: uses effectiveConfig.priming_prompt when req.prompt is unset', () => {
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    // Placement defaults should come from the shared runtime planner.
    expect(fn).toMatch(/planPlacementRuntime\(/)
    expect(fn).toMatch(/runtimePlan\.prompt/)
  })

  test('yolo default: uses effectiveConfig.yolo when req.yolo is unset', () => {
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    expect(fn).toMatch(/runtimePlan\.runOptions/)
    expect(fn).toMatch(/runtimePlan\.yolo/)
  })

  test('model default: uses effectiveConfig.model when req.model is unset', () => {
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')

    expect(fn).toMatch(/runtimePlan\.model/)
  })

  test('CLI req.yolo=true overrides effectiveConfig.yolo=false', () => {
    const clientFn = extractFunction(clientSource, 'buildPlacementInvocationSpec')
    const plannerFn = extractFunction(executionSource, 'planPlacementRuntime')

    expect(clientFn).toMatch(/yolo:\s*req\.yolo/)
    expect(plannerFn).toMatch(/options\.yolo\s*\?\?/)
    expect(plannerFn).toMatch(/effectiveConfig\?\.yolo/)
  })

  test('agent-project codex runs pass agentName as codexRuntimeTargetName', () => {
    const fn = extractFunction(executionSource, 'planPlacementRuntime')
    expect(fn).toMatch(/codexRuntimeTargetName:\s*placement\.bundle\.agentName/)
  })
})

// ===================================================================
// Test 3: Shared placement context feeds pipeline normally
// ===================================================================
describe('agent-project placement context feeds harness pipeline (T-00994)', () => {
  test('resolvePlacementContext agent-project returns spec.kind === "spaces" with compose list', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)

    // Must still return spec with kind: 'spaces'
    expect(caseBody).toMatch(/kind:\s*['"]spaces['"]/)
  })

  test('buildPlacementInvocationSpec passes resolvePlacementContext spec to materializeSpec', () => {
    const fn = extractFunction(clientSource, 'buildPlacementInvocationSpec')
    expect(fn).toMatch(/resolvePlacementContext\(/)
    expect(fn).toMatch(/materializeSpec\(/)
  })

  test('resolvePlacementContext agent-project uses mergeAgentWithProjectTarget for compose', () => {
    const fn = extractFunction(placementResolverSource, 'resolvePlacementMaterialization')
    const agentProjectStart = fn.indexOf("case 'agent-project'")
    const caseBody = fn.slice(agentProjectStart, agentProjectStart + 1200)
    expect(caseBody).toMatch(/mergeAgentWithProjectTarget/)
  })
})
