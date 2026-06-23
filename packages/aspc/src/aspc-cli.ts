/**
 * `aspc` CLI (T-04133): output-manifest preparation and the deterministic
 * release gate. Distinct from `aspc-facade`, which serves the JSON-RPC compile
 * transport; `aspc manifest` and `aspc verify-release` are batch surfaces that
 * materialize/compare WITHOUT starting a harness or invoking an LLM.
 *
 * Usage:
 *   aspc manifest --request <file> --asp-home <dir> [--compile-context <json>]
 *   aspc verify-release --baseline <bin> --candidate <bin> --corpus <dir>
 *                       [--compile-context <json>] [--bless]
 */
import { readFileSync } from 'node:fs'

import type { CompileContext, RuntimeCompileRequest } from 'spaces-runtime-contracts'

import { buildOutputManifest } from './manifest.js'
import { verifyRelease } from './verify-release.js'

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined || !arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true)
    } else {
      flags.set(key, next)
      i += 1
    }
  }
  return flags
}

function requireString(flags: Map<string, string | true>, key: string): string {
  const value = flags.get(key)
  if (typeof value !== 'string') {
    throw new Error(`aspc: missing required --${key} <value>`)
  }
  return value
}

function parseCompileContext(flags: Map<string, string | true>): CompileContext | undefined {
  const raw = flags.get('compile-context')
  if (typeof raw !== 'string') return undefined
  return JSON.parse(raw) as CompileContext
}

async function runManifest(args: string[]): Promise<number> {
  const flags = parseFlags(args)
  const requestPath = requireString(flags, 'request')
  const aspHome = requireString(flags, 'asp-home')
  const compileContext = parseCompileContext(flags)
  const compileRequest = JSON.parse(readFileSync(requestPath, 'utf8')) as RuntimeCompileRequest

  const result = await buildOutputManifest({
    compileRequest,
    aspHome,
    ...(compileContext !== undefined ? { compileContext } : {}),
  })
  if (!result.ok) {
    process.stderr.write(`aspc manifest: compile failed\n${JSON.stringify(result.diagnostics)}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(result.manifest)}\n`)
  return 0
}

function runVerifyRelease(args: string[]): number {
  const flags = parseFlags(args)
  const baseline = requireString(flags, 'baseline')
  const candidate = requireString(flags, 'candidate')
  const corpus = requireString(flags, 'corpus')
  const compileContext = parseCompileContext(flags)
  const bless = flags.get('bless') === true

  const result = verifyRelease({
    baseline,
    candidate,
    corpus,
    bless,
    ...(compileContext !== undefined ? { compileContext } : {}),
  })
  process.stdout.write(`${JSON.stringify(result.report)}\n`)
  return result.exitCode
}

export async function runAspcCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'manifest':
      return runManifest(rest)
    case 'verify-release':
      return runVerifyRelease(rest)
    default:
      process.stderr.write(
        `Unknown command: ${command ?? '(none)'}\nUsage:\n  aspc manifest --request <file> --asp-home <dir> [--compile-context <json>]\n  aspc verify-release --baseline <bin> --candidate <bin> --corpus <dir> [--compile-context <json>] [--bless]\n`
      )
      return 1
  }
}

export async function main(): Promise<void> {
  try {
    const code = await runAspcCli(process.argv.slice(2))
    process.exit(code)
  } catch (error) {
    process.stderr.write(`aspc: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
