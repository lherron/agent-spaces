/**
 * Shared scaffolding for the `asp self memory *` subcommands.
 *
 * WHY: every memory subcommand repeated the same boilerplate — resolve the
 * self context, guard `agentName`, build a `MemoryStore`, and wrap the body in
 * an identical try/catch that writes `self memory <x>: <msg>` and exits 1. This
 * module centralizes that scaffold plus the shared `validateTarget`, the named
 * exit codes, and the store-result → exit-code/output mapping.
 */

import { CliUsageError } from 'cli-kit'

import { MemoryStore, type MemoryTargetName, type StoreResult } from 'spaces-runtime'

import { errorMessage } from '../../../helpers.js'
import { type SelfContext, resolveSelfContext } from '../lib.js'

/**
 * Named exit codes for memory write failures, so the mappers below are
 * self-documenting instead of returning bare magic numbers.
 */
export const EXIT_AMBIGUOUS = 1
export const EXIT_SCANNER_BLOCKED = 2
export const EXIT_CAP = 3
export const EXIT_DELIMITER = 4

/** Failing variant of a `MemoryStore` write result. */
export type StoreFailure = Extract<StoreResult, { ok: false }>

/** Factory used to construct the `MemoryStore`; injectable for tests. */
export type MemoryStoreFactory = (config: { agentName: string; agentsRoot: string }) => MemoryStore

const defaultMemoryStoreFactory: MemoryStoreFactory = (config) => new MemoryStore(config)

/**
 * Require a string option, exiting with the shared usage message on failure.
 *
 * Centralizes the `if (!options.X) { stderr ...; process.exit(1) }` guard
 * repeated across the memory subcommands for `--target`, `--content`, `--match`.
 */
export function requireOption(
  commandName: string,
  flag: string,
  value: string | undefined
): asserts value is string {
  if (!value) {
    process.stderr.write(`${commandName}: --${flag} is required\n`)
    process.exit(1)
  }
}

/**
 * Validate a `--target` value, exiting with the shared usage message on failure.
 */
export function validateTarget(
  commandName: string,
  value: string
): asserts value is MemoryTargetName {
  if (value !== 'memory' && value !== 'user' && value !== 'persona') {
    process.stderr.write(
      `${commandName}: invalid --target '${value}' (expected: memory, user, persona)\n`
    )
    process.exit(1)
  }
}

/**
 * Wrap a memory subcommand body in the shared try/catch that writes
 * `<commandName>: <message>` to stderr and exits 1 on an unexpected error.
 */
export async function withMemoryCommand(
  commandName: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    // Usage errors flow to the central cli-kit handler (exit 2); everything
    // else is an unexpected failure for this command (exit 1).
    if (error instanceof CliUsageError) {
      throw error
    }
    process.stderr.write(`${commandName}: ${errorMessage(error)}\n`)
    process.exit(1)
  }
}

/**
 * Run a memory subcommand body that needs the resolved self context with a
 * guaranteed `agentName`, but no `MemoryStore`. Wrapped by
 * {@link withMemoryCommand}.
 */
export async function withMemoryContext(
  commandName: string,
  fn: (ctx: SelfContext, agentName: string) => Promise<void>
): Promise<void> {
  await withMemoryCommand(commandName, async () => {
    const ctx = resolveSelfContext()
    if (!ctx.agentName) {
      process.stderr.write(`${commandName}: cannot determine agent name\n`)
      process.exit(1)
    }
    await fn(ctx, ctx.agentName)
  })
}

/**
 * Run a memory subcommand body that needs a `MemoryStore`: resolve the self
 * context, guard `agentName`, build the store, then invoke `fn`. The whole
 * thing is wrapped by {@link withMemoryCommand}.
 */
export async function withMemoryStore(
  commandName: string,
  fn: (store: MemoryStore, ctx: SelfContext, agentName: string) => Promise<void>,
  factory: MemoryStoreFactory = defaultMemoryStoreFactory
): Promise<void> {
  await withMemoryCommand(commandName, async () => {
    const ctx = resolveSelfContext()
    if (!ctx.agentName) {
      process.stderr.write(`${commandName}: cannot determine agent name\n`)
      process.exit(1)
    }
    const agentName = ctx.agentName

    const store = factory({ agentName, agentsRoot: ctx.agentsRoot })
    await fn(store, ctx, agentName)
  })
}

/**
 * Map a write failure to its process exit code, sharing the cap/delimiter/
 * scanner/ambiguous taxonomy across add/replace.
 */
export function mapWriteFailureToExitCode(result: StoreFailure): number {
  if ('error' in result) {
    if (result.error === 'ambiguous_match' || result.error === 'not_found') return EXIT_AMBIGUOUS
    if (result.error === 'cap_exceeded') return EXIT_CAP
    if (result.error === 'delimiter_in_content') return EXIT_DELIMITER
  }
  if ('category' in result) return EXIT_SCANNER_BLOCKED
  return 1
}
