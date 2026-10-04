import type { PROJECT_ID, TASK_ID } from './constants'

export interface SyncAgentToCodexDefaultOptions {
  agentId: string
  codexHome: string
  aspHome: string
  agentsRoot: string
  projectRoot: string
  apply: boolean
  fetchRegistry: boolean
  installHooks: boolean
}

export interface CliArgs extends SyncAgentToCodexDefaultOptions {
  json: boolean
  help: boolean
}

export interface SkillPlan {
  name: string
  sourcePath: string
  destPath: string
  action: 'copy' | 'update' | 'skip-collision' | 'skip-dirty-managed'
  reason?: string | undefined
  /** Set when the destination held a clean managed skill from a previous agent. */
  retiresAgent?: string | undefined
}

export interface RetirePlan {
  /** Previous agents whose managed state is retired from this Codex home. */
  agents: string[]
  /** Managed skills (from previous agents) removed because they are not in the current source. */
  skills: string[]
  /** `.asp-agent-sync/<agent>.json` manifests removed. */
  manifests: string[]
}

export interface AgentsPlan {
  path: string
  action: 'create' | 'update' | 'unchanged'
}

export interface HooksPlan {
  enabled: boolean
  hooksPath: string
  configPath: string
  scriptPath: string
  /** The SessionStart / UserPromptSubmit registration-discovery hook (P-00502 §4). */
  discoveryScriptPath: string
  hooksAction: 'create' | 'update' | 'unchanged' | 'skip'
  configAction: 'create' | 'update' | 'unchanged' | 'skip'
  scriptAction: 'create' | 'update' | 'unchanged' | 'skip'
  discoveryScriptAction: 'create' | 'update' | 'unchanged' | 'skip'
}

export interface SyncManifest {
  schemaVersion: 1
  owner: 'agent-spaces'
  agentId: string
  projectId: typeof PROJECT_ID
  taskId: typeof TASK_ID
  generatedAt: string
  agentRoot: string
  sourceHash: string
  managedSkills: string[]
  agentsPath: 'AGENTS.md'
}

/**
 * The agent's priming prompt, rendered, and where it was read from.
 *
 * An embedder that runs this overlay to build a Codex home needs the same seed
 * turn text the launcher would submit, and it must not re-derive it: parsing a
 * second copy of agent-profile.toml is how two renderings of `{{agentId}}`
 * start to disagree. The overlay already reads the profile, so it renders the
 * value once here and reports it.
 *
 * `present: false` carries the reason instead of a value, so a caller that
 * requires priming can refuse by name rather than inventing a fallback.
 */
export type PrimingPlan =
  | {
      present: true
      /** Rendered text: template variables such as `{{agentId}}` are expanded. */
      text: string
      /** File the unrendered value was read from. */
      sourcePath: string
      /** Profile key the value came from. */
      sourceField: 'priming' | 'priming_file'
    }
  | {
      present: false
      reason: string
      /** Profile consulted, so a refusal can name the file that lacks the field. */
      sourcePath: string
    }

export interface SyncPlan {
  agentId: string
  agentRoot: string
  codexHome: string
  aspHome: string
  projectId: typeof PROJECT_ID
  taskId: typeof TASK_ID
  targetName: string
  refs: string[]
  materializedHome: string
  agents: AgentsPlan
  skills: SkillPlan[]
  hooks: HooksPlan
  staleManagedSkills: string[]
  retire: RetirePlan
  /** Rendered priming prompt for this agent; see {@link PrimingPlan}. */
  priming: PrimingPlan
  warnings: string[]
}

export interface SyncResult {
  applied: boolean
  plan: SyncPlan
}
