/**
 * ClaudeAgentSdkAdapter - Harness adapter for Claude Agent SDK
 *
 * Delegates materialization and invocation behavior to the Claude adapter,
 * but uses a distinct harness ID and output path.
 */

import { join } from 'node:path'
import type {
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
} from 'spaces-config'
import { claudeAdapter } from './claude-adapter.js'

export class ClaudeAgentSdkAdapter implements HarnessAdapter {
  readonly id = 'claude-agent-sdk' as const
  readonly name = 'Claude Agent SDK'

  async detect(): Promise<HarnessDetection> {
    return claudeAdapter.detect()
  }

  validateSpace(input: MaterializeSpaceInput): HarnessValidationResult {
    return claudeAdapter.validateSpace(input)
  }

  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    return claudeAdapter.materializeSpace(input, cacheDir, options)
  }

  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const result = await claudeAdapter.composeTarget(input, outputDir, options)
    const bundle: ComposedTargetBundle = {
      ...result.bundle,
      harnessId: this.id,
    }
    return { ...result, bundle }
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    return claudeAdapter.buildRunArgs(bundle, options)
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, this.id)
  }
}

export const claudeAgentSdkAdapter = new ClaudeAgentSdkAdapter()
