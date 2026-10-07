/**
 * Typed CodexAdapter inputs shared by the adapter's behavior test files.
 */

import {
  type ComposeTargetInput,
  type MaterializeSpaceInput,
  type ResolvedSpaceArtifact,
  type ResolvedSpaceManifest,
  type SpaceKey,
  asSpaceId,
} from 'spaces-config'

function createTestManifest(overrides: Partial<ResolvedSpaceManifest> = {}): ResolvedSpaceManifest {
  const id = overrides.id ?? asSpaceId('test-space')
  return {
    schema: 1,
    id,
    version: '1.0.0',
    plugin: { name: id },
    ...overrides,
  }
}

function createSpaceKey(id = 'test-space', commit = 'abc123'): SpaceKey {
  return `${id}@${commit}` as SpaceKey
}

export function createMaterializeInput(
  snapshotPath: string,
  manifestOverrides: Partial<ResolvedSpaceManifest> = {}
): MaterializeSpaceInput {
  return {
    spaceKey: createSpaceKey(),
    manifest: createTestManifest(manifestOverrides),
    snapshotPath,
    integrity: 'sha256-test',
  }
}

/** A resolved artifact whose space id doubles as its plugin name. */
export function codexArtifact(
  spaceKey: string,
  artifactPath: string,
  pluginVersion: string
): ResolvedSpaceArtifact {
  const spaceId = spaceKey.slice(0, spaceKey.indexOf('@'))
  return {
    spaceKey: spaceKey as SpaceKey,
    spaceId,
    artifactPath,
    pluginName: spaceId,
    pluginVersion,
  }
}

/** A compose input with no roots, load order, or settings beyond the artifacts. */
export function composeTargetInput(
  targetName: string,
  artifacts: ResolvedSpaceArtifact[],
  codexOptions?: ComposeTargetInput['codexOptions']
): ComposeTargetInput {
  return {
    targetName,
    compose: [],
    roots: [],
    loadOrder: [],
    artifacts,
    settingsInputs: [],
    ...(codexOptions === undefined ? {} : { codexOptions }),
  }
}
