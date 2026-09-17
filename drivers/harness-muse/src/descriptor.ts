/**
 * Muse serve launch descriptor (spike 1 pure function).
 *
 * Provisional shape: the broker driver (§3) and the CLI adapter (spike 11)
 * both consume the composed bundle, but model/effort/approval stay wire-side
 * (`session/setModel`, `session/setReasoningEffort`, `session/setApprovalMode`
 * — names spike 2 confirmed against the live schema), so they travel as
 * descriptor DATA, never as `serve` CLI flags. Spike 2 killed the
 * `--workspace` flag (no such `serve` option; the workspace travels as
 * `session/start.workspaceRoot`), so the spawn shape is bare
 * `serve --trust-workspace` and `workspace` feeds `session/start`.
 */
import { join } from 'node:path'
import { MUSE_WORKSPACE_DIRNAME } from './composer.js'

export interface BuildMuseServeDescriptorOptions {
  serveBin?: string | undefined
  workspace?: string | undefined
  model?: string | undefined
  reasoningEffort?: string | undefined
  approvalPolicy?: string | undefined
  extraArgs?: string[] | undefined
}

export interface MuseServeDescriptor {
  bin: string
  args: string[]
  workspace: string
  model?: string | undefined
  reasoningEffort?: string | undefined
  approvalPolicy?: string | undefined
}

export const DEFAULT_MUSE_SERVE_BIN = 'muse'

export function buildMuseServeDescriptor(
  bundle: { rootDir: string; workspaceDir?: string | undefined },
  options: BuildMuseServeDescriptorOptions = {}
): MuseServeDescriptor {
  const workspace =
    options.workspace ?? bundle.workspaceDir ?? join(bundle.rootDir, MUSE_WORKSPACE_DIRNAME)
  const bin = options.serveBin ?? DEFAULT_MUSE_SERVE_BIN
  const args = ['serve', '--trust-workspace', ...(options.extraArgs ?? [])]
  const descriptor: MuseServeDescriptor = { bin, args, workspace }
  if (options.model !== undefined) descriptor.model = options.model
  if (options.reasoningEffort !== undefined) descriptor.reasoningEffort = options.reasoningEffort
  if (options.approvalPolicy !== undefined) descriptor.approvalPolicy = options.approvalPolicy
  return descriptor
}
