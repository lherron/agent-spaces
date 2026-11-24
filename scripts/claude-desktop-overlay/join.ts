import { spawn } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  readRegistryWithLastGood,
  resolveDesktopProjectSync,
} from '../../harness/harness-broker/src/desktop-project'

const userHome = homedir()
const claudeHome = join(userHome, '.claude')
const platformRoot = join(userHome, 'praesidium', 'var')
const hintTimeoutMs = 2_000

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

function registeredAddress(stateDir: string, sessionId: string): string | undefined {
  const record = readJson(join(stateDir, 'join.json'))
  if (record?.['phase'] !== 'joined' || !isLivePid(record['pid'])) return undefined
  const scope = record['scopeRef']
  if (typeof scope !== 'string') return undefined
  const match = /^agent:vega:project:([^:]+):task:(.+)$/.exec(scope)
  if (match?.[2] === `claude-${sessionId}`) return `vega@${match[1]}:${match[2]}`
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
    }
    if (hook === 'UserPromptSubmit') emitRegisteredReport(stateDir, sessionId)
    if (hook === 'SessionStart') {
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
    } else if (hook === 'UserPromptSubmit' || hook === 'Stop' || hook === 'Notification') {
      await sendHint(stateDir, raw, hook)
    }
  } catch {
    log(stateDir, 'hook-error')
  }
}

run().catch(() => {})
