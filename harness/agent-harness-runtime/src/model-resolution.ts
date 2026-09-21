export { resolveAgentHarnessModel } from 'spaces-runtime'

export function providerCredential(
  provider: string,
  environment: NodeJS.ProcessEnv
): string | undefined {
  if (provider === 'anthropic') return environment['ANTHROPIC_API_KEY']
  if (provider === 'openai' || provider === 'openai-codex') return environment['OPENAI_API_KEY']
  return environment[`${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`]
}
