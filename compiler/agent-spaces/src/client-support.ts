import type { AgentSpacesError } from './types.js'

export class CodedError extends Error {
  readonly code: NonNullable<AgentSpacesError['code']>
  constructor(message: string, code: NonNullable<AgentSpacesError['code']>) {
    super(message)
    this.code = code
  }
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function formatDisplayCommand(
  commandPath: string,
  args: string[],
  env: Record<string, string>
): string {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  const command = [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
  return envPrefix ? `${envPrefix} ${command}` : command
}
