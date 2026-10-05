/** Argument and error helpers shared by the broker's CLI subcommands. */

export function formatError(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const message = err instanceof Error ? err.message : 'Validation failed'
    return `${message}\n${JSON.stringify((err as { issues: unknown }).issues, null, 2)}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
