import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { type CodexFg, type CodexTranscriptWidth, createCodexStyler } from './pane-style'
import { asRecord, clip, str } from './pane-text'
import { formatClock, formatElapsed, formatPaneDate, parseMs } from './pane-time'
import { shortPrincipal, shortSubmissionId } from './queue-drawer'
import { createTranscriptRegions } from './transcript-regions'

/**
 * T-04963 / T-06325 — operator transcript renderer for the Codex app-server pane.
 *
 * "Forge lanes" design: each operational region of a turn is a full-width tinted
 * band carrying a bright left keyline (`▎`) in the region's accent hue, so
 * consecutive rows form one continuous coloured spine — the eye reads the user's
 * input, tool activity, plan, and diffs as distinct lanes running down the pane
 * rather than one flat monochrome stream. The agent's own prose is deliberately
 * the ONE thing with no lane (open, full-width, warm) — structurally marking it
 * as the agent speaking, not operational work. The renderer process is
 * `exec bun`-launched from source into a tmux pane and cannot reach the
 * hrc-runtime render packages, so the styling is raw truecolor ANSI with no
 * dependencies.
 *
 * Region vocabulary (see the FG/BG "forge lanes" palette in pane-style.ts):
 *   - user input      → violet lane, full multi-line text, `❯` gutter
 *   - agent prose     → NO lane (the primary voice), warm off-white
 *   - agent reasoning → NO lane, quiet muted-grey echo, `∴ thinking` header
 *   - day divider     → dim `── Thu, Sep 4 ──`, on the first stamped band and
 *                       on every date change (a bare `08:06 PM` is ambiguous)
 *   - turn divider    → open molten `▶ turn` (the one bold hue)
 *   - tool call       → kiln-green lane, `$`/glyph gutter, grouped output
 *   - failed tool     → red lane
 *   - plan update     → brass lane, `☑/▸/☐` checklist
 *   - diff update     → teal lane, per-file `+a -r` filestat
 *   - turn footer     → kiln lane `✓ done · <tokens> · <elapsed>`
 *   - running row     → molten lane, live ember bar (ephemeral, never scrollback)
 *   - startup/chrome  → dim `·` lines (recede)
 *
 * Unlike `hrcchat turn` (one redrawn frame), this appends to a long-lived,
 * multi-turn scrollback pane, so it commits each event as it finalizes rather
 * than redrawing in place. Streaming `*.delta` events are folded into the
 * matching `*.completed`; per-step token usage is folded into the footer;
 * high-frequency telemetry (rate limits, thread status) is dropped upstream in
 * the mapper; and bare debug-level driver diagnostics are folded away here so the
 * pane stays quiet — but an unknown-notification diagnostic that carries native
 * params surfaces them as a labeled `data={…}` preview (T-05219).
 */

const MAX_TOOL_OUTPUT_LINES = 3

const TOOL_GLYPH: Record<string, string> = {
  command: '$',
  file_change: '✎',
  mcp_tool: '⚡',
  web_search: '⌕',
  image_view: '◐',
}

function formatTokens(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return str(value)
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function toolGlyph(name: string): string {
  return TOOL_GLYPH[name] ?? '⚙'
}

function toolPreview(input: unknown): string {
  const rec = asRecord(input)
  if (typeof rec['command'] === 'string') return clip(rec['command'])
  for (const value of Object.values(rec)) {
    if (typeof value === 'string' && value.length > 0) return clip(value)
  }
  return clip(str(input))
}

function toolOutput(payload: Record<string, unknown>): string {
  const result = asRecord(payload['result'])
  const raw =
    (typeof result['output'] === 'string' ? result['output'] : undefined) ?? str(payload['output'])
  return raw
}

/**
 * Headline for a failed tool call. Only some drivers set `message`; a codex
 * `commandExecution` reports its failure as `result.exitCode` and an
 * `mcpToolCall` as `result.error`, so a message-only read renders a bare `✗
 * command` with no reason at all (T-06401).
 */
function toolFailure(payload: Record<string, unknown>): string {
  const message = str(payload['message']).trim()
  if (message.length > 0) return message

  const result = asRecord(payload['result'])
  const error = str(result['error']).trim()
  if (error.length > 0) return error

  const exitCode = result['exitCode']
  if (typeof exitCode === 'number') return `exit ${exitCode}`

  const status = str(payload['status']).trim()
  return status.length > 0 ? status : 'failed'
}

function truncateOutput(output: string): string[] {
  const lines = output.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n')
  if (lines.length <= MAX_TOOL_OUTPUT_LINES) return lines
  const remaining = lines.length - MAX_TOOL_OUTPUT_LINES
  return [
    ...lines.slice(0, MAX_TOOL_OUTPUT_LINES),
    `… ${remaining} more line${remaining === 1 ? '' : 's'}`,
  ]
}

/** ` (reason)` when there is one, and nothing at all when there is not. */
function reasonSuffix(reason: unknown): string {
  const text = str(reason).trim()
  return text.length > 0 ? ` · ${clip(text)}` : ''
}

/** `code=1` / `signal=SIGKILL` for a harness that died, whichever the OS gave us. */
function exitDetail(payload: Record<string, unknown>): string {
  const code = payload['exitCode']
  if (typeof code === 'number') return `code=${code}`
  const signal = str(payload['signal'])
  return signal.length > 0 ? `signal=${signal}` : 'no exit status'
}

/**
 * Compile-time proof that every event in the protocol's authoritative
 * `InvocationEventPayloadMap` has been given a rendering decision — shown, or
 * deliberately folded out. Reaching this with a real value is impossible; a NEW
 * event type added to the contract makes it a TYPE ERROR here rather than
 * silently leaking a raw JSON payload into the operator's pane, which is what the
 * old `default:` arm did for thirty-four of them.
 */
function exhaustive(event: never): void {
  void event
}

function shortId(id: string): string {
  const cleaned = id.replace(/^(inv-|turn-|input-)/, '')
  return cleaned.length <= 12 ? cleaned : `${cleaned.slice(0, 8)}…`
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload['text'] === 'string') return payload['text']
  const content = payload['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block !== null && typeof block === 'object'
        ? (block as Record<string, unknown>)['text']
        : undefined
    )
    .filter((t): t is string => typeof t === 'string')
    .join('')
}

export interface CodexTranscriptModelOptions {
  invocationId: string
  emit: (line: string) => void
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
  /**
   * Echo every event as `<type> <payload>` ALONGSIDE its styled render
   * (`BROKER_PANE_VERBOSE=1`). The debugging affordance the old raw-JSON
   * `default:` arm provided by accident, kept deliberately and made total: it
   * covers the events that are folded out too, which are precisely the ones a
   * driver bug hides in.
   */
  verbose?: boolean | undefined
}

export interface CodexTranscriptModel {
  /** Fold one durable broker event into the transcript, emitting styled lines. */
  apply: (event: InvocationEventEnvelope) => void
  /** Surface a durable-read failure visibly (never silently dropped). */
  readFailure: (text: string) => void
}

/**
 * Stateful transcript model. Coalesces assistant `*.delta` streams into the
 * finalized message, pairs `tool.call.started`/`completed` into a grouped band,
 * tracks per-turn usage + elapsed for the footer, renders plan/diff updates as
 * cards, and folds high-frequency telemetry away.
 */
export function createCodexTranscriptModel(
  options: CodexTranscriptModelOptions
): CodexTranscriptModel {
  const emit = options.emit
  const verbose = options.verbose ?? false
  const styler = createCodexStyler(options.color ?? false, options.width)
  const { band, line, dimLine } = styler
  const regions = createTranscriptRegions(emit, styler)

  // Per-turn rolling state.
  const toolNames = new Map<string, string>()
  let assistantBuffer = ''
  let assistantOpen = false
  let turnStartMs = Number.NaN
  let latestTokens: unknown
  let headerShown = false
  /** Chicago calendar date of the last divider committed, '' before the first. */
  let lastDividerDate = ''

  /**
   * The day-divider row (T-07994), consumed at most once per calendar date.
   *
   * Only a STAMPED band asks for one — the bands that carry a clock are exactly
   * the ones whose `hh:mm AM/PM` is ambiguous across midnight — and the date
   * comes from that band's own `event.time`, so replaying a recorded ledger
   * reproduces the recorded dates rather than the dates of the replay. The
   * first stamped band of a pane always triggers one, so scrollback names its
   * date once near the top and then only when the date changes.
   *
   * Returns the row rather than emitting it because a divider belongs INSIDE
   * the band's own leading blank line: the caller owns that ordering, and the
   * bands disagree about whether they open with a blank at all.
   */
  function takeDayDividerRow(ms: number): string | undefined {
    const date = formatPaneDate(ms)
    if (date.length === 0 || date === lastDividerDate) return undefined
    lastDividerDate = date
    return line([{ text: `── ${date} ──`, fg: 'dim' }])
  }

  function flushAssistant(payload: Record<string, unknown>): void {
    const text = extractAssistantText(payload) || assistantBuffer
    assistantBuffer = ''
    assistantOpen = false
    regions.prose(text)
  }

  function apply(event: InvocationEventEnvelope): void {
    const p = asRecord(event.payload)
    // Verbose runs BEFORE the switch and independently of it, so the raw echo is
    // the whole stream — including everything the pane deliberately folds out.
    if (verbose) emit(dimLine(`${event.type} ${clip(str(event.payload))}`))
    switch (event.type) {
      // ── Startup / lifecycle (low-key, dim rail of '·' lines) ────────────
      case 'lifecycle.policy.accepted':
        emit(dimLine(`policy ${str(p['policyId'])} (${str(p['retentionMode']) || 'n/a'})`))
        return
      case 'terminal.surface.reported':
        emit(dimLine(`surface ${str(p['kind'])} ${str(p['paneId'])}`))
        return
      case 'invocation.started':
        emit(dimLine(`process pid=${str(p['pid'])}`))
        return
      case 'continuation.updated':
        emit(dimLine(`thread ${shortId(str(p['key']))}`))
        return
      case 'continuation.cleared':
        emit(dimLine(`thread cleared (${str(p['reason']) || 'n/a'})`))
        return
      case 'input.accepted':
        emit(dimLine(`input ${str(p['disposition']) || 'accepted'}`))
        return
      case 'invocation.ready': {
        if (!headerShown) {
          headerShown = true
          emit('')
          emit(line([{ text: `codex-app-server · ${shortId(options.invocationId)}`, fg: 'dim' }]))
        }
        emit(
          line([
            { text: '● ', fg: 'kiln' },
            { text: 'ready', fg: 'text', bold: true },
          ])
        )
        return
      }
      case 'invocation.exited':
        emit(dimLine(`exited code=${str(p['exitCode'])} signal=${str(p['signal'])}`))
        return
      case 'invocation.failed':
        emit(line([{ text: `✗ ${str(p['message'])}`, fg: 'red', bold: true }]))
        return
      case 'invocation.summary':
        emit(dimLine(`summary ${str(p['summary'] ?? p)}`))
        return
      case 'driver.notice':
        emit(line([{ text: `⚠ ${str(p['message'])}`, fg: 'brass' }]))
        return
      case 'invocation.stopping':
        emit(dimLine(`stopping${reasonSuffix(p['reason'])}`))
        return

      // ── Harness generations (T-07906) ───────────────────────────────────
      //
      // Previously invisible in the pane, which is the worst way for it to fail: a
      // mid-turn recycle reads exactly like the model going quiet. These rows are
      // the difference between "it is thinking" and "it died and came back".
      case 'harness.started':
        // A first generation is already announced by `invocation.started`/`ready`.
        // Only a RECYCLE is news, and it is the news that explains the silence.
        if (str(p['mode']) !== 'recycle') return
        emit(dimLine(`harness recycled · gen ${str(p['generation'])}`))
        return
      case 'harness.exited': {
        const reason = str(p['reason'])
        // The kill half of a recycle is not an exit the operator needs; the
        // `harness.started` recycle row above is the fact.
        if (reason === 'recycle-kill') return
        if (reason === 'crash') {
          emit(line([{ text: `✗ harness crashed · ${exitDetail(p)}`, fg: 'red', bold: true }]))
          return
        }
        emit(dimLine(`harness exited (${reason})`))
        return
      }
      case 'harness.recovery.started':
        emit(line([{ text: `⚠ recovering · ${str(p['reason'])}`, fg: 'brass' }]))
        return
      case 'harness.recovery.completed':
        emit(
          line([
            { text: '● ', fg: 'kiln', bold: true },
            { text: 'recovered', fg: 'text', bold: true },
            {
              text: ` · gen ${str(p['toGeneration'])} · ${p['ready'] === true ? 'ready' : 'not ready'}`,
              fg: 'dim',
            },
          ])
        )
        return
      case 'harness.recovery.failed':
        emit(line([{ text: `✗ recovery failed · ${str(p['reason'])}`, fg: 'red', bold: true }]))
        return
      case 'lifecycle.escalation':
        emit(
          line([
            {
              text: `✗ escalation · ${str(p['reason'])} → ${str(p['requestedAction'])}`,
              fg: 'red',
              bold: true,
            },
          ])
        )
        return

      // ── Turn + message flow ─────────────────────────────────────────────
      case 'user.message':
        regions.userInput(str(p['content']))
        return
      case 'turn.started': {
        turnStartMs = parseMs(event.time)
        latestTokens = undefined
        const startedClock = formatClock(turnStartMs)
        const startedDivider = takeDayDividerRow(turnStartMs)
        emit('')
        if (startedDivider !== undefined) emit(startedDivider)
        emit(
          line([
            { text: '▶ ', fg: 'molten', bold: true },
            { text: 'turn', fg: 'text', bold: true },
            { text: ` ${shortId(str(p['turnId']))}`, fg: 'dim' },
            ...(startedClock.length > 0
              ? [{ text: ` · ${startedClock}`, fg: 'dim' as CodexFg }]
              : []),
          ])
        )
        return
      }
      case 'assistant.message.started':
        assistantBuffer = ''
        assistantOpen = true
        return
      case 'assistant.message.delta':
        if (assistantOpen) assistantBuffer += str(p['text'])
        return // streaming chunk — folded into the completed message
      case 'assistant.message.completed':
        flushAssistant(p)
        return

      // ── Tool calls (grouped: started band + ↳ output) ───────────────────
      case 'tool.call.started': {
        const name = str(p['name']) || 'tool'
        toolNames.set(str(p['toolCallId'] ?? p['callId']), name)
        emit(
          band('tool', 'kiln', [
            { text: `${toolGlyph(name)} `, fg: 'kiln', bold: true },
            { text: name, fg: 'text', bold: true },
            { text: `  ${toolPreview(p['input'])}`, fg: 'muted' },
          ])
        )
        return
      }
      case 'tool.call.delta': {
        // Output chunks stay folded into the completed output. A unified_exec
        // stdin write is not a chunk of anything — it is one whole line the
        // model typed into a still-open PTY — so it is shown at the point it
        // happened, in the exec card's own band.
        if (str(asRecord(p['data'])['stream']) !== 'stdin') return
        const typed = clip(str(p['text']))
        if (typed.length === 0) return
        emit(
          band('tool', 'kiln', [
            { text: '› ', fg: 'dim' },
            { text: typed, fg: 'muted' },
          ])
        )
        return
      }
      case 'tool.call.completed': {
        const output = toolOutput(p)
        const lines = output.trim().length > 0 ? truncateOutput(output) : []
        lines.forEach((body, idx) => {
          emit(
            band('tool', 'kiln', [
              { text: idx === 0 ? '↳ ' : '  ', fg: 'dim' },
              { text: body, fg: 'muted' },
            ])
          )
        })
        return
      }
      case 'tool.call.failed': {
        const name = str(p['name']) || toolNames.get(str(p['toolCallId'] ?? p['callId'])) || 'tool'
        emit(
          band('error', 'red', [
            { text: '✗ ', fg: 'red', bold: true },
            { text: name, fg: 'red', bold: true },
            { text: `  ${clip(toolFailure(p))}`, fg: 'red' },
          ])
        )
        const output = toolOutput(p)
        if (output.trim().length > 0) {
          truncateOutput(output).forEach((body, idx) => {
            emit(
              band('error', 'red', [
                { text: idx === 0 ? '↳ ' : '  ', fg: 'dim' },
                { text: body, fg: 'red' },
              ])
            )
          })
        }
        return
      }

      // ── Admission, queue + submission (T-07906) ─────────────────────────
      //
      // The DRAWER owns "waiting" (see queue-drawer.ts): an entry is on screen for
      // exactly as long as the wait lasts, so nothing here commits a row about a
      // message that is merely queued. What is left is the news — every way a
      // message can fail to reach the model, which is otherwise silent.
      case 'admission.rejected':
        emit(
          line([
            {
              text: `✗ rejected at ${str(p['layer'])}${reasonSuffix(p['reason'])}`,
              fg: 'red',
              bold: true,
            },
          ])
        )
        return
      case 'input.rejected':
        emit(
          line([{ text: `✗ input rejected${reasonSuffix(p['reason'])}`, fg: 'red', bold: true }])
        )
        return
      case 'queue.jumped':
        emit(
          dimLine(
            `queue ${shortSubmissionId(str(p['submissionId']))} · pos ${str(p['fromPosition'])} → ${str(p['toPosition'])} (${shortPrincipal(str(p['principalRef']))})`
          )
        )
        return
      case 'queue.cancelled':
        emit(
          dimLine(
            `queue cancelled ${shortSubmissionId(str(p['submissionId']))} (${shortPrincipal(str(p['principalRef']))})`
          )
        )
        return
      case 'queue.expired':
        // Silent data loss if unrendered: someone's message hit its TTL and nobody
        // in the pane ever learns it was not delivered.
        emit(
          line([
            {
              text: `⚠ ${shortSubmissionId(str(p['submissionId']))} expired in the queue — never delivered`,
              fg: 'brass',
            },
          ])
        )
        return
      case 'queue.withdrawn':
        emit(
          dimLine(
            `withdrawn ${shortSubmissionId(str(p['submissionId']))}${reasonSuffix(p['reason'])}`
          )
        )
        return
      case 'submission.rejected':
        emit(
          line([
            {
              text: `✗ ${shortSubmissionId(str(p['submissionId']))} rejected${reasonSuffix(p['reason'])}`,
              fg: 'red',
              bold: true,
            },
          ])
        )
        return
      case 'submission.expired':
        emit(
          line([{ text: `⚠ ${shortSubmissionId(str(p['submissionId']))} expired`, fg: 'brass' }])
        )
        return
      case 'submission.withdrawn':
        emit(
          dimLine(
            `withdrawn ${shortSubmissionId(str(p['submissionId']))}${reasonSuffix(p['reason'])}`
          )
        )
        return
      case 'submission.cancelled': {
        const reason = str(p['reason'])
        // Teardown cancels whatever was still held when the invocation ends; it is
        // the shutdown, not a disposition anyone needs to read.
        if (reason === 'teardown') return
        emit(
          dimLine(`cancelled ${shortSubmissionId(str(p['submissionId']))}${reasonSuffix(reason)}`)
        )
        return
      }
      case 'submission.lost':
        emit(
          line([
            {
              text: `✗ ${shortSubmissionId(str(p['submissionId']))} delivery outcome lost${reasonSuffix(p['reason'])}`,
              fg: 'red',
              bold: true,
            },
          ])
        )
        return
      case 'interrupt.failed':
        // The only interrupt event that is news: you asked it to stop and it did not.
        emit(line([{ text: `⚠ interrupt failed${reasonSuffix(p['reason'])}`, fg: 'brass' }]))
        return

      // ── Diagnostics + telemetry ─────────────────────────────────────────
      case 'diagnostic':
        regions.diagnostic(p)
        return
      case 'usage.updated': {
        // Track for the turn footer only — a codex turn emits a token update per
        // step, so rendering each one floods the pane. The final `✓ done` line
        // carries the final request's context usage. `usage.total` is cumulative
        // across every request in the invocation and would mislabel millions of
        // lifetime tokens as one turn's context size (T-06423).
        const last = asRecord(asRecord(p['usage'])['last'])
        latestTokens = last['totalTokens']
        return
      }
      case 'turn.retry':
        // `at-least-once` is the operator-facing half: the model may have seen this
        // prompt already, so a repeated answer above is delivery, not confusion.
        emit(
          line([
            {
              text: `⚠ retry ${str(p['toAttempt'])} · ${str(p['reason'])} · ${str(p['semantics'])}`,
              fg: 'brass',
            },
          ])
        )
        return
      case 'permission.resolved':
        // Asks are auto-answered by policy in this driver and the audit lives on the
        // durable stream. An ALLOW is noise; a deny silently changed what the agent
        // was able to do, which is what makes the tool behaviour above baffling.
        if (str(p['decision']) !== 'deny') return
        emit(
          line([
            {
              text: `⚠ permission denied (${str(p['source'])})${reasonSuffix(p['reason'])}`,
              fg: 'brass',
            },
          ])
        )
        return
      case 'capture.warning':
        // `blocked_unknown` fires per unclassified record, and by the T-07883 ruling
        // it is already on the broker's own stderr and the durable ledger. In the
        // pane it would be a normalizer's business flooding a conversation.
        if (str(p['kind']) === 'blocked_unknown') return
        emit(line([{ text: `⚠ capture · ${clip(str(p['message']))}`, fg: 'brass' }]))
        return
      case 'turn.completed': {
        const endedMs = parseMs(event.time)
        const elapsed = formatElapsed(endedMs - turnStartMs)
        const stats = [
          latestTokens !== undefined ? `${formatTokens(latestTokens)} tok` : '',
          elapsed,
          formatClock(endedMs),
        ]
          .filter((s) => s.length > 0)
          .join(' · ')
        const endedDivider = takeDayDividerRow(endedMs)
        emit('')
        if (endedDivider !== undefined) emit(endedDivider)
        emit(
          band('endturn', 'kiln', [
            { text: '✓ ', fg: 'kiln', bold: true },
            { text: 'done', fg: 'text', bold: true },
            ...(stats.length > 0 ? [{ text: ` · ${stats}`, fg: 'dim' as CodexFg }] : []),
          ])
        )
        return
      }
      case 'turn.failed': {
        const failedMs = parseMs(event.time)
        const failedClock = formatClock(failedMs)
        const failedDivider = takeDayDividerRow(failedMs)
        emit('')
        if (failedDivider !== undefined) emit(failedDivider)
        emit(
          band('error', 'red', [
            { text: '✗ ', fg: 'red', bold: true },
            { text: 'failed', fg: 'red', bold: true },
            {
              text: `  ${clip(str(p['message'] ?? p['finalOutput'] ?? p['code']))}`,
              fg: 'red',
            },
            ...(failedClock.length > 0
              ? [{ text: ` · ${failedClock}`, fg: 'dim' as CodexFg }]
              : []),
          ])
        )
        return
      }
      case 'turn.interrupted': {
        // The one turn terminal that used to land without a time (T-07994).
        const interruptedMs = parseMs(event.time)
        const interruptedClock = formatClock(interruptedMs)
        const interruptedDivider = takeDayDividerRow(interruptedMs)
        // Unlike the other terminals this row opens no blank of its own, so a
        // divider brings one with it rather than butting against the last row.
        if (interruptedDivider !== undefined) {
          emit('')
          emit(interruptedDivider)
        }
        emit(
          line([
            { text: '◼ interrupted', fg: 'brass' },
            ...(interruptedClock.length > 0
              ? [{ text: ` · ${interruptedClock}`, fg: 'dim' as CodexFg }]
              : []),
          ])
        )
        return
      }

      // ── Deliberately folded OUT of the pane ─────────────────────────────
      //
      // Every one of these is real, durable, and reachable with
      // BROKER_PANE_VERBOSE=1. None is a fact an operator reads a pane for:
      //
      //  - the admission happy path is bookkeeping. `requested`/`admitted` are
      //    always followed by an outcome the pane already shows, and
      //    `executed`/`absorbed` are the submissionId→turnId join record.
      //  - `queue.enqueued` / `input.queued` are rendered by the DRAWER, which
      //    shows a wait for as long as it lasts instead of stamping a permanent
      //    line into scrollback about a state that ended seconds later.
      //  - an interrupt's request and landing are its intent; `turn.interrupted`
      //    is the fact, and only `interrupt.failed` is news.
      //  - `turn.stalled` annotates the live running row (status-line.ts). It is
      //    heartbeat-driven, so a row per event would flood the pane with the one
      //    thing it is trying to say: nothing has happened.
      //  - permission asks are auto-answered by policy in this driver
      //    (permissions.ts:223); only a deny is rendered, above.
      //  - `provider.transcript.reported` and `capture.released` are sidecar-path
      //    records for downstream consumers, not conversation.
      case 'admission.requested':
      case 'admission.admitted':
      case 'submission.executed':
      case 'submission.absorbed':
      case 'queue.enqueued':
      case 'input.queued':
      case 'interrupt.requested':
      case 'interrupt.landed':
      case 'turn.stalled':
      case 'turn.attributed':
      case 'invocation.disposed':
      case 'permission.requested':
      case 'permission.cancelled':
      case 'capture.released':
      case 'provider.transcript.reported':
        return

      default:
        // Unreachable by construction: `event` is `never` here only if every member
        // of the protocol's event map was handled above. A new event type lands as a
        // compile error, not as raw JSON in the operator's pane.
        exhaustive(event)
    }
  }

  function readFailure(text: string): void {
    emit(line([{ text: `✗ ${text}`, fg: 'red', bold: true }]))
  }

  return { apply, readFailure }
}
