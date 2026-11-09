/**
 * Real aspd releases for scratch E2Es (T-11824, T-11833): build one from a
 * clean clone of a commit and install it into a scratch namespace's
 * `releases/`, so aspd derives the scratch var root itself.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const repo = resolve(import.meta.dir, '..', '..')

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export function run(command: string[], options: RunOptions = {}) {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function must(command: string[], options: RunOptions = {}): string {
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
 * Source clones live under $HOME: rbuild mirrors a checkout there at the same
 * absolute path, so asp-release's absolute cargo --target-dir, --pull and
 * --remap-path-prefix hold on build1 too. A clone under /tmp is mirrored to
 * ~/.rbuild/abs, where cargo cannot create the absolute target dir (T-12837).
 */
const CLONE_ROOT = join(
  homedir(),
  'praesidium',
  'var',
  'scratch',
  'agent-spaces',
  'scratch-release'
)
const clones: string[] = []
process.on('exit', () => {
  for (const clone of clones) rmSync(clone, { recursive: true, force: true })
})

/** A cold release build (bun bundle plus cargo, local when build1 is down) outlasts run()'s default. */
const RELEASE_BUILD_TIMEOUT_MS = 3_600_000

/**
 * Clone `sha` under CLONE_ROOT (removed when the process exits), build its
 * release under `<scratch>/builds` and install it into `releaseRoot`
 * (`<ns>/releases`).
 */
export function buildScratchRelease(
  sha: string,
  scratch: string,
  releaseRoot: string
): { releaseId: string; releasePath: string; src: string } {
  mkdirSync(CLONE_ROOT, { recursive: true })
  const clone = mkdtempSync(join(CLONE_ROOT, `${basename(scratch)}-`))
  clones.push(clone)
  const src = join(clone, `src-${sha.slice(0, 8)}`)
  must(['git', 'clone', '-q', repo, src])
  must(['git', 'checkout', '-q', sha], { cwd: src })
  must(['bun', 'install', '--frozen-lockfile'], { cwd: src })
  const report = JSON.parse(
    must(['bun', 'scripts/asp-release.ts', 'build', '--output-root', join(scratch, 'builds')], {
      cwd: src,
      timeoutMs: RELEASE_BUILD_TIMEOUT_MS,
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
