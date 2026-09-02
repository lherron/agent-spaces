import type { InputId, TurnId } from 'spaces-harness-broker-protocol'

type PendingSubmission = {
  submissionId: string
  content: string
  allocatedTurnId?: TurnId | undefined
  inputId?: InputId | undefined
  sawEnqueue: boolean
  sawPromptHook: boolean
  drainPending: boolean
  drainWarned: boolean
  drainOperation?: unknown
  removePending: boolean
  removeWarned: boolean
  removeOperation?: unknown
}

type SubmissionActionBase = {
  submissionId: string
  content: string
  inputId?: InputId | undefined
}

export type ClaudeAttributionAction =
  | (SubmissionActionBase & { kind: 'absorbed'; turnId: TurnId })
  | (SubmissionActionBase & {
      kind: 'executed'
      turnId: TurnId
      /** The broker text was only a substring of the submitted human prompt. */
      absorbedIntoHumanPrompt?: true | undefined
      /**
       * Whether this action is also the CONVERSATION fact for the prompt.
       *
       * `conversation` is transcript-primary (T-07873 scope A), so an execute
       * decided by the `UserPromptSubmit` HOOK deliberately does not mint
       * `user.message`: it arms the echo instead, and the prompt's own `user`
       * row mints it as a `prompt-echo`. An execute decided by a transcript row
       * IS the record, so it mints directly.
       */
      mintsConversation: boolean
    })
  /**
   * The plain `user` row that echoes a prompt already disposed by the
   * `UserPromptSubmit` hook. It carries no submission disposition — that was
   * minted on the hook record (the documented idle-path exception) — but it IS
   * the transcript record for the prompt text.
   */
  | { kind: 'prompt-echo'; content: string; turnId: TurnId }
  | (SubmissionActionBase & {
      kind: 'cancelled'
      reason: 'recalled' | 'teardown'
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
  readonly harnessLocalQueueDepth: number
  expectInterrupt(): number
  cancelExpectedInterrupt(expectationId: number): void
  trackBrokerSubmission(input: {
    submissionId?: string | undefined
    content: string
    allocatedTurnId?: TurnId | undefined
    inputId?: InputId | undefined
  }): void
  observeQueueOperation(operation: ClaudeTranscriptQueueOperation): ClaudeAttributionAction[]
  observeQueuedCommand(prompt: string | undefined, raw: unknown): ClaudeAttributionAction[]
  observePlainUser(content: string, raw: unknown): ClaudeAttributionAction[]
  observeInterrupt(
    raw: unknown,
    context?: { precededByStopHookCancelled?: boolean | undefined }
  ): ClaudeAttributionAction[]
  observePromptHook(content: string | undefined, hintedTurnId?: TurnId): ClaudeAttributionAction[]
  settleOutstandingRemovals(raw: unknown): ClaudeAttributionAction[]
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
  let interruptExpectationCounter = 0
  const expectedInterrupts: Array<{ id: number; turnId: TurnId | undefined }> = []
  const settledInterruptTargets: TurnId[] = []
  let recentDisposedPrompt: string | undefined
  /** Whether {@link recentDisposedPrompt} was disposed on a HOOK record. */
  let recentDisposedPromptFromHook = false

  const nextHumanSubmissionId = (): string => {
    submissionCounter += 1
    return `human_submission_${options.invocationId}_${submissionCounter}`
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
      drainWarned: init.drainWarned ?? false,
      ...(init.drainOperation !== undefined ? { drainOperation: init.drainOperation } : {}),
      removePending: init.removePending ?? false,
      removeWarned: init.removeWarned ?? false,
      ...(init.removeOperation !== undefined ? { removeOperation: init.removeOperation } : {}),
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

  const settleOutstandingRemovals = (raw: unknown): ClaudeAttributionAction[] => {
    const actions: ClaudeAttributionAction[] = []
    for (const item of pending) {
      if (!item.removePending || item.removeWarned) continue
      item.removeWarned = true
      actions.push(
        warning(
          'Claude queue remove reached a disposition boundary without queued_command evidence',
          item.removeOperation ?? raw
        )
      )
    }
    return actions
  }

  const execute = (
    item: PendingSubmission,
    rememberPromptHook: boolean,
    source: 'hook' | 'transcript',
    observedContent = item.content
  ): ClaudeAttributionAction => {
    const turnId = item.allocatedTurnId ?? (options.allocateTurnId() as TurnId)
    drop(item)
    activeTurnId = turnId
    recentDisposedPrompt = rememberPromptHook ? observedContent : undefined
    recentDisposedPromptFromHook = rememberPromptHook && source === 'hook'
    return {
      kind: 'executed',
      ...base(item),
      content: observedContent,
      turnId,
      ...(observedContent !== item.content ? { absorbedIntoHumanPrompt: true as const } : {}),
      // Defer the conversation fact to the echo row ONLY when an echo was
      // armed; otherwise this action is the only carrier there will be.
      mintsConversation: source === 'transcript' || !rememberPromptHook,
    }
  }

  const warning = (message: string, raw: unknown): ClaudeAttributionAction => ({
    kind: 'warning',
    message,
    raw,
  })

  const promptCandidate = (
    content: string,
    eligible: (item: PendingSubmission) => boolean
  ): { item: PendingSubmission; absorbedIntoHumanPrompt: boolean } | undefined => {
    const exact = pending.find((item) => eligible(item) && item.content === content)
    if (exact !== undefined) return { item: exact, absorbedIntoHumanPrompt: false }

    // Substring attribution is deliberately broker-only. Human/local queue
    // entries have no inputId, so fuzzy matching those would turn arbitrary
    // operator prose into a broker disposition. With multiple broker matches,
    // only a unique longest body is unambiguous.
    const embedded = pending.filter(
      (item) =>
        eligible(item) &&
        item.inputId !== undefined &&
        item.content.length > 0 &&
        content.includes(item.content)
    )
    if (embedded.length === 0) return undefined
    const longestLength = Math.max(...embedded.map((item) => item.content.length))
    const longest = embedded.filter((item) => item.content.length === longestLength)
    const longestItem = longest.length === 1 ? longest[0] : undefined
    return longestItem === undefined
      ? undefined
      : { item: longestItem, absorbedIntoHumanPrompt: true }
  }

  return {
    get activeTurnId(): TurnId | undefined {
      return activeTurnId
    },

    get pendingCount(): number {
      return pending.length
    },

    get harnessLocalQueueDepth(): number {
      return pending.filter((item) => item.sawEnqueue && !item.drainPending && !item.removePending)
        .length
    },

    expectInterrupt(): number {
      interruptExpectationCounter += 1
      expectedInterrupts.push({ id: interruptExpectationCounter, turnId: activeTurnId })
      return interruptExpectationCounter
    },

    cancelExpectedInterrupt(expectationId): void {
      const index = expectedInterrupts.findIndex((expected) => expected.id === expectationId)
      if (index >= 0) expectedInterrupts.splice(index, 1)
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
          return [warning('Unmatched Claude queue remove', operation)]
        }
        item.removePending = true
        item.removeWarned = false
        item.removeOperation = operation
        return []
      }

      if (op === 'dequeue') {
        const item = pending.find(
          (candidate) => !candidate.drainPending && !candidate.removePending
        )
        if (item === undefined) {
          return [warning('Unmatched Claude queue dequeue', operation)]
        }
        item.drainPending = true
        item.drainWarned = false
        item.drainOperation = operation
        return []
      }

      if (op === 'popAll') {
        const content = typeof operation.content === 'string' ? operation.content : undefined
        const matches =
          content === undefined
            ? []
            : pending.filter(
                (item) =>
                  !item.drainPending && (item.content === content || content.includes(item.content))
              )
        const actions: ClaudeAttributionAction[] = []
        for (const item of matches) {
          drop(item)
          actions.push({ kind: 'cancelled', ...base(item), reason: 'recalled' })
        }
        actions.push(...settleOutstandingRemovals(operation))
        if (matches.length === 0) {
          if (actions.length === 0) {
            actions.push(warning('Unmatched Claude queue popAll', operation))
          }
          return actions
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
      const actions = settleOutstandingRemovals(raw)
      if (content === recentDisposedPrompt) {
        const disposedOnHookRecord = recentDisposedPromptFromHook
        recentDisposedPrompt = undefined
        recentDisposedPromptFromHook = false
        // The submission disposition was already minted (on the hook record for
        // the idle path, on the `queued_command` attachment for the absorbed
        // one). Only the idle path still owes a `user.message`, and THIS row is
        // its record.
        if (disposedOnHookRecord && activeTurnId !== undefined) {
          actions.push({ kind: 'prompt-echo', content, turnId: activeTurnId })
        }
        return actions
      }
      recentDisposedPrompt = undefined
      recentDisposedPromptFromHook = false
      const drained = pending.find((item) => item.drainPending)
      if (drained !== undefined) {
        const drainedMatch = promptCandidate(content, (item) => item === drained)
        if (drainedMatch === undefined) {
          if (!drained.drainWarned) {
            drained.drainWarned = true
            actions.push(
              warning('Claude drained user row does not match FIFO submission', {
                kind: 'claude.dequeue-without-user-row',
                blockedSubmissionId: drained.submissionId,
                dequeue: drained.drainOperation,
                observedUserRow: raw,
              })
            )
          }
          // The dropped item remains blocked-unknown, but it cannot prevent a
          // later evidenced prompt (including the preempting submission) from
          // opening its own truthful turn.
          if (activeTurnId !== undefined) return actions
        } else {
          actions.push(execute(drained, true, 'transcript', content))
          return actions
        }
      }

      if (activeTurnId !== undefined) {
        actions.push(warning('Claude plain user row arrived while a turn is active', raw))
        return actions
      }

      const candidate = promptCandidate(
        content,
        (item) => !item.removePending && !item.drainPending
      )
      actions.push(execute(candidate?.item ?? createPending(content), true, 'transcript', content))
      return actions
    },

    observeInterrupt(raw, context): ClaudeAttributionAction[] {
      recentDisposedPrompt = undefined
      const actions = settleOutstandingRemovals(raw)
      const expected = expectedInterrupts.shift()
      if (expected !== undefined) {
        if (expected.turnId === undefined) return actions
        if (activeTurnId === expected.turnId) activeTurnId = undefined
        actions.push({ kind: 'interrupted', turnId: expected.turnId })
        return actions
      }
      if (settledInterruptTargets.shift() !== undefined) return actions
      if (activeTurnId === undefined) {
        if (context?.precededByStopHookCancelled === true) return actions
        actions.push(warning('Claude interrupt row has no active turn', raw))
        return actions
      }
      const interrupted = activeTurnId
      activeTurnId = undefined
      actions.push({ kind: 'interrupted', turnId: interrupted })
      return actions
    },

    observePromptHook(content, hintedTurnId): ClaudeAttributionAction[] {
      if (content !== undefined && content === recentDisposedPrompt) {
        recentDisposedPrompt = undefined
        recentDisposedPromptFromHook = false
        return []
      }
      recentDisposedPrompt = undefined
      recentDisposedPromptFromHook = false

      const match =
        content === undefined ? undefined : promptCandidate(content, (item) => !item.sawPromptHook)
      const candidate = match?.item
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
          return [execute(unambiguous, false, 'hook')]
        }
        const turnId = hintedTurnId ?? (options.allocateTurnId() as TurnId)
        activeTurnId = turnId
        return [{ kind: 'started', turnId }]
      }
      const item =
        candidate ?? createPending(content, { allocatedTurnId: hintedTurnId, sawPromptHook: true })
      item.sawPromptHook = true
      return [execute(item, true, 'hook', content)]
    },

    settleOutstandingRemovals(raw): ClaudeAttributionAction[] {
      return settleOutstandingRemovals(raw)
    },

    observeTurnStarted(turnId): void {
      // If an interrupt-target turn completed before its C-c produced a marker,
      // the next turn start proves that marker will not arrive at this boundary.
      settledInterruptTargets.length = 0
      activeTurnId = turnId
      recentDisposedPrompt = undefined
    },

    observeTurnTerminal(turnId): void {
      for (let index = expectedInterrupts.length - 1; index >= 0; index -= 1) {
        if (expectedInterrupts[index]?.turnId === turnId) {
          expectedInterrupts.splice(index, 1)
          settledInterruptTargets.push(turnId)
        }
      }
      if (activeTurnId === turnId) activeTurnId = undefined
      recentDisposedPrompt = undefined
    },

    teardown(): ClaudeAttributionAction[] {
      const actions: ClaudeAttributionAction[] = []
      for (const item of [...pending]) {
        drop(item)
        if (item.drainPending && item.drainWarned) continue
        actions.push({ kind: 'cancelled', ...base(item), reason: 'teardown' })
      }
      recentDisposedPrompt = undefined
      return actions
    },
  }
}
