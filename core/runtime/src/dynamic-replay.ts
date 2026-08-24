import type { AgentInspectionServiceProbeResponse } from 'spaces-runtime-contracts'

export interface RecordedExecResult {
  /** Template section name as declared in context-template.toml. */
  sectionName: string
  /** Literal command after template parsing, before execution. */
  command: string
  /** One-based occurrence for repeated section-name/command evaluations. */
  occurrence: number
  /** Process exit status. Zero is a successful command. */
  exitStatus: number
  stdout: string
  stderr: string
}

export interface RecordedServiceProbeResponse extends AgentInspectionServiceProbeResponse {
  /** One-based occurrence for a repeated service-name/endpoint probe. */
  occurrence?: number | undefined
}

export class DynamicReplayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DynamicReplayError'
  }
}

type ReplayKey = string

function execKey(sectionName: string, command: string, occurrence: number): ReplayKey {
  return `${sectionName}\u0000${command}\u0000${occurrence}`
}

function serviceKey(name: string, endpoint: string, occurrence: number): ReplayKey {
  return `${name}\u0000${endpoint}\u0000${occurrence}`
}

/**
 * Per-resolution accounting for recorded dynamic sections. Keeping this state
 * separate from ContextResolverContext lets callers reuse their pinned input
 * unchanged while every record is still consumed exactly once.
 */
export class DynamicReplayLedger {
  private readonly execRecords = new Map<ReplayKey, RecordedExecResult>()
  private readonly serviceRecords = new Map<ReplayKey, RecordedServiceProbeResponse>()
  private readonly execOccurrences = new Map<string, number>()
  private readonly serviceOccurrences = new Map<string, number>()
  private readonly hasExecReplay: boolean
  private readonly hasServiceReplay: boolean

  constructor(
    execResults: readonly RecordedExecResult[] | undefined,
    serviceResponses: readonly RecordedServiceProbeResponse[] | undefined
  ) {
    this.hasExecReplay = execResults !== undefined
    this.hasServiceReplay = serviceResponses !== undefined
    for (const record of execResults ?? []) {
      const key = execKey(record.sectionName, record.command, record.occurrence)
      if (this.execRecords.has(key)) {
        throw new DynamicReplayError(
          `Duplicate recorded exec result for section ${JSON.stringify(record.sectionName)}, command ${JSON.stringify(record.command)}, occurrence ${record.occurrence}`
        )
      }
      this.execRecords.set(key, record)
    }
    for (const record of serviceResponses ?? []) {
      const occurrence = record.occurrence ?? 1
      const key = serviceKey(record.name, record.endpoint, occurrence)
      if (this.serviceRecords.has(key)) {
        throw new DynamicReplayError(
          `Duplicate recorded service probe response for ${JSON.stringify(record.name)} at ${JSON.stringify(record.endpoint)}, occurrence ${occurrence}`
        )
      }
      this.serviceRecords.set(key, record)
    }
  }

  consumesExecReplay(): boolean {
    return this.hasExecReplay
  }

  consumesServiceReplay(): boolean {
    return this.hasServiceReplay
  }

  consumeExec(sectionName: string, command: string): RecordedExecResult | undefined {
    if (!this.consumesExecReplay()) return undefined
    const occurrenceKey = `${sectionName}\u0000${command}`
    const occurrence = (this.execOccurrences.get(occurrenceKey) ?? 0) + 1
    this.execOccurrences.set(occurrenceKey, occurrence)
    const key = execKey(sectionName, command, occurrence)
    const record = this.execRecords.get(key)
    if (record === undefined) {
      throw new DynamicReplayError(
        `Missing recorded exec result for section ${JSON.stringify(sectionName)}, command ${JSON.stringify(command)}, occurrence ${occurrence}`
      )
    }
    this.execRecords.delete(key)
    return record
  }

  consumeService(name: string, endpoint: string): RecordedServiceProbeResponse | undefined {
    if (!this.consumesServiceReplay()) return undefined
    const occurrenceKey = `${name}\u0000${endpoint}`
    const occurrence = (this.serviceOccurrences.get(occurrenceKey) ?? 0) + 1
    this.serviceOccurrences.set(occurrenceKey, occurrence)
    const key = serviceKey(name, endpoint, occurrence)
    const record = this.serviceRecords.get(key)
    if (record === undefined) {
      throw new DynamicReplayError(
        `Missing recorded service probe response for ${JSON.stringify(name)} at ${JSON.stringify(endpoint)}, occurrence ${occurrence}`
      )
    }
    this.serviceRecords.delete(key)
    return record
  }

  assertFullyConsumed(): void {
    const staleExec = [...this.execRecords.values()][0]
    if (staleExec !== undefined) {
      throw new DynamicReplayError(
        `Unused recorded exec result for section ${JSON.stringify(staleExec.sectionName)}, command ${JSON.stringify(staleExec.command)}, occurrence ${staleExec.occurrence}`
      )
    }
    const staleService = [...this.serviceRecords.values()][0]
    if (staleService !== undefined) {
      throw new DynamicReplayError(
        `Unused recorded service probe response for ${JSON.stringify(staleService.name)} at ${JSON.stringify(staleService.endpoint)}, occurrence ${staleService.occurrence ?? 1}`
      )
    }
  }
}
