import { delimiter, join } from 'node:path'

export const TEST_REAL_GIT_ENV = 'ASP_TEST_REAL_GIT'

export function testGitGuardEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const realGit = source[TEST_REAL_GIT_ENV] || Bun.which('git')
  if (!realGit) {
    throw new Error('Test Git guard could not resolve the real Git executable')
  }

  const guardDirectory = join(import.meta.dir, '..', 'test-bin')
  return {
    ...source,
    [TEST_REAL_GIT_ENV]: realGit,
    PATH: [guardDirectory, source.PATH].filter(Boolean).join(delimiter),
  }
}
