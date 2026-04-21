/**
 * `asp self explain [prompt|reminder|launch]` — answer "why does this look
 * like this?" for the current runtime.
 *
 * WHY: raw paths and prompt dumps are useful, but agents also need a compact
 * diagnosis when something is missing or surprising (append mode, empty
 * reminder, launch-file unreadable, shared template winning over local, etc.).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import { resolveContextTemplateDetailed } from 'spaces-runtime'

import {
  type ResolveSelfContextOptions,
  type TemplateSourceInfo,
  analyzeTemplateSections,
  classifyTemplateSource,
  resolveSelfContext,
  resolveSelfTemplateContext,
} from './lib.js'

type ExplainTopic = 'prompt' | 'reminder' | 'launch'

interface ExplainOptions extends ResolveSelfContextOptions {
  json?: boolean
}

interface ExplainFinding {
  level: 'info' | 'warning'
  message: string
}

interface ExplainPayload {
  topic: ExplainTopic
  templateSource?: TemplateSourceInfo | undefined
  runModeAssumed?: string | undefined
  findings: ExplainFinding[]
}

export function registerSelfExplainCommand(self: Command): void {
  self
    .command('explain [which]')
    .description('Diagnose why a prompt, reminder, or launch looks the way it does')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Override inferred agent slug')
    .option('--launch-file <path>', 'Override HRC_LAUNCH_FILE')
    .action(async (which: string | undefined, options: ExplainOptions) => {
      try {
        const topic = normalizeTopic(which)
        const ctx = resolveSelfContext({
          ...(options.target ? { target: options.target } : {}),
          ...(options.launchFile ? { launchFile: options.launchFile } : {}),
        })

        const payload = await buildExplainPayload(topic, ctx)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
          return
        }

        renderHuman(ctx.agentName, payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self explain: ${message}\n`)
        process.exit(1)
      }
    })
}

function normalizeTopic(value: string | undefined): ExplainTopic {
  if (!value || value.length === 0) {
    return 'prompt'
  }

  if (value === 'prompt' || value === 'reminder' || value === 'launch') {
    return value
  }

  process.stderr.write(
    `self explain: invalid topic '${value}' (expected: prompt, reminder, launch)\n`
  )
  process.exit(2)
}

async function buildExplainPayload(
  topic: ExplainTopic,
  ctx: ReturnType<typeof resolveSelfContext>
): Promise<ExplainPayload> {
  switch (topic) {
    case 'prompt':
      return explainPrompt(ctx)
    case 'reminder':
      return explainReminder(ctx)
    case 'launch':
      return explainLaunch(ctx)
  }
}

async function explainPrompt(ctx: ReturnType<typeof resolveSelfContext>): Promise<ExplainPayload> {
  const findings: ExplainFinding[] = []
  const bundlePromptPath = ctx.bundleRoot ? join(ctx.bundleRoot, 'system-prompt.md') : null
  const bundlePromptExists = !!(bundlePromptPath && existsSync(bundlePromptPath))
  const templateCtx = resolveSelfTemplateContext(ctx)
  const templateSource = classifyTemplateSource(
    ctx,
    templateCtx.discovered.templateSource?.path ?? null
  )

  findings.push({
    level: 'info',
    message: formatTemplateWinnerMessage(templateSource),
  })

  if (ctx.launchReadError) {
    findings.push({
      level: 'warning',
      message: `Launch artifact could not be read: ${ctx.launchReadError}. Runtime prompt details may be incomplete.`,
    })
  }

  if (!ctx.systemPrompt) {
    findings.push({
      level: 'warning',
      message:
        'No system prompt was extracted from launch argv. The harness may have started without an explicit prompt flag, or the launch artifact is unavailable.',
    })
  } else if (ctx.systemPrompt.mode === 'append') {
    findings.push({
      level: 'info',
      message:
        'The runtime uses append mode, so the effective system prompt is passed on argv via `--append-system-prompt` rather than relying on `system-prompt.md`.',
    })
    if (!bundlePromptExists) {
      findings.push({
        level: 'info',
        message:
          'No `system-prompt.md` is present in the bundle. That is expected for append-mode Claude launches.',
      })
    }
  } else if (bundlePromptExists && bundlePromptPath) {
    findings.push({
      level: 'info',
      message: `Replace mode is active, so the bundle materializes \`system-prompt.md\` at ${bundlePromptPath}.`,
    })
  } else {
    findings.push({
      level: 'warning',
      message: 'Replace mode is active, but the bundle copy of `system-prompt.md` is missing.',
    })
  }

  if (templateCtx.template) {
    const resolved = await resolveContextTemplateDetailed(
      templateCtx.template,
      templateCtx.resolverContext,
      {
        includeReminder: false,
      }
    )
    const reports = await analyzeTemplateSections({
      template: templateCtx.template,
      resolverContext: templateCtx.resolverContext,
      zone: 'prompt',
    })

    const heartbeatOnly = reports.filter((report) => report.when?.includes('runMode=heartbeat'))
    if (heartbeatOnly.length > 0 && heartbeatOnly.every((report) => !report.included)) {
      findings.push({
        level: 'info',
        message: `Heartbeat-only prompt sections are currently excluded because self-introspection recomputes sections with assumed runMode=${templateCtx.runMode}. The launch artifact does not persist runMode.`,
      })
    }

    const failedSections = reports.filter((report) => report.error)
    if (failedSections.length > 0) {
      findings.push({
        level: 'warning',
        message: `Some prompt sections failed during recompute: ${failedSections.map((report) => report.name).join(', ')}.`,
      })
    }

    const currentPrompt = resolved.prompt?.content ?? null
    if (ctx.systemPrompt?.content && currentPrompt !== ctx.systemPrompt.content) {
      findings.push({
        level: 'warning',
        message:
          'The current template recompute differs from the launched system prompt. Durable files likely changed after this runtime started, or the bundle is stale.',
      })
    }
  }

  return {
    topic: 'prompt',
    templateSource,
    runModeAssumed: templateCtx.runMode,
    findings,
  }
}

async function explainReminder(
  ctx: ReturnType<typeof resolveSelfContext>
): Promise<ExplainPayload> {
  const findings: ExplainFinding[] = []
  const bundleReminderPath = ctx.bundleRoot ? join(ctx.bundleRoot, 'session-reminder.md') : null
  const materialized = readOptionalFile(bundleReminderPath)
  const templateCtx = resolveSelfTemplateContext(ctx)
  const templateSource = classifyTemplateSource(
    ctx,
    templateCtx.discovered.templateSource?.path ?? null
  )

  findings.push({
    level: 'info',
    message: formatTemplateWinnerMessage(templateSource),
  })

  if (!templateCtx.template) {
    findings.push({
      level: 'info',
      message: 'No context template was discovered, so reminder recompute is unavailable.',
    })
    return {
      topic: 'reminder',
      templateSource,
      runModeAssumed: templateCtx.runMode,
      findings,
    }
  }

  if (templateCtx.template.reminderSections.length === 0) {
    findings.push({
      level: 'info',
      message: 'The active context template defines no reminder sections.',
    })
    return {
      topic: 'reminder',
      templateSource,
      runModeAssumed: templateCtx.runMode,
      findings,
    }
  }

  const resolved = await resolveContextTemplateDetailed(
    templateCtx.template,
    templateCtx.resolverContext,
    {
      includePrompt: false,
    }
  )
  const reports = await analyzeTemplateSections({
    template: templateCtx.template,
    resolverContext: templateCtx.resolverContext,
    zone: 'reminder',
  })

  if (materialized) {
    findings.push({
      level: 'info',
      message: `A materialized reminder copy exists at ${bundleReminderPath}.`,
    })
  } else {
    findings.push({
      level: 'info',
      message: 'No materialized `session-reminder.md` exists in the current bundle.',
    })
  }

  if (resolved.reminder && resolved.reminder.length > 0) {
    findings.push({
      level: 'info',
      message: `The current template re-resolves a non-empty reminder (${resolved.reminder.length} chars).`,
    })
  } else {
    findings.push({
      level: 'info',
      message: 'The current template re-resolves an empty reminder.',
    })
  }

  if (!materialized && resolved.reminder) {
    findings.push({
      level: 'warning',
      message:
        'The bundle has no reminder copy, but the current template recompute is non-empty. The bundle may be stale or this runtime launched before the current reminder sources existed.',
    })
  }

  if (materialized && !resolved.reminder) {
    findings.push({
      level: 'warning',
      message:
        'A reminder exists in the bundle, but the current template recompute is empty. Durable context likely changed after launch.',
    })
  }

  if (materialized && resolved.reminder && materialized !== resolved.reminder) {
    findings.push({
      level: 'warning',
      message:
        'The materialized reminder differs from the current template recompute. This usually means the runtime is older than the current durable inputs.',
    })
  }

  const emptySections = reports
    .filter((report) => !report.included && !report.error)
    .map((report) => report.name)
  if (emptySections.length > 0) {
    findings.push({
      level: 'info',
      message: `These reminder sections currently resolve empty: ${emptySections.join(', ')}.`,
    })
  }

  const erroredSections = reports.filter((report) => report.error)
  if (erroredSections.length > 0) {
    findings.push({
      level: 'warning',
      message: `These reminder sections failed during recompute: ${erroredSections.map((report) => report.name).join(', ')}.`,
    })
  }

  return {
    topic: 'reminder',
    templateSource,
    runModeAssumed: templateCtx.runMode,
    findings,
  }
}

async function explainLaunch(ctx: ReturnType<typeof resolveSelfContext>): Promise<ExplainPayload> {
  const findings: ExplainFinding[] = []

  if (!ctx.launchFilePath) {
    findings.push({
      level: 'warning',
      message:
        'No `HRC_LAUNCH_FILE` is available, so launch argv/env/cwd cannot be inspected directly.',
    })
  } else if (ctx.launchReadError) {
    findings.push({
      level: 'warning',
      message: `The launch artifact at ${ctx.launchFilePath} could not be read: ${ctx.launchReadError}.`,
    })
  } else {
    findings.push({
      level: 'info',
      message: `The launch artifact at ${ctx.launchFilePath} is the source of truth for argv, env, cwd, ids, harness, and provider for this runtime.`,
    })
    findings.push({
      level: 'info',
      message: `Launch summary: harness=${ctx.harness ?? '(unknown)'} provider=${ctx.provider ?? '(unknown)'} argv=${ctx.launch?.argv?.length ?? 0} cwd=${ctx.launch?.cwd ?? ctx.cwd}.`,
    })
    findings.push({
      level: 'info',
      message:
        'Launch artifacts are ephemeral runtime state. To change future launches, edit durable files such as `SOUL.md`, `agent-profile.toml`, or the active context template instead.',
    })
  }

  return {
    topic: 'launch',
    findings,
  }
}

function readOptionalFile(path: string | null): string | null {
  if (!path || !existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf8')
}

function formatTemplateWinnerMessage(source: TemplateSourceInfo): string {
  switch (source.kind) {
    case 'agent-local':
      return `The active context template is the agent-local override at ${source.path}.`
    case 'shared-agents-root':
      return `The active context template comes from the shared agents root at ${source.path}, not an agent-local override.`
    case 'asp-home':
      return `The active context template comes from ASP_HOME at ${source.path}.`
    case 'custom':
      return `The active context template comes from a custom path at ${source.path}.`
    case 'built-in':
      return 'No template file won discovery, so prompt/reminder assembly falls back to the built-in default template.'
    case 'none':
      return 'No context template was discovered.'
  }
}

function renderHuman(agentName: string | null, payload: ExplainPayload): void {
  const out: string[] = []
  out.push(chalk.bold(`asp self explain — ${payload.topic} (${agentName ?? '(unknown agent)'})`))
  out.push('')

  if (payload.templateSource) {
    out.push(
      chalk.gray(
        `  template-source: ${payload.templateSource.kind}${payload.templateSource.path ? ` (${payload.templateSource.path})` : ''}`
      )
    )
  }
  if (payload.runModeAssumed) {
    out.push(chalk.gray(`  run-mode-assumed: ${payload.runModeAssumed}`))
  }
  if (payload.templateSource || payload.runModeAssumed) {
    out.push('')
  }

  for (const finding of payload.findings) {
    const prefix = finding.level === 'warning' ? chalk.yellow('WARN') : chalk.blue('INFO')
    out.push(`  ${prefix}  ${finding.message}`)
  }

  process.stdout.write(`${out.join('\n')}\n`)
}
