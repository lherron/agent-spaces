import { ASPD_ACTIVE_JSON_PATH, DISCOVERY_TIMEOUT_MS } from './constants'

export function hookCommand(scriptPath: string): string {
  return `node ${shellQuote(scriptPath)}`
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

const HOOK_SHARED_PRELUDE = `function readStdin() {
  return new Promise((resolveText) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolveText(data))
  })
}

function shellQuote(value) {
  return \`'\${String(value).replace(/'/g, "'\\\\''")}'\`
}

function readEnvLocalValue(startDir, names) {
  const wanted = new Set(names)
  let dir = resolve(startDir || process.cwd())
  while (true) {
    const candidate = join(dir, '.env.local')
    if (existsSync(candidate)) {
      const lines = readFileSync(candidate, 'utf8').split(/\\r?\\n/u)
      const values = new Map()
      for (const line of lines) {
        const match = /^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+?)\\s*$/u.exec(line)
        if (!match || !wanted.has(match[1])) continue
        values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''))
      }
      for (const name of names) {
        if (values.has(name)) return values.get(name)
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readEnvLocalProject(startDir) {
  return readEnvLocalValue(startDir, ['WRKQ_PROJECT_ROOT'])
}

function readEnvLocalAspHome(startDir) {
  return readEnvLocalValue(startDir, ['ASP_HOME', 'ASP_ROOT_DIR'])
}

function projectFromPraesidiumPath(cwd) {
  const root = join(homedir(), 'praesidium')
  const resolved = resolve(cwd || process.cwd())
  if (resolved === root) return 'praesidium'
  if (!resolved.startsWith(root + '/')) return undefined
  const rest = resolved.slice(root.length + 1)
  const first = rest.split('/')[0]
  return first || undefined
}

function projectFromWrkqProjects(cwd) {
  try {
    const raw = execFileSync('wrkq', ['projects', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const rows = JSON.parse(raw)
    const resolved = resolve(cwd)
    const root = join(homedir(), 'praesidium')
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.path !== 'string' || typeof row?.slug !== 'string') continue
      const path = row.path.startsWith('/') ? row.path : join(root, row.path)
      if (resolved === path || resolved.startsWith(path + '/')) {
        return row.slug
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function projectFromGitRemote(cwd) {
  try {
    const raw = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const tail = raw.split(/[/:]/u).pop() || ''
    return tail.replace(/\\.git$/u, '') || undefined
  } catch {
    return undefined
  }
}

function resolveProject(cwd) {
  return (
    readEnvLocalProject(cwd) ||
    projectFromPraesidiumPath(cwd) ||
    projectFromWrkqProjects(cwd) ||
    projectFromGitRemote(cwd) ||
    basename(resolve(cwd || process.cwd()))
  )
}

function resolveAspHome(cwd) {
  return readEnvLocalAspHome(cwd) || process.env.ASP_HOME || DEFAULT_ASP_HOME
}

function codexHomeDir() {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * The projection of HRC's allocation for this native thread, or undefined.
 *
 * READ ONLY, and never a fallback allocator: contract §4 is explicit that
 * "the cache is not an independent allocator", so a missing or unreadable file
 * means "not registered yet", never "mint something locally".
 */
function readEstablishedScope(threadId) {
  if (!threadId) return undefined
  const dir = process.env.HRC_DESKTOP_CACHE_DIR || join(codexHomeDir(), 'hrc-desktop-scopes')
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(dir), threadId + '.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    if (typeof parsed.scopeRef !== 'string' || parsed.scopeRef.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** The UUID-style address this conversation used before registration. */
function legacyTaskId(sessionId) {
  const id = String(sessionId || 'codex-app')
  return id.startsWith('codex-') ? id : 'codex-' + id
}

function legacyScopeRef(input) {
  const project = resolveProject(input.cwd || process.cwd())
  return (
    'agent:' + AGENT_ID + ':project:' + project + ':task:' + legacyTaskId(input.session_id)
  )
}

`

export function buildPreToolUseHookScript(agentId: string, aspHome: string): string {
  const escapedAgentId = JSON.stringify(agentId)
  const escapedAspHome = JSON.stringify(aspHome)
  return `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const AGENT_ID = ${escapedAgentId}
const DEFAULT_ASP_HOME = ${escapedAspHome}
// wrkc and wrkp were missing, which is why a desktop conversation could read
// its mail through a presentation but not answer it: \`wrkc say\` ran with no
// ASP_SCOPE_REF and therefore no identity (contract \u00a74, "the current command
// allowlist is incomplete").
const PRAESIDIUM_COMMANDS = new Set([
  'asp',
  'wrkq',
  'wrkc',
  'wrkf',
  'wrkp',
  'hrc',
  'hrcchat',
  'acp',
])

${HOOK_SHARED_PRELUDE}function splitShellSegments(command) {
  const segments = []
  let current = ''
  let quote = undefined
  let escaped = false

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const next = command[i + 1]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\\\' && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      current += char
      quote = char
      continue
    }
    if (char === '&' && next === '&') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === '|' && next === '|') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === ';' || char === '|' || char === '(' || char === ')' || char === '\\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function tokenizeShellWords(segment) {
  const words = []
  let current = ''
  let quote = undefined
  let escaped = false

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\\s/u.test(char)) {
      if (current.length > 0) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) words.push(current)
  return words
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)
}

function commandName(word) {
  return basename(word)
}

function firstCommandWord(words) {
  let index = 0
  while (index < words.length && isAssignment(words[index])) index += 1
  if (words[index] === 'command' || words[index] === 'exec') index += 1
  if (words[index] === 'env') {
    index += 1
    while (index < words.length && (words[index].startsWith('-') || isAssignment(words[index]))) {
      index += 1
    }
  }
  return words[index]
}

function usesPraesidiumCommand(command) {
  for (const segment of splitShellSegments(command)) {
    const words = tokenizeShellWords(segment)
    const first = firstCommandWord(words)
    if (first && PRAESIDIUM_COMMANDS.has(commandName(first))) {
      return true
    }
  }
  return false
}

function resolvedScope(input) {
  const cwd = input.cwd || process.cwd()
  // The ESTABLISHED registration wins over everything computed locally, and it
  // is the only source of a readable Stella address. Its project is FROZEN at
  // registration, which is also the fix for the cwd/ScopeRef disagreement
  // (T-07514): a conversation whose workspace sits under one repo no longer
  // reports a project resolved from whatever ancestor directory it was in.
  const established = readEstablishedScope(input.session_id)
  if (established !== undefined) {
    const canonical = {
      ASP_AGENT_ID: established.agentId || AGENT_ID,
      ASP_HOME: resolveAspHome(established.projectRoot || cwd),
      ASP_PROJECT: established.projectId,
      ASP_TASK_ID: established.slotToken,
      ASP_SCOPE_REF: established.scopeRef,
      HRC_SESSION_REF: \`\${established.scopeRef}/lane:\${established.laneRef || 'main'}\`,
    }
    return {
      project: canonical.ASP_PROJECT,
      aspHome: canonical.ASP_HOME,
      taskId: canonical.ASP_TASK_ID,
      scopeRef: canonical.ASP_SCOPE_REF,
      sessionRef: canonical.HRC_SESSION_REF,
      registration: 'established',
      exportsLine:
        'export ' +
        Object.entries(canonical)
          .map(([key, value]) => \`\${key}=\${shellQuote(value)}\`)
          .join(' '),
    }
  }
  const project = resolveProject(cwd)
  const aspHome = resolveAspHome(cwd)
  const taskId = legacyTaskId(input.session_id)
  const scopeRef = \`agent:\${AGENT_ID}:project:\${project}:task:\${taskId}\`
  const sessionRef = \`\${scopeRef}/lane:main\`
  const entries = {
    ASP_AGENT_ID: AGENT_ID,
    ASP_HOME: aspHome,
    ASP_PROJECT: project,
    ASP_TASK_ID: taskId,
    ASP_SCOPE_REF: scopeRef,
    HRC_SESSION_REF: sessionRef,
  }
  const exportsLine =
    'export ' +
    Object.entries(entries)
      .map(([key, value]) => \`\${key}=\${shellQuote(value)}\`)
      .join(' ')
  // Pre-registration behavior is UNCHANGED and deliberately so: contract \u00a74
  // says to "retain the existing UUID-style hook behavior and clearly report
  // integration pending; do not mint a friendly name locally".
  return {
    project,
    aspHome,
    taskId,
    scopeRef,
    sessionRef,
    registration: 'pending',
    exportsLine,
  }
}

const raw = await readStdin()
if (raw.trim().length === 0) process.exit(0)

let input
try {
  input = JSON.parse(raw)
} catch {
  process.exit(0)
}

if (input.hook_event_name !== 'PreToolUse') process.exit(0)
if (input.tool_name !== 'Bash') process.exit(0)

const command = input.tool_input?.command
if (typeof command !== 'string' || command.trim().length === 0) process.exit(0)
if (!usesPraesidiumCommand(command)) process.exit(0)

const scope = resolvedScope(input)
const updatedCommand = \`\${scope.exportsLine}
\${command}\`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: \`Praesidium env: ASP_PROJECT=\${scope.project}, ASP_HOME=\${scope.aspHome}, ASP_SCOPE_REF=\${scope.scopeRef} (HRC registration: \${scope.registration})\`,
      updatedInput: { command: updatedCommand },
    },
  })
)
`
}

/**
 * The SessionStart / UserPromptSubmit self-join hook (T-08594 component 5).
 *
 * It does not call HRC and it waits for nothing. On either event it resolves
 * the active ASP release AT HOOK RUN TIME from the aspd activation record,
 * spawns `harness-broker desktop-join` for this thread detached, and exits 0:
 *
 *  - the broker (not the hook) admits the thread, joins HRC, observes the
 *    rollout, and owns the address cache the PreToolUse hook reads;
 *  - a missing/unreadable activation, a release mismatch, a refused admission,
 *    and every other non-join is a typed line in the thread's join.log and an
 *    exit 0 — a join that did not happen is normal state (subagent thread,
 *    daemon restarting), never a hook failure and never a failed turn;
 *  - malformed stdin is the only exit 1.
 *
 * `UserPromptSubmit` fires on EVERY prompt (never skipped on a cache hit): it
 * is the respawn door for a conversation that stays open while its broker
 * dies — no SessionStart fires without a close/reopen, and the broker's
 * pid+socket idempotency makes a redundant spawn a no-op exit 0.
 */
export function buildDiscoveryHookScript(agentId: string, aspHome: string): string {
  const escapedAgentId = JSON.stringify(agentId)
  const escapedAspHome = JSON.stringify(aspHome)
  const escapedActiveJson = JSON.stringify(ASPD_ACTIVE_JSON_PATH)
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const AGENT_ID = ${escapedAgentId}
const DEFAULT_ASP_HOME = ${escapedAspHome}
const ACTIVE_JSON = process.env.ASPD_ACTIVE_JSON || ${escapedActiveJson}
const TIMEOUT_MS = ${DISCOVERY_TIMEOUT_MS}

${HOOK_SHARED_PRELUDE}
function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function joinLogPath(threadId) {
  return join(codexHome(), 'hrc-desktop', String(threadId), 'join.log')
}

function logJoin(threadId, event, detail) {
  try {
    const path = joinLogPath(threadId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(
      path,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, hook: 'discovery', event, ...detail }) + '\\n'
    )
  } catch {}
}

function resolveBrokerBin() {
  let activation
  try {
    activation = JSON.parse(readFileSync(ACTIVE_JSON, 'utf8'))
  } catch {
    return { error: 'activation-unreadable' }
  }
  if (
    !activation ||
    typeof activation !== 'object' ||
    activation.schemaVersion !== 'aspd-service-activation/v1' ||
    typeof activation.releaseId !== 'string' ||
    typeof activation.releasePath !== 'string'
  ) {
    return { error: 'no-active-release' }
  }
  let release
  try {
    release = JSON.parse(readFileSync(join(activation.releasePath, 'release.json'), 'utf8'))
  } catch {
    return { error: 'release-unreadable' }
  }
  if (!release || release.releaseId !== activation.releaseId) {
    return {
      error: 'release-mismatch',
      expected: activation.releaseId,
      found: release && release.releaseId,
    }
  }
  return { bin: join(activation.releasePath, 'harness-broker') }
}

// Backstop only: the spawn below returns immediately, but a hook that never
// exits would sit in front of a turn. Unref'd so the fast path is unaffected.
const backstop = setTimeout(() => process.exit(0), TIMEOUT_MS)
backstop.unref()

const raw = await readStdin()
if (raw.trim().length === 0) process.exit(0)

let input
try {
  input = JSON.parse(raw)
} catch {
  process.exit(1)
}

const event = input.hook_event_name
if (event !== 'SessionStart' && event !== 'UserPromptSubmit') process.exit(0)
if (typeof input.session_id !== 'string' || input.session_id.length === 0) process.exit(0)

const threadId = input.session_id
const resolved = resolveBrokerBin()
if (resolved.error) {
  logJoin(threadId, resolved.error, { activeJson: ACTIVE_JSON })
  process.exit(0)
}

const args = ['desktop-join', '--thread', threadId]
if (typeof input.transcript_path === 'string' && input.transcript_path.length > 0) {
  args.push('--rollout', input.transcript_path)
}
if (typeof input.cwd === 'string' && input.cwd.length > 0) {
  args.push('--cwd', input.cwd)
}
const source =
  typeof input.source === 'string' && input.source.length > 0
    ? input.source
    : event === 'UserPromptSubmit'
      ? 'user-prompt-submit'
      : 'startup'
args.push('--source', source)

// The joiner's stdout/stderr go to an append-only file in the thread dir, never
// /dev/null: a joiner that dies before it can write join.log (an uncaught throw,
// a runtime crash) still leaves its last words on disk (T-09977).
let output = 'ignore'
try {
  const stderrPath = join(dirname(joinLogPath(threadId)), 'joiner.stderr.log')
  mkdirSync(dirname(stderrPath), { recursive: true, mode: 0o700 })
  output = openSync(stderrPath, 'a', 0o600)
} catch {}

// The 4 s timer covers only this spawn call: detached + unref'd, the broker
// outlives the hook and the hook exits 0 the moment the spawn returns.
try {
  const child = spawn(resolved.bin, args, {
    detached: true,
    stdio: ['ignore', output, output],
    env: { ...process.env, CODEX_HOME: codexHome() },
  })
  child.unref()
} catch (error) {
  logJoin(threadId, 'spawn-failed', { message: error instanceof Error ? error.message : String(error) })
}
if (typeof output === 'number') {
  try {
    closeSync(output)
  } catch {}
}
clearTimeout(backstop)
process.exit(0)
`
}
