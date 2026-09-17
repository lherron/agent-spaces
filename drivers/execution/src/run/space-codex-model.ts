import {
  type SpaceRefString,
  computeClosure,
  getRegistryPath,
  getSpacesInOrder,
} from 'spaces-config'

export interface ResolveSpaceCodexConfigModelOptions {
  compose: readonly string[] | undefined
  aspHome: string
  agentRoot?: string | undefined
  projectRoot?: string | undefined
}

/**
 * The model a composed space sets through `[codex.config] model`.
 *
 * Codex compose merges space `codex.config` tables in load order into the
 * generated config.toml, so the last space that sets `model` is the model Codex
 * runs when no launch/target model overrides it. Reporting surfaces (placement
 * plan, model audit) use this instead of the adapter default.
 */
export async function resolveSpaceCodexConfigModel(
  options: ResolveSpaceCodexConfigModelOptions
): Promise<string | undefined> {
  if (!options.compose || options.compose.length === 0) {
    return undefined
  }

  const closure = await computeClosure(options.compose as SpaceRefString[], {
    cwd: getRegistryPath({
      aspHome: options.aspHome,
      projectPath: options.projectRoot ?? process.cwd(),
    }),
    ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
  })

  let model: string | undefined
  for (const space of getSpacesInOrder(closure)) {
    const candidate = space.manifest.codex?.config?.['model']
    if (typeof candidate === 'string' && candidate.length > 0) {
      model = candidate
    }
  }
  return model
}
