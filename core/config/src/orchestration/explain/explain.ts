/**
 * Explain pipeline: data acquisition and composition.
 *
 * Builds {@link SpaceInfo}/{@link TargetExplanation}/{@link ExplainResult} from a
 * lock file by reading materialized content and composing it across spaces.
 * Presentation lives in `format-text.ts`; raw content readers live in
 * `content-readers.ts`.
 */

import { join } from 'node:path'

import {
  LOCK_FILENAME,
  type LockFile,
  type LockSpaceEntry,
  type LockTargetEntry,
  type SpaceKey,
  asSha256Integrity,
  asSpaceId,
  lockFileExists,
  readLockJson,
} from '../../core/index.js'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from '../../lint/index.js'

import { classifySpaceEntry, resolveSpaceContentDir } from '../../resolver/index.js'
import { PathResolver, getAspHome, snapshotExists } from '../../store/index.js'
import { getRegistryPath } from '../resolve.js'

import {
  getAvailableComponents,
  listComponentFiles,
  listSkills,
  readHooksFromDir,
  readMcpFromDir,
  readSettingsFromDir,
} from './content-readers.js'
import type {
  ComposedContent,
  ExplainOptions,
  ExplainResult,
  SpaceInfo,
  TargetExplanation,
} from './types.js'

/** True for spaces whose content is read from source rather than a store snapshot. */
function isSourceRead(entry: LockSpaceEntry): boolean {
  const kind = classifySpaceEntry(entry)
  return kind === 'dev' || kind === 'project'
}

/**
 * Directory holding a space's content: the registry for @dev spaces, the
 * project's spaces/ for project spaces, otherwise the store snapshot.
 */
function spaceContentDir(
  entry: LockSpaceEntry,
  roots: { projectPath: string; registryPath: string; paths: PathResolver }
): string {
  const kind = classifySpaceEntry(entry)
  if (kind === 'dev') return join(roots.registryPath, entry.path)
  if (kind === 'project') return resolveSpaceContentDir(kind, entry, roots)
  return roots.paths.snapshot(asSha256Integrity(entry.integrity))
}

/**
 * Build space info from lock entry.
 */
async function buildSpaceInfo(
  key: SpaceKey,
  entry: LockSpaceEntry,
  contentDir: string,
  options: { paths: PathResolver; cwd: string; registryPath: string },
  checkStore: boolean
): Promise<SpaceInfo> {
  // @dev and project spaces are read from source and never snapshotted
  const readsSource = isSourceRead(entry)
  const inStore = readsSource
    ? false
    : checkStore
      ? await snapshotExists(entry.integrity, options)
      : true

  const info: SpaceInfo = {
    key,
    id: entry.id as string,
    commit: entry.commit as string,
    pluginName: entry.plugin.name,
    pluginVersion: entry.plugin.version,
    integrity: entry.integrity as string,
    path: entry.path,
    deps: entry.deps.spaces,
    inStore,
  }

  // Only set resolvedFrom if present (exactOptionalPropertyTypes)
  if (entry.resolvedFrom) {
    info.resolvedFrom = entry.resolvedFrom
  }

  // Read content from source (registry for @dev, project for project spaces) or store snapshot
  const canReadContent = readsSource || inStore
  if (canReadContent) {
    const hooks = await readHooksFromDir(contentDir)
    if (hooks?.length) {
      info.hooks = hooks
    }

    const mcpServers = await readMcpFromDir(contentDir)
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      info.mcpServers = mcpServers
    }

    const settings = await readSettingsFromDir(contentDir)
    if (settings) {
      info.settings = settings
    }

    const components = await getAvailableComponents(contentDir)
    const commands = await listComponentFiles(contentDir, 'commands')
    const skills = await listSkills(contentDir)
    const agents = await listComponentFiles(contentDir, 'agents')
    const scripts = await listComponentFiles(contentDir, 'scripts')

    if (
      components.length > 0 ||
      commands.length > 0 ||
      skills.length > 0 ||
      agents.length > 0 ||
      scripts.length > 0
    ) {
      info.content = { components, commands, skills, agents, scripts }
    }
  }

  return info
}

/**
 * Compose content from all spaces in load order.
 */
function composeContent(spaces: SpaceInfo[]): ComposedContent {
  const composed: ComposedContent = {
    hooks: [],
    mcpServers: {},
    settings: {
      allow: [],
      deny: [],
      env: {},
    },
    commands: [],
    skills: [],
    agents: [],
  }

  for (const space of spaces) {
    const spaceId = space.id

    // Collect hooks
    if (space.hooks) {
      for (const hook of space.hooks) {
        composed.hooks.push({ space: spaceId, hook })
      }
    }

    // Collect MCP servers (later override earlier)
    if (space.mcpServers) {
      for (const [name, config] of Object.entries(space.mcpServers)) {
        composed.mcpServers[name] = { space: spaceId, config }
      }
    }

    // Collect settings
    if (space.settings) {
      if (space.settings.allow) {
        for (const rule of space.settings.allow) {
          composed.settings.allow.push({ space: spaceId, rule })
        }
      }
      if (space.settings.deny) {
        for (const rule of space.settings.deny) {
          composed.settings.deny.push({ space: spaceId, rule })
        }
      }
      if (space.settings.env) {
        for (const [key, value] of Object.entries(space.settings.env)) {
          composed.settings.env[key] = { space: spaceId, value }
        }
      }
      if (space.settings.model) {
        composed.settings.model = { space: spaceId, value: space.settings.model }
      }
    }

    // Collect commands, skills, agents
    if (space.content) {
      for (const cmd of space.content.commands) {
        composed.commands.push({ space: spaceId, name: cmd })
      }
      for (const skill of space.content.skills) {
        composed.skills.push({ space: spaceId, name: skill })
      }
      for (const agent of space.content.agents) {
        composed.agents.push({ space: spaceId, name: agent })
      }
    }
  }

  return composed
}

/**
 * Explain a target from lock file.
 */
async function explainTarget(
  name: string,
  target: LockTargetEntry,
  lock: LockFile,
  options: ExplainOptions
): Promise<TargetExplanation> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = getRegistryPath({
    projectPath: options.projectPath,
    aspHome,
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
  })
  const checkStore = options.checkStore !== false
  const buildOpts = { paths, cwd: registryPath, registryPath }

  const contentRoots = { projectPath: options.projectPath, registryPath, paths }

  // Build space info for each space in load order
  const spaces: SpaceInfo[] = []
  const contentDirs = new Map<string, string>()
  for (const key of target.loadOrder) {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space not found in lock: ${key}`)
    }
    const contentDir = spaceContentDir(entry, contentRoots)
    contentDirs.set(key, contentDir)
    const info = await buildSpaceInfo(key, entry, contentDir, buildOpts, checkStore)
    spaces.push(info)
  }

  // Run lint if requested
  let warnings: LintWarning[] = []
  if (options.runLint !== false) {
    const lintData: SpaceLintData[] = spaces.map((space) => {
      return {
        key: space.key,
        manifest: {
          schema: 1 as const,
          id: asSpaceId(space.id),
          plugin: {
            name: space.pluginName,
            version: space.pluginVersion,
          },
        },
        pluginPath: contentDirs.get(space.key) as string,
      }
    })

    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
  }

  // Include warnings from lock if present (convert LockWarning to LintWarning)
  if (target.warnings) {
    for (const lockWarning of target.warnings) {
      warnings.push({
        code: lockWarning.code,
        message: lockWarning.message,
        severity: 'warning',
      })
    }
  }

  // Compose content from all spaces
  const composed = composeContent(spaces)

  return {
    name,
    compose: target.compose as string[],
    roots: target.roots,
    loadOrder: target.loadOrder,
    envHash: target.envHash as string,
    spaces,
    composed,
    warnings,
  }
}

/**
 * Explain targets from a project.
 *
 * This provides detailed information about:
 * - Load order and dependencies
 * - Plugin identities
 * - How versions were resolved
 * - Whether snapshots are in store
 * - Any lint warnings
 */
export async function explain(options: ExplainOptions): Promise<ExplainResult> {
  // Check for lock file
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  if (!(await lockFileExists(lockPath))) {
    throw new Error('No lock file found. Run install first.')
  }

  // Load lock file
  const lock = await readLockJson(lockPath)

  // Determine which targets to explain
  const targetNames = options.targets ?? Object.keys(lock.targets)

  // Build explanations
  const targets: Record<string, TargetExplanation> = {}
  for (const name of targetNames) {
    const target = lock.targets[name]
    if (!target) {
      throw new Error(`Target not found in lock: ${name}`)
    }
    targets[name] = await explainTarget(name, target, lock, options)
  }

  return {
    spacesRoot: getRegistryPath({
      projectPath: options.projectPath,
      aspHome: options.aspHome ?? getAspHome(),
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
    }),
    lockVersion: lock.lockfileVersion,
    generatedAt: lock.generatedAt,
    targets,
  }
}
