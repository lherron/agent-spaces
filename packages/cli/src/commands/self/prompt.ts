/**
 * `asp self prompt [system|reminder|priming]` — inspect effective prompt
 * surfaces for the running agent.
 *
 * WHY: `inspect` tells you prompt counts, but not the actual content. This
 * command shows the launched system prompt, the materialized or recomputed
 * reminder, and the priming prompt, with optional section-level diagnostics
 * derived from the current context template.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import { resolveContextTemplateDetailed } from 'spaces-runtime'

import {
  type ResolveSelfContextOptions,
  type SectionReport,
  type TemplateSourceInfo,
  analyzeTemplateSections,
  byteCount,
  charCount,
  classifyTemplateSource,
  extractPrimingPrompt,
  resolveSelfContext,
  resolveSelfTemplateContext,
} from './lib.js'

type PromptWhich = 'system' | 'reminder' | 'priming'

interface PromptOptions extends ResolveSelfContextOptions {
  json?: boolean
  raw?: boolean
  sections?: boolean
  recompute?: boolean
}

interface PromptPayload {
  which: PromptWhich
  content: string | null
  chars: number
  bytes: number
  source: string
  mode?: 'append' | 'replace' | undefined
  path?: string | null | undefined
  templateSource?: TemplateSourceInfo | undefined
  sectionReports?: SectionReport[] | undefined
  sectionRunMode?: string | undefined
  recomputedMatchesLaunch?: boolean | null | undefined
}

export function registerSelfPromptCommand(self: Command): void {
  self
    .command('prompt [which]')
    .description('Show effective system prompt, reminder, or priming prompt')
    .option('--json', 'Emit machine-readable JSON')
    .option('--raw', 'Write only the prompt content')
    .option('--sections', 'Recompute per-section source and size diagnostics from the template')
    .option(
      '--recompute',
      'For reminder, recompute from the current template instead of reading bundle output'
    )
    .option('--target <name>', 'Override inferred agent slug')
    .option('--launch-file <path>', 'Override HRC_LAUNCH_FILE')
    .action(async (which: string | undefined, options: PromptOptions) => {
      try {
        const normalized = normalizeWhich(which)
        validateOptions(normalized, options)

        const ctx = resolveSelfContext({
          ...(options.target ? { target: options.target } : {}),
          ...(options.launchFile ? { launchFile: options.launchFile } : {}),
        })

        const payload = await buildPromptPayload(normalized, ctx, options)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
          return
        }

        if (options.raw) {
          if (payload.content) {
            process.stdout.write(`${payload.content}\n`)
          }
          return
        }

        renderHuman(ctx.agentName, payload, !!options.sections, !!options.recompute)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self prompt: ${message}\n`)
        process.exit(1)
      }
    })
}

function normalizeWhich(value: string | undefined): PromptWhich {
  if (!value || value.length === 0) {
    return 'system'
  }

  if (value === 'system' || value === 'reminder' || value === 'priming') {
    return value
  }

  process.stderr.write(
    `self prompt: invalid prompt kind '${value}' (expected: system, reminder, priming)\n`
  )
  process.exit(2)
}

function validateOptions(which: PromptWhich, options: PromptOptions): void {
  if (options.raw && options.sections) {
    process.stderr.write('self prompt: --raw and --sections are mutually exclusive\n')
    process.exit(2)
  }

  if (options.recompute && which !== 'reminder') {
    process.stderr.write('self prompt: --recompute is only supported for reminder\n')
    process.exit(2)
  }

  if (options.sections && which === 'priming') {
    process.stderr.write('self prompt: --sections is only supported for system and reminder\n')
    process.exit(2)
  }
}

async function buildPromptPayload(
  which: PromptWhich,
  ctx: ReturnType<typeof resolveSelfContext>,
  options: PromptOptions
): Promise<PromptPayload> {
  switch (which) {
    case 'system':
      return buildSystemPayload(ctx, options)
    case 'reminder':
      return buildReminderPayload(ctx, options)
    case 'priming':
      return buildPrimingPayload(ctx)
  }
}

async function buildSystemPayload(
  ctx: ReturnType<typeof resolveSelfContext>,
  options: PromptOptions
): Promise<PromptPayload> {
  const content = ctx.systemPrompt?.content ?? null
  const bundlePath = ctx.bundleRoot ? join(ctx.bundleRoot, 'system-prompt.md') : null
  const payload: PromptPayload = {
    which: 'system',
    content,
    chars: charCount(content),
    bytes: byteCount(content),
    source: ctx.systemPrompt
      ? `launch argv (${ctx.systemPrompt.mode === 'append' ? '--append-system-prompt' : '--system-prompt'})`
      : 'launch argv (no system prompt flag found)',
    ...(ctx.systemPrompt ? { mode: ctx.systemPrompt.mode } : {}),
    ...(bundlePath ? { path: bundlePath } : {}),
  }

  if (!options.sections) {
    return payload
  }

  const templateCtx = resolveSelfTemplateContext(ctx)
  const templateSource = classifyTemplateSource(
    ctx,
    templateCtx.discovered.templateSource?.path ?? null
  )
  const sectionReports = templateCtx.template
    ? await analyzeTemplateSections({
        template: templateCtx.template,
        resolverContext: templateCtx.resolverContext,
        zone: 'prompt',
      })
    : []

  let recomputedMatchesLaunch: boolean | null = null
  if (templateCtx.template) {
    const resolved = await resolveContextTemplateDetailed(
      templateCtx.template,
      templateCtx.resolverContext,
      {
        includeReminder: false,
      }
    )
    recomputedMatchesLaunch = (resolved.prompt?.content ?? null) === content
  }

  return {
    ...payload,
    templateSource,
    sectionReports,
    sectionRunMode: templateCtx.runMode,
    recomputedMatchesLaunch,
  }
}

async function buildReminderPayload(
  ctx: ReturnType<typeof resolveSelfContext>,
  options: PromptOptions
): Promise<PromptPayload> {
  const bundlePath = ctx.bundleRoot ? join(ctx.bundleRoot, 'session-reminder.md') : null
  const bundleContent = readOptionalFile(bundlePath)

  let content = options.recompute ? null : bundleContent
  let source = options.recompute ? 'template recompute' : 'bundle/session-reminder.md'
  let templateSource: TemplateSourceInfo | undefined
  let sectionReports: SectionReport[] | undefined
  let sectionRunMode: string | undefined

  if (options.recompute || options.sections) {
    const templateCtx = resolveSelfTemplateContext(ctx)
    templateSource = classifyTemplateSource(
      ctx,
      templateCtx.discovered.templateSource?.path ?? null
    )
    sectionRunMode = templateCtx.runMode

    if (templateCtx.template) {
      if (options.sections) {
        sectionReports = await analyzeTemplateSections({
          template: templateCtx.template,
          resolverContext: templateCtx.resolverContext,
          zone: 'reminder',
        })
      }

      if (options.recompute) {
        const resolved = await resolveContextTemplateDetailed(
          templateCtx.template,
          templateCtx.resolverContext,
          {
            includePrompt: false,
          }
        )
        content = resolved.reminder ?? null
      }
    }
  }

  if (options.recompute && !templateSource) {
    source = 'template recompute (no context template found)'
  }

  return {
    which: 'reminder',
    content,
    chars: charCount(content),
    bytes: byteCount(content),
    source,
    ...(bundlePath ? { path: bundlePath } : {}),
    ...(templateSource ? { templateSource } : {}),
    ...(sectionReports ? { sectionReports } : {}),
    ...(sectionRunMode ? { sectionRunMode } : {}),
  }
}

function buildPrimingPayload(ctx: ReturnType<typeof resolveSelfContext>): PromptPayload {
  const fromArgv = extractPrimingPrompt(ctx.launch?.argv ?? [])
  return {
    which: 'priming',
    content: ctx.primingPrompt,
    chars: charCount(ctx.primingPrompt),
    bytes: byteCount(ctx.primingPrompt),
    source: fromArgv ? 'launch argv (after --)' : 'ASP_PRIMING_PROMPT env fallback',
  }
}

function readOptionalFile(path: string | null): string | null {
  if (!path || !existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf8')
}

function renderHuman(
  agentName: string | null,
  payload: PromptPayload,
  showSections: boolean,
  recompute: boolean
): void {
  const out: string[] = []
  out.push(chalk.bold(`asp self prompt — ${payload.which} (${agentName ?? '(unknown agent)'})`))
  out.push('')
  out.push(chalk.gray(`  source: ${payload.source}`))
  if (payload.mode) {
    out.push(chalk.gray(`  mode:   ${payload.mode}`))
  }
  out.push(chalk.gray(`  chars:  ${payload.chars}`))
  out.push(chalk.gray(`  bytes:  ${payload.bytes}`))
  if (payload.path) {
    out.push(chalk.gray(`  path:   ${payload.path}`))
  }
  if (payload.templateSource) {
    out.push(
      chalk.gray(
        `  template: ${payload.templateSource.kind}${payload.templateSource.path ? ` (${payload.templateSource.path})` : ''}`
      )
    )
  }
  if (payload.sectionRunMode) {
    out.push(chalk.gray(`  section-run-mode: ${payload.sectionRunMode} (assumed)`))
  }
  if (typeof payload.recomputedMatchesLaunch === 'boolean') {
    out.push(
      chalk.gray(
        `  recomputed-vs-launch: ${payload.recomputedMatchesLaunch ? 'match' : 'different'}`
      )
    )
  }

  if (showSections) {
    out.push('')
    out.push(chalk.bold(`sections${recompute ? ' (recomputed)' : ''}`))
    if (!payload.sectionReports || payload.sectionReports.length === 0) {
      out.push(chalk.gray('  (no section data available)'))
    } else {
      for (const report of payload.sectionReports) {
        const state = report.error
          ? chalk.yellow('!')
          : report.included
            ? chalk.green('✓')
            : chalk.gray('·')
        out.push(
          `  ${state} ${report.name}  chars=${report.chars} bytes=${report.bytes}  ${chalk.gray(report.source)}`
        )
        if (report.when) {
          out.push(chalk.gray(`      when: ${report.when}`))
        }
        if (report.error) {
          out.push(chalk.yellow(`      error: ${report.error}`))
        }
      }
    }
  }

  out.push('')
  out.push(chalk.bold('content'))
  out.push(payload.content && payload.content.length > 0 ? payload.content : chalk.gray('(empty)'))

  process.stdout.write(`${out.join('\n')}\n`)
}
