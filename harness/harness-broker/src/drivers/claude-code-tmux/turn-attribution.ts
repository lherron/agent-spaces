import type { InputId, TurnId } from 'spaces-harness-broker-protocol'

type PendingSubmission = {
  submissionId: string
  content: string
  allocatedTurnId?: TurnId | undefined
  inputId?: InputId | undefined
  sawEnqueue: boolean
  sawPromptHook: boolean
  drainPending: boolean
  removePending: boolean
}

type SubmissionActionBase = {
  submissionId: string
  content: string
  inputId?: InputId | undefined
}

export type ClaudeAttributionAction =
  | (SubmissionActionBase & { kind: 'absorbed'; turnId: TurnId })
  | (SubmissionActionBase & { kind: 'executed'; turnId: TurnId })
  | (SubmissionActionBase & {
      kind: 'cancelled'
      reason: 'recalled' | 'removed' | 'teardown'
    })
  | { kind: 'started'; turnId: TurnId }
  | { kind: 'interrupted'; turnId: TurnId }
  | { kind: 'warning'; message: string; raw: unknown }

export type ClaudeTranscriptQueueOperation = {
  type: 'queue-operation'
  operation: string
  content?: unknown
  [key: string]: unknown
}

export interface ClaudeTurnAttribution {
  readonly activeTurnId: TurnId | undefined
  readonly pendingCount: number
  trackBrokerSubmission(input: {
    submissionId?: string | undefined
    content: string
    allocatedTurnId?: TurnId | undefined
    inputId?: InputId | undefined
  }): void
  observeQueueOperation(operation: ClaudeTranscriptQueueOperation): ClaudeAttributionAction[]
  observeQueuedCommand(prompt: string | undefined, raw: unknown): ClaudeAttributionAction[]
  observePlainUser(content: string, raw: unknown): ClaudeAttributionAction[]
  observeInterrupt(raw: unknown): ClaudeAttributionAction[]
  observePromptHook(content: string | undefined, hintedTurnId?: TurnId): ClaudeAttributionAction[]
  observeTurnStarted(turnId: TurnId): void
  observeTurnTerminal(turnId: TurnId): void
  teardown(): ClaudeAttributionAction[]
}

export function createClaudeTurnAttribution(options: {
  invocationId: string
  allocateTurnId: () => string
}): ClaudeTurnAttribution {
  const pending: PendingSubmission[] = []
  let activeTurnId: TurnId | undefined
  let submissionCounter = 0
  let recentDisposedPrompt: string | undefined

  const nextHumanSubmissionId = (): string => {
    submissionCounter += 1
    return `submission_${options.invocationId}_${submissionCounter}`
  }

  const createPending = (
    content: string,
    init: Partial<Omit<PendingSubmission, 'submissionId' | 'content'>> & {
      submissionId?: string
    } = {}
  ): PendingSubmission => {
    const item: PendingSubmission = {
      submissionId: init.submissionId ?? nextHumanSubmissionId(),
      content,
      ...(init.allocatedTurnId !== undefined ? { allocatedTurnId: init.allocatedTurnId } : {}),
      ...(init.inputId !== undefined ? { inputId: init.inputId } : {}),
      sawEnqueue: init.sawEnqueue ?? false,
      sawPromptHook: init.sawPromptHook ?? false,
      drainPending: init.drainPending ?? false,
      removePending: init.removePending ?? false,
    }
    pending.push(item)
    return item
  }

  const base = (item: PendingSubmission): SubmissionActionBase => ({
    submissionId: item.submissionId,
    content: item.content,
    ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
  })

  const drop = (item: PendingSubmission): void => {
    const index = pending.indexOf(item)
    if (index >= 0) pending.splice(index, 1)
  }

  const cancelOutstandingRemovals = (): ClaudeAttributionAction[] => {
    const actions: ClaudeAttributionAction[] = []
    for (const item of [...pending]) {
      if (!item.removePending) continue
      drop(item)
      actions.push({ kind: 'cancelled', ...base(item), reason: 'removed' })
    }
    return actions
  }

  const execute = (
    item: PendingSubmission,
    rememberPromptHook: boolean
  ): ClaudeAttributionAction => {
    const turnId = item.allocatedTurnId ?? (options.allocateTurnId() as TurnId)
    drop(item)
    activeTurnId = turnId
    recentDisposedPrompt = rememberPromptHook ? item.content : undefined
    return { kind: 'executed', ...base(item), turnId }
  }

  const warning = (message: string, raw: unknown): ClaudeAttributionAction => ({
    kind: 'warning',
    message,
    raw,
  })

  return {
    get activeTurnId(): TurnId | undefined {
      return activeTurnId
    },

    get pendingCount(): number {
      return pending.length
    },

    trackBrokerSubmission(input): void {
      createPending(input.content, {
        ...(input.submissionId !== undefined ? { submissionId: input.submissionId } : {}),
        allocatedTurnId: input.allocatedTurnId,
        inputId: input.inputId,
      })
    },

    observeQueueOperation(operation): ClaudeAttributionAction[] {
      recentDisposedPrompt = undefined
      const op = operation.operation
      if (op === 'enqueue') {
        const content = typeof operation.content === 'string' ? operation.content : undefined
        if (content === undefined || content.length === 0) {
          return [warning('Unclassifiable Claude queue enqueue', operation)]
        }
        const candidate = pending.find((item) => item.content === content && !item.sawEnqueue)
        if (candidate !== undefined) {
          candidate.sawEnqueue = true
        } else {
          createPending(content, { sawEnqueue: true })
        }
        return []
      }

      if (op === 'remove') {
        const actions = cancelOutstandingRemovals()
        const content = typeof operation.content === 'string' ? operation.content : undefined
        const item =
          content === undefined
            ? undefined
            : pending.find(
                (candidate) =>
                  candidate.content === content &&
                  !candidate.drainPending &&
                  !candidate.removePending
              )
        if (item === undefined) {
          actions.push(warning('Unmatched Claude queue remove', operation))
        } else {
          item.removePending = true
        }
        return actions
      }

      if (op === 'dequeue') {
        const actions = cancelOutstandingRemovals()
        const item = pending.find(
          (candidate) => !candidate.drainPending && !candidate.removePending
        )
        if (item === undefined) {
          actions.push(warning('Unmatched Claude queue dequeue', operation))
        } else {
          item.drainPending = true
        }
        return actions
      }

      if (op === 'popAll') {
        const actions = cancelOutstandingRemovals()
        const content = typeof operation.content === 'string' ? operation.content : undefined
        const matches =
          content === undefined
            ? []
            : pending.filter(
                (item) =>
                  !item.drainPending &&
                  !item.removePending &&
                  (item.content === content || content.includes(item.content))
              )
        if (matches.length === 0) {
          actions.push(warning('Unmatched Claude queue popAll', operation))
          return actions
        }
        for (const item of matches) {
          drop(item)
          actions.push({ kind: 'cancelled', ...base(item), reason: 'recalled' })
        }
        return actions
      }

      return [warning(`Unknown Claude queue operation: ${op}`, operation)]
    },

    observeQueuedCommand(prompt, raw): ClaudeAttributionAction[] {
      if (prompt === undefined || prompt.length === 0) {
        return [warning('Claude queued_command attachment has no prompt', raw)]
      }
      const item = pending.find(
        (candidate) => candidate.removePending && candidate.content === prompt
      )
      if (item === undefined) {
        return [warning('Unmatched Claude queued_command attachment', raw)]
      }
      if (activeTurnId === undefined) {
        return [warning('Claude queued_command attachment has no active turn', raw)]
      }
      drop(item)
      recentDisposedPrompt = item.content
      return [{ kind: 'absorbed', ...base(item), turnId: activeTurnId }]
    },

    observePlainUser(content, raw): ClaudeAttributionAction[] {
      const actions = cancelOutstandingRemovals()
      if (content === recentDisposedPrompt) {
        recentDisposedPrompt = undefined
        return actions
      }
      recentDisposedPrompt = undefined
      const drained = pending.find((item) => item.drainPending)
      if (drained !== undefined) {
        if (drained.content !== content) {
          actions.push(warning('Claude drained user row does not match FIFO submission', raw))
          return actions
        }
        actions.push(execute(drained, true))
        return actions
      }

      if (activeTurnId !== undefined) {
        actions.push(warning('Claude plain user row arrived while a turn is active', raw))
        return actions
      }

      const candidate = pending.find(
        (item) => item.content === content && !item.removePending && !item.drainPending
      )
      actions.push(execute(candidate ?? createPending(content), true))
      return actions
    },

    observeInterrupt(raw): ClaudeAttributionAction[] {
      recentDisposedPrompt = undefined
      if (activeTurnId === undefined) {
        return [warning('Claude interrupt row has no active turn', raw)]
      }
      const interrupted = activeTurnId
      activeTurnId = undefined
      return [{ kind: 'interrupted', turnId: interrupted }]
    },

    observePromptHook(content, hintedTurnId): ClaudeAttributionAction[] {
      if (content !== undefined && content === recentDisposedPrompt) {
        recentDisposedPrompt = undefined
        return []
      }
      recentDisposedPrompt = undefined

      const candidate =
        content === undefined
          ? undefined
          : pending.find((item) => item.content === content && !item.sawPromptHook)
      if (candidate?.sawEnqueue === true) {
        candidate.sawPromptHook = true
        return []
      }
      if (activeTurnId !== undefined) {
        const item =
          candidate ??
          (content !== undefined
            ? createPending(content, { allocatedTurnId: hintedTurnId, sawPromptHook: true })
            : undefined)
        if (item !== undefined) item.sawPromptHook = true
        return []
      }

      if (content === undefined || content.length === 0) {
        const unambiguous = pending.length === 1 ? pending[0] : undefined
        if (unambiguous !== undefined) {
          unambiguous.sawPromptHook = true
          return [execute(unambiguous, false)]
        }
        const turnId = hintedTurnId ?? (options.allocateTurnId() as TurnId)
        activeTurnId = turnId
        return [{ kind: 'started', turnId }]
      }
      const item =
        candidate ?? createPending(content, { allocatedTurnId: hintedTurnId, sawPromptHook: true })
      item.sawPromptHook = true
      return [execute(item, true)]
    },

    observeTurnStarted(turnId): void {
      activeTurnId = turnId
      recentDisposedPrompt = undefined
    },

    observeTurnTerminal(turnId): void {
      if (activeTurnId === turnId) activeTurnId = undefined
      recentDisposedPrompt = undefined
    },

    teardown(): ClaudeAttributionAction[] {
      const actions: ClaudeAttributionAction[] = []
      for (const item of [...pending]) {
        drop(item)
        actions.push({ kind: 'cancelled', ...base(item), reason: 'teardown' })
      }
      recentDisposedPrompt = undefined
      return actions
    },
  }
}
