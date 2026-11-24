import { spawn } from 'node:child_process'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  claudeDesktopProjectId,
  installClaudeCallerEnvSource,
} from '../../harness/harness-broker/src/desktop-join-claude-env'
import {
  readRegistryWithLastGood,
  resolveDesktopProjectSync,
} from '../../harness/harness-broker/src/desktop-project'
import { queryMailStopDecision } from '../../harness/harness-broker/src/drivers/mail-stop-gate'

const userHome = homedir()
const claudeHome = join(userHome, '.claude')
const platformRoot = join(userHome, 'praesidium', 'var')
const hintTimeoutMs = 2_000
/** An ended session's binding waits this long for the app to resume the session. */
const endedRecordMaxAgeMs = 30 * 24 * 60 * 60 * 1000

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function log(stateDir: string, event: string, hook?: string) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    appendFileSync(
      join(stateDir, 'hook.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), event, hook })}\n`,
      { mode: 0o600 }
    )
  } catch {}
}

function isLivePid(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function brokerBin(): string | undefined {
  const activation = readJson(
    process.env['ASPD_ACTIVE_JSON'] ?? join(platformRoot, 'aspd', 'service', 'active.json')
  )
  const release = activation?.['releasePath']
  if (
    activation?.['schemaVersion'] !== 'aspd-service-activation/v1' ||
    typeof activation['releaseId'] !== 'string' ||
    typeof release !== 'string' ||
    !isAbsolute(release) ||
    readJson(join(release, 'release.json'))?.['releaseId'] !== activation['releaseId']
  ) {
    return undefined
  }
  return join(release, 'libexec', 'harness-broker')
}

function startJoiner(stateDir: string, sessionId: string, pid: string, hook: string) {
  try {
    if (isLivePid(Number(readFileSync(join(stateDir, 'broker.pid'), 'utf8').trim()))) return
  } catch {}
  const binary = brokerBin()
  if (!binary) {
    log(stateDir, 'active-release-unavailable', hook)
    return
  }
  const child = spawn(
    binary,
    ['desktop-join', '--harness', 'claude-desktop', '--session', sessionId, '--source', hook],
    {
      env: { ...process.env, CLAUDE_PID: pid },
      detached: true,
      stdio: 'ignore',
    }
  )
  child.once('spawn', () => log(stateDir, 'joiner-spawned', hook))
  child.once('error', () => log(stateDir, 'joiner-spawn-failed', hook))
  child.unref()
}

function brokerAlive(stateDir: string): boolean {
  let pid: number | undefined
  try {
    pid = Number(readFileSync(join(stateDir, 'broker.pid'), 'utf8').trim())
  } catch {}
  return isLivePid(pid) || isLivePid(readJson(join(stateDir, 'join.json'))?.['pid'])
}

/**
 * Remove the state of desktop sessions that are over (T-14467): no registry
 * row with a live pid names the session, and no broker for it is alive. A
 * broker that saw its session end already removed its own state once HRC
 * recorded the exit; this catches the rest, such as a killed broker or an exit
 * HRC never acked. HRC's own sweep settles the runtime. Cheap and fail-open:
 * an unreadable registry skips the whole sweep, so a row caught mid-write
 * never makes a live session look ended. Ended records (a cleanly ended
 * session's binding, kept for a resumed session's rejoin) are pruned after 30
 * days unless their session is live.
 */
function sweepEndedSessions(currentSessionId: string) {
  const sessionsDir = join(claudeHome, 'sessions')
  const liveSessions = new Set<string>()
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith('.json')) continue
    const row = readJson(join(sessionsDir, name))
    if (row === undefined) return
    if (typeof row['sessionId'] === 'string' && isLivePid(row['pid'])) {
      liveSessions.add(row['sessionId'])
    }
  }
  const stateRoot = join(claudeHome, 'hrc-desktop')
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    const sessionId = entry.name
    if (
      !entry.isDirectory() ||
      sessionId === currentSessionId ||
      !/^[a-zA-Z0-9_-]+$/.test(sessionId) ||
      liveSessions.has(sessionId)
    ) {
      continue
    }
    const stateDir = join(stateRoot, sessionId)
    if (brokerAlive(stateDir)) continue
    try {
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(join(claudeHome, 'hrc-desktop-scopes', `${sessionId}.json`), { force: true })
      appendFileSync(
        join(claudeHome, 'hrc-desktop-ended.log'),
        `${JSON.stringify({ at: new Date().toISOString(), sessionId, sweptBy: currentSessionId })}\n`,
        { mode: 0o600 }
      )
    } catch {}
  } // An ended record is the binding a resumed session rejoins from; one whose
  // session never came back ages out.
  const endedRoot = join(claudeHome, 'hrc-desktop-ended')
  let endedNames: string[] = []
  try {
    endedNames = readdirSync(endedRoot)
  } catch {}
  for (const name of endedNames) {
    const sessionId = name.replace(/\.json$/, '')
    if (!name.endsWith('.json') || liveSessions.has(sessionId)) continue
    const path = join(endedRoot, name)
    try {
      if (Date.now() - statSync(path).mtimeMs > endedRecordMaxAgeMs) rmSync(path, { force: true })
    } catch {}
  }
}

function registeredAddress(stateDir: string, sessionId: string): string | undefined {
  const record = readJson(join(stateDir, 'join.json'))
  if (record?.['phase'] !== 'joined' || !isLivePid(record['pid'])) return undefined
  const projectId = claudeDesktopProjectId(record['scopeRef'], sessionId)
  if (projectId) return `vega@${projectId}:claude-${sessionId}`
}

async function joinReport(stateDir: string, sessionId: string, cwd: string): Promise<string> {
  const alreadyRegistered = registeredAddress(stateDir, sessionId)
  if (alreadyRegistered) return `registered: ${alreadyRegistered}`
  const registry = await readRegistryWithLastGood(
    join(claudeHome, 'hrc-desktop-registry.json'),
    1_500,
    (event) => log(stateDir, event, 'SessionStart')
  )
  const newlyRegistered = registeredAddress(stateDir, sessionId)
  if (newlyRegistered) return `registered: ${newlyRegistered}`
  if ('error' in registry) {
    log(stateDir, 'project-registry-unavailable', 'SessionStart')
    return 'provisional address unavailable (project registry unavailable)'
  }
  const project = resolveDesktopProjectSync(cwd, registry.projects, {})
  const projectId = 'bound' in project ? project.bound.projectId : 'praesidium'
  return `provisional: vega@${projectId}:claude-${sessionId}`
}

function emitRegisteredReport(stateDir: string, sessionId: string) {
  const address = registeredAddress(stateDir, sessionId)
  if (!address) return
  try {
    // Concurrent prompts share this claim. A provisional report never takes it.
    writeFileSync(join(stateDir, 'registered-report.sent'), '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      log(stateDir, 'registered-report-marker-error', 'UserPromptSubmit')
    }
    return
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `## Join report\n\nregistered: ${address}\n`,
      },
    })
  )
  log(stateDir, 'registered-report-emitted', 'UserPromptSubmit')
}

/**
 * Reply enforcement, not delivery: HRC blocks the turn's end while presented,
 * reply-required mail is unanswered. It sees only mail already presented.
 * Every failure is an allow, so the session is never wedged.
 */
async function mailStopDecision(stateDir: string, sessionId: string, input: unknown) {
  const record = readJson(join(stateDir, 'join.json'))
  const runtimeId = record?.['runtimeId']
  const caller = registeredAddress(stateDir, sessionId)
  if (caller === undefined || typeof runtimeId !== 'string') return undefined
  return queryMailStopDecision(input, {
    HRC_MAIL_STOP_SOCKET:
      process.env['HRC_MAIL_STOP_SOCKET'] ?? join(platformRoot, 'run', 'hrc', 'hrc.sock'),
    HARNESS_BROKER_RUNTIME_ID: runtimeId,
    PRAESIDIUM_CALLER: caller,
  })
}

async function sendHint(stateDir: string, raw: string, hook: string): Promise<void> {
  const path = join(stateDir, 'hook.sock')
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSocket()) return
  await new Promise<void>((resolve) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      log(stateDir, 'hint-timeout', hook)
      socket.destroy()
    }, hintTimeoutMs)
    socket.once('connect', () => socket.end(`{"hookData":${raw}}`))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') {
        log(stateDir, 'hint-error', hook)
      }
    })
    socket.setEncoding('utf8')
    let ack = ''
    socket.on('data', (chunk) => {
      ack = (ack + chunk).slice(0, 4)
    })
    socket.once('end', () => {
      if (ack !== 'ok') log(stateDir, 'hint-refused', hook)
    })
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function run() {
  const pid = process.argv[2]
  const row = readJson(join(claudeHome, 'sessions', `${pid}.json`))
  if (row?.['entrypoint'] !== 'claude-desktop') return
  const raw = readFileSync(0, 'utf8').trim()
  const input = JSON.parse(raw)
  const sessionId = input?.session_id
  const hook = input?.hook_event_name
  if (
    typeof sessionId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(sessionId) ||
    row['sessionId'] !== sessionId ||
    typeof row['cwd'] !== 'string'
  )
    return

  const stateDir = join(claudeHome, 'hrc-desktop', sessionId)
  try {
    if (hook === 'SessionStart' || hook === 'UserPromptSubmit') {
      startJoiner(stateDir, sessionId, pid ?? '', hook)
      try {
        sweepEndedSessions(sessionId)
      } catch {
        log(stateDir, 'sweep-error', hook)
      }
    }
    if (hook === 'UserPromptSubmit') emitRegisteredReport(stateDir, sessionId)
    if (hook === 'SessionStart') {
      const envFile = process.env['CLAUDE_ENV_FILE']
      if (envFile) {
        try {
          installClaudeCallerEnvSource(envFile, stateDir)
        } catch {
          log(stateDir, 'caller-env-source-error', hook)
        }
      }
      let instructions = ''
      try {
        instructions = readFileSync(
          join(platformRoot, 'agents', 'vega', 'DESKTOP_SESSION.md'),
          'utf8'
        )
      } catch {
        log(stateDir, 'vega-instructions-unavailable', hook)
      }
      const report = await joinReport(stateDir, sessionId, row['cwd'])
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext:
              `${instructions.trimEnd()}\n\n## Join report\n\n${report}\n`.trimStart(),
          },
        })
      )
    } else if (hook === 'Stop') {
      // Ask before the hint: the hint wakes a read that may close the turn.
      const decision = await mailStopDecision(stateDir, sessionId, input).catch(() => undefined)
      await sendHint(stateDir, raw, hook)
      if (decision !== undefined) {
        console.log(JSON.stringify(decision))
        log(stateDir, 'mail-stop-blocked', hook)
      }
    } else if (hook === 'UserPromptSubmit' || hook === 'Notification') {
      await sendHint(stateDir, raw, hook)
    }
  } catch {
    log(stateDir, 'hook-error')
  }
}

run().catch(() => {})
