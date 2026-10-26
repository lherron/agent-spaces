/**
 * Real aspd releases for scratch E2Es (T-11824, T-11833): build one from a
 * clean clone of a commit and install it into a scratch namespace's
 * `releases/`, so aspd derives the scratch var root itself.
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const repo = resolve(import.meta.dir, '..', '..')

export function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 300_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function must(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const result = run(command, options)
  if (result.status !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.status}\n${result.stderr}${result.stdout}`
    )
  }
  return result.stdout
}

/** Install an already-built release artifact into `releaseRoot`. */
export function installReleaseArtifact(
  artifact: string,
  releaseRoot: string
): { releaseId: string; releasePath: string } {
  const manifest = JSON.parse(must(['cat', join(artifact, 'release.json')])) as {
    releaseId: string
  }
  must([
    'bun',
    'scripts/asp-release.ts',
    'install',
    '--artifact',
    artifact,
    '--release-root',
    releaseRoot,
  ])
  return { releaseId: manifest.releaseId, releasePath: artifact }
}

/**
 * Clone `sha` into `<scratch>/src-<sha8>`, build its release under
 * `<scratch>/builds` and install it into `releaseRoot` (`<ns>/releases`).
 */
export function buildScratchRelease(
  sha: string,
  scratch: string,
  releaseRoot: string
): { releaseId: string; releasePath: string; src: string } {
  const src = join(scratch, `src-${sha.slice(0, 8)}`)
  must(['git', 'clone', '-q', repo, src])
  must(['git', 'checkout', '-q', sha], { cwd: src })
  must(['bun', 'install', '--frozen-lockfile'], { cwd: src })
  const report = JSON.parse(
    must(['bun', 'scripts/asp-release.ts', 'build', '--output-root', join(scratch, 'builds')], {
      cwd: src,
    })
  ) as { releaseId: string; releasePath: string }
  must(
    [
      'bun',
      'scripts/asp-release.ts',
      'install',
      '--artifact',
      report.releasePath,
      '--release-root',
      releaseRoot,
    ],
    { cwd: src }
  )
  return { ...report, src }
}
