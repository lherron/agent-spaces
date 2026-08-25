import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type PromptTemplate,
  type ResourceDiagnostic,
  type ResourceLoader,
  SettingsManager,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import type { AgentSystemPromptInspection } from 'spaces-runtime'

import { reloadAgentForCwd } from './resource-sources.js'
import { createResourceLoaderTheme } from './theme.js'
import type { ResolvedAgent } from './types.js'

export interface AgentSpacesResourceLoaderOptions {
  cwd: string
  agent: ResolvedAgent
  extensionFactories?: ExtensionFactory[] | undefined
}

export interface AgentSpacesResourceInspection {
  reloadCount: number
  cwd: string
  prompt: AgentSystemPromptInspection
  skillRoots: readonly string[]
  selectedSkills: readonly Skill[]
  warnings: readonly string[]
}

/**
 * The direct Pi resource boundary. A private Pi loader parses only ASP-selected
 * paths; this wrapper supplies prompt zones and rejects getters before reload.
 */
export class AgentSpacesResourceLoader implements ResourceLoader {
  private readonly cwd: string
  private readonly agent: ResolvedAgent
  private readonly extensionFactories: ExtensionFactory[]
  private readonly theme = createResourceLoaderTheme(fileURLToPath(import.meta.url))
  private snapshot:
    | {
        agent: ResolvedAgent
        extensions: LoadExtensionsResult
        skills: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }
        prompts: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }
      }
    | undefined
  private reloadCount = 0

  constructor(options: AgentSpacesResourceLoaderOptions) {
    this.cwd = options.cwd
    this.agent = options.agent
    this.extensionFactories = options.extensionFactories ?? []
  }

  getExtensions(): LoadExtensionsResult {
    return this.requireSnapshot().extensions
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return this.requireSnapshot().skills
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return this.requireSnapshot().prompts
  }

  getThemes() {
    this.requireSnapshot()
    return { themes: [this.theme], diagnostics: [] }
  }

  getAgentsFiles() {
    this.requireSnapshot()
    return { agentsFiles: [] }
  }

  getSystemPrompt(): string | undefined {
    const prompt = this.getInspection().prompt
    return prompt.mode === 'replace' ? prompt.content : undefined
  }

  getSystemPromptSource(): { path: string } | undefined {
    const inspection = this.getInspection()
    return inspection.prompt.mode === 'replace'
      ? { path: this.promptSourcePath(inspection) }
      : undefined
  }

  getAppendSystemPrompt(): string[] {
    const inspection = this.getInspection()
    return [
      ...(inspection.prompt.mode === 'append' ? [inspection.prompt.content] : []),
      ...(inspection.reminder.content !== undefined ? [inspection.reminder.content] : []),
    ]
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    const inspection = this.getInspection()
    return [
      ...(inspection.prompt.mode === 'append' ? [{ path: this.promptSourcePath(inspection) }] : []),
      ...(inspection.reminder.content !== undefined
        ? [{ path: `${this.promptSourcePath(inspection)}#reminder` }]
        : []),
    ]
  }

  extendResources(_paths: Parameters<ResourceLoader['extendResources']>[0]): void {
    throw new Error(
      'AgentSpacesResourceLoader only accepts resources selected by ASP source resolution'
    )
  }

  async reload(): Promise<void> {
    const agent = await reloadAgentForCwd(this.agent, this.cwd)
    if (agent.inspection === undefined) {
      throw new Error(
        `Agent Spaces did not produce a system prompt for ${agent.placement.agentRoot}`
      )
    }
    // Pi's native loader parses the explicit ASP roots. The no* flags eliminate
    // Pi/project/user discovery while preserving supplied source paths/factories.
    const native = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: agent.placement.agentRoot,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: agent.sources.extensionRoots.map((root) => root.root),
      additionalSkillPaths: agent.sources.skillRoots.map((root) => root.root),
      additionalPromptTemplatePaths: agent.sources.promptTemplateRoots.map((root) => root.root),
      extensionFactories: this.extensionFactories,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await native.reload()
    this.snapshot = {
      agent,
      extensions: native.getExtensions(),
      skills: native.getSkills(),
      prompts: native.getPrompts(),
    }
    this.reloadCount += 1
  }

  getInspection(): AgentSystemPromptInspection {
    const inspection = this.requireSnapshot().agent.inspection
    if (inspection === undefined)
      throw new Error('AgentSpacesResourceLoader.reload() must complete first')
    return inspection
  }

  getResourceInspection(): AgentSpacesResourceInspection {
    const snapshot = this.requireSnapshot()
    return {
      reloadCount: this.reloadCount,
      cwd: this.cwd,
      prompt: this.getInspection(),
      skillRoots: snapshot.agent.skillPaths,
      selectedSkills: snapshot.skills.skills,
      warnings: snapshot.agent.warnings,
    }
  }

  getResolvedAgent(): ResolvedAgent {
    return this.requireSnapshot().agent
  }

  private requireSnapshot() {
    if (this.snapshot === undefined) {
      throw new Error(
        'AgentSpacesResourceLoader.reload() must complete before ResourceLoader getters'
      )
    }
    return this.snapshot
  }

  private promptSourcePath(inspection: AgentSystemPromptInspection): string {
    return inspection.template.path ?? join(inspection.agentRoot, 'SOUL.md')
  }
}
