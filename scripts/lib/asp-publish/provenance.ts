/**
 * Publication provenance: the praesidiumBuild tuple every staged manifest
 * carries, and the git source proof it is built from.
 */

import { requiredCommandOutput, requiredCommandOutputOrEmpty, run } from './command'
import { REPO_ROOT } from './package-set'

export const PRAESIDIUM_BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const

export type PraesidiumBuild = {
  schema: 1
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setName: 'asp'
  setVersion: string
  builtAt: string
}

export type SourceProof = {
  repository: string
  canonicalRemote: string
  sourceCommit: string
  canonicalRef: string
  canonical: boolean
}

export function createPraesidiumBuild(input: {
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setVersion: string
  builtAt: string
}): PraesidiumBuild {
  return {
    schema: 1,
    repository: input.repository,
    canonicalRemote: input.canonicalRemote,
    sourceCommit: input.sourceCommit,
    setName: 'asp',
    setVersion: input.setVersion,
    builtAt: input.builtAt,
  }
}

/** The build tuple for one package version of a publication. */
export function praesidiumBuildFor(
  source: SourceProof,
  setVersion: string,
  builtAt: string
): PraesidiumBuild {
  return createPraesidiumBuild({
    repository: source.repository,
    canonicalRemote: source.canonicalRemote,
    sourceCommit: source.sourceCommit,
    setVersion,
    builtAt,
  })
}

function parseCanonicalRef(canonicalRef: string): { remote: string; branch: string } {
  const slash = canonicalRef.indexOf('/')
  if (slash <= 0 || slash === canonicalRef.length - 1) {
    throw new Error('Canonical ref must be a remote-tracking ref (for example origin/main)')
  }
  return {
    remote: canonicalRef.slice(0, slash),
    branch: canonicalRef.slice(slash + 1),
  }
}

/**
 * Prove the source identity used by a publication.
 *
 * Canonical mode fetches the named remote branch into its tracking ref, then
 * refuses a dirty tree or a HEAD not contained by that freshly fetched ref.
 * Non-canonical modes still record source identity but make no landed claim.
 */
export function provePublicationSource(input: {
  canonical: boolean
  canonicalRef?: string | undefined
  root?: string | undefined
}): SourceProof {
  const root = input.root ?? REPO_ROOT
  const canonicalRef = input.canonicalRef ?? process.env.ASP_CANONICAL_REF ?? 'origin/main'
  const { remote, branch } = parseCanonicalRef(canonicalRef)
  const canonicalRemote = requiredCommandOutput('git', ['remote', 'get-url', remote], root)

  if (input.canonical) {
    const fetched = run(
      'git',
      ['fetch', '--prune', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      root
    )
    if (fetched.status !== 0) {
      throw new Error(
        `Canonical publication could not freshly fetch ${canonicalRef}: ${fetched.out}`
      )
    }

    const status = requiredCommandOutputOrEmpty(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      root
    )
    if (status) {
      throw new Error(`Canonical publication requires a clean source tree:\n${status}`)
    }
  }

  const sourceCommit = requiredCommandOutput('git', ['rev-parse', 'HEAD'], root)
  if (input.canonical) {
    const contained = run('git', ['merge-base', '--is-ancestor', sourceCommit, canonicalRef], root)
    if (contained.status !== 0) {
      throw new Error(
        `Canonical publication source ${sourceCommit} is not contained by freshly fetched ${canonicalRef}`
      )
    }
  }

  return {
    repository: 'agent-spaces',
    canonicalRemote,
    sourceCommit,
    canonicalRef,
    canonical: input.canonical,
  }
}
