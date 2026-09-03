/**
 * `asp self inspect` — zero-arg overview of the current agent's runtime.
 *
 * Reads AGENT_LAUNCH_FILE + the launch artifact and emits a consumer-oriented
 * identity and wrkq-client view alongside paths and prompt metadata.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { errorMessage } from '../../helpers.js'
import {
  type InspectionValue,
  type SelfContext,
  buildSelfInspection,
  byteCount,
  charCount,
  redactSensitiveEnvironment,
  resolveSelfContext,
} from './lib.js'

interface InspectOptions {
  json?: boolean
  rawEnv?: boolean
  target?: string
  launchFile?: string
}

export function registerSelfInspectCommand(self: Command): void {
  self
    .command('inspect')
    .alias('introspect')
    .description("Show a zero-arg overview of this agent's runtime launch")
    .option('--json', 'Emit machine-readable JSON')
    .option('--raw-env', 'Include a redacted diagnostic environment listing')
    .option('--target <name>', 'Override inferred agent slug')
    .option('--launch-file <path>', 'Override AGENT_LAUNCH_FILE')
    .action(async (options: InspectOptions) => {
      try {
        const ctx = resolveSelfContext({
          ...(options.target ? { target: options.target } : {}),
          ...(options.launchFile ? { launchFile: options.launchFile } : {}),
        })

        const systemPromptChars = charCount(ctx.systemPrompt?.content)
        const systemPromptBytes = byteCount(ctx.systemPrompt?.content)
        const primingChars = charCount(ctx.primingPrompt)

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(buildInspectJsonPayload(ctx, options.rawEnv === true), null, 2)}\n`
          )
          return
        }

        renderHuman(
          ctx,
          { systemPromptChars, systemPromptBytes, primingChars },
          options.rawEnv === true
        )
      } catch (err) {
        process.stderr.write(`self inspect: ${errorMessage(err)}\n`)
        process.exit(1)
      }
    })
}

interface DerivedCounts {
  systemPromptChars: number
  systemPromptBytes: number
  primingChars: number
}

function buildInspectJsonPayload(
  ctx: SelfContext,
  includeRawEnv: boolean
): Record<string, unknown> {
  const inspection = buildSelfInspection(ctx)
  return {
    agentName: ctx.agentName,
    projectId: ctx.projectId,
    envSource: ctx.envSource,
    identity: inspection.identity,
    collaboration: inspection.collaboration,
    authoritySource: inspection.authoritySource,
    compatibility: inspection.compatibility,
    runtime: {
      harness: ctx.harness,
      provider: ctx.provider,
    },
    paths: {
      cwd: ctx.cwd,
      aspHome: ctx.aspHome,
      agentsRoot: ctx.agentsRoot,
      agentRoot: ctx.agentRoot,
      bundleRoot: ctx.bundleRoot,
      launchFile: ctx.launchFilePath,
    },
    prompt: {
      system: ctx.systemPrompt
        ? {
            mode: ctx.systemPrompt.mode,
            chars: charCount(ctx.systemPrompt.content),
            bytes: byteCount(ctx.systemPrompt.content),
          }
        : null,
      primingChars: charCount(ctx.primingPrompt),
    },
    diagnostics: {
      launchReadError: ctx.launchReadError,
      ...(includeRawEnv ? { rawEnvironment: redactSensitiveEnvironment(ctx.injectedEnv) } : {}),
    },
  }
}

function renderInspectionValue(value: InspectionValue): string {
  if (value.value === null) return '(none)'
  if (value.source === 'derived') return `${value.value} (derived from ${value.derivedFrom})`
  if (value.source === 'compatibility') return `${value.value} (compatibility: ${value.key})`
  return value.value
}

function renderHuman(
  ctx: ReturnType<typeof resolveSelfContext>,
  counts: DerivedCounts,
  includeRawEnv: boolean
): void {
  const bold = (s: string): string => chalk.bold(s)
  const dim = (s: string): string => chalk.gray(s)
  const warn = (s: string): string => chalk.yellow(s)

  const out: string[] = []
  out.push(bold(`asp self inspect — ${ctx.agentName ?? warn('(unknown agent)')}`))
  out.push('')

  const inspection = buildSelfInspection(ctx)

  out.push(bold('identity'))
  out.push(dim(`  source:      ${ctx.envSource}`))
  out.push(dim(`  agent:       ${renderInspectionValue(inspection.identity.agent)}`))
  out.push(dim(`  project:     ${renderInspectionValue(inspection.identity.project)}`))
  out.push(dim(`  scope:       ${renderInspectionValue(inspection.identity.scope)}`))
  out.push(dim(`  session:     ${renderInspectionValue(inspection.identity.session)}`))
  out.push(dim(`  task:        ${renderInspectionValue(inspection.identity.task)}`))
  out.push(dim(`  lane:        ${renderInspectionValue(inspection.identity.lane)}`))
  out.push('')

  out.push(bold('wrkq client'))
  out.push(
    dim(`  WRKQ_PRINCIPAL_REF  ${renderInspectionValue(inspection.collaboration.principal)}`)
  )
  out.push(dim(`  WRKQ_DB             ${renderInspectionValue(inspection.collaboration.database)}`))
  out.push(
    dim(`  WRKQD_TOKEN_FILE    ${renderInspectionValue(inspection.collaboration.tokenFile)}`)
  )
  out.push('')

  const authorityEntries = Object.entries(inspection.authoritySource).filter(
    ([, value]) => value.value !== null
  )
  if (authorityEntries.length > 0) {
    out.push(bold('HRC authority source (not direct wrkq settings)'))
    for (const [, value] of authorityEntries) {
      out.push(dim(`  ${value.key}  ${value.value}`))
    }
    out.push('')
  }

  const compatibilityEntries = Object.entries(inspection.compatibility)
  if (compatibilityEntries.length > 0) {
    out.push(bold('compatibility aliases'))
    for (const [key, value] of compatibilityEntries) {
      out.push(dim(`  ${key}  ${value}`))
    }
    out.push('')
  }
  out.push('')

  out.push(bold('runtime'))
  out.push(dim(`  harness:     ${ctx.harness ?? '(unknown)'}`))
  out.push(dim(`  provider:    ${ctx.provider ?? '(unknown)'}`))
  out.push('')

  out.push(bold('paths'))
  out.push(dim(`  cwd:         ${ctx.cwd}`))
  out.push(dim(`  asp-home:    ${ctx.aspHome}`))
  out.push(dim(`  agents-root: ${ctx.agentsRoot}`))
  out.push(dim(`  agent-root:  ${ctx.agentRoot ?? '(none)'}`))
  out.push(dim(`  bundle-root: ${ctx.bundleRoot ?? '(none)'}`))
  out.push(dim(`  launch-file: ${ctx.launchFilePath ?? '(none)'}`))
  if (ctx.launchReadError) {
    out.push(warn(`  launch-read-error: ${ctx.launchReadError}`))
  }
  out.push('')

  if (includeRawEnv) {
    out.push(bold('raw environment (diagnostic; sensitive values redacted)'))
    for (const [key, value] of Object.entries(redactSensitiveEnvironment(ctx.injectedEnv))) {
      out.push(dim(`  ${key}  ${value}`))
    }
    out.push('')
  }

  out.push(bold('prompt'))
  if (ctx.systemPrompt) {
    out.push(
      dim(
        `  system:      mode=${ctx.systemPrompt.mode} chars=${counts.systemPromptChars} bytes=${counts.systemPromptBytes}`
      )
    )
  } else {
    out.push(dim('  system:      (none extracted from argv)'))
  }
  if (ctx.primingPrompt) {
    out.push(dim(`  priming:     chars=${counts.primingChars}`))
  } else {
    out.push(dim('  priming:     (none)'))
  }
  out.push('')

  out.push(dim('Use `asp self paths` to see every editable and derived path.'))
  out.push(dim('Use `asp self prompt system|reminder|priming` for content.'))

  process.stdout.write(`${out.join('\n')}\n`)
}
