/**
 * Active-tag skip decision: a normal timestamped dev publish may skip a wave
 * only when the active tag already holds a coherent, unchanged ASP set.
 * Anything else publishes the complete set, never a per-package subset.
 */

export type PublishDecisionInput = {
  tag: string
  normalTimestampedDevPublish: boolean
  packages: Array<{
    name: string
    localVersion: string
    localFingerprint: string
    activeTagVersion?: string | undefined
    registryVersions: Record<string, { fingerprint?: string | undefined }>
  }>
}

export type PublishPlan = {
  action: 'skip' | 'publish'
  publishPackageNames: string[]
  reason: string
}

export function resolvePublishPlanForActiveTag(input: PublishDecisionInput): PublishPlan {
  const publishPackageNames = input.packages.map((pkg) => pkg.name)
  const publish = (reason: string): PublishPlan => ({
    action: 'publish',
    publishPackageNames,
    reason,
  })
  if (!input.normalTimestampedDevPublish) {
    return publish('active-tag skip only applies to the normal timestamped dev publish path')
  }

  const activeTagVersions: string[] = []
  for (const pkg of input.packages) {
    const activeTagVersion = pkg.activeTagVersion
    if (!activeTagVersion) {
      return publish(`${pkg.name} does not have active tag ${input.tag}`)
    }

    const registryVersion = pkg.registryVersions[activeTagVersion]
    if (!registryVersion) {
      return publish(`${pkg.name}@${activeTagVersion} is missing from the registry`)
    }

    if (!registryVersion.fingerprint) {
      return publish(`${pkg.name}@${activeTagVersion} could not be fingerprinted`)
    }

    activeTagVersions.push(activeTagVersion)
  }

  if (new Set(activeTagVersions).size !== 1) {
    return publish(`active tag ${input.tag} is not version-coherent across the ASP publish set`)
  }

  for (const pkg of input.packages) {
    const activeTagVersion = pkg.activeTagVersion
    if (!activeTagVersion) continue
    const registryVersion = pkg.registryVersions[activeTagVersion]
    if (registryVersion?.fingerprint !== pkg.localFingerprint) {
      return publish(`${pkg.name} differs from the active ${input.tag} package`)
    }
  }

  return {
    action: 'skip',
    publishPackageNames: [],
    reason: `active tag ${input.tag} already contains a coherent unchanged ASP publish set`,
  }
}
