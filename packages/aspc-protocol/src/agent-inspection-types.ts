import type {
  AgentInspectionRequest,
  AgentInspectionResult,
} from 'spaces-runtime-contracts/agent-inspection'

/** Identifier-only consumer boundary for live agent roster discovery. */
export interface AspcCatalogAgentInspectionRequest {
  projectId?: string | undefined
}

/** Identifier-only consumer boundary for a producer-listed agent selection. */
export interface AspcInspectAgentSelectionRequest {
  agentId: string
  request: AgentInspectionRequest
}

export type AspcInspectionDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export type AspcInspectAgentResponse =
  | { ok: true; inspection: AgentInspectionResult }
  | { ok: false; diagnostics: AspcInspectionDiagnostic[] }

export type AspcAgentCatalogRow = {
  agentId: string
  displayName: string
  role: string | null
  sourceAvailability: {
    profile: boolean
    soul: boolean
    contextTemplate: boolean
  }
  defaultContextSummary?:
    | {
        projectId: string
        mode: string
        lane: string
        harness: string
        frontend: string
        interaction: string
      }
    | undefined
  diagnostics: AspcInspectionDiagnostic[]
  warningCount: number
  errorCount: number
}

export type AspcCatalogAgentsResponse = { agents: AspcAgentCatalogRow[] }

export type AspcAgentInspectionContextOption = {
  identifiers: AgentInspectionRequest['identifiers']
  declaredOverrides: AgentInspectionRequest['declaredOverrides']
}

/** Shared public catalog returned to ACP, Taskboard, and native plugins. */
export type AspcAgentInspectionCatalogResponse = {
  projectId: string | null
  agents: AspcAgentCatalogRow[]
  contexts: Record<string, AspcAgentInspectionContextOption[]>
}

export type AspcCatalogAgentInspectionResponse = AspcAgentInspectionCatalogResponse
export type AspcInspectAgentSelectionResponse = AspcInspectAgentResponse
