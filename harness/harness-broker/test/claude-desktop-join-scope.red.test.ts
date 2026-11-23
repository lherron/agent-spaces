import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClaudeDesktopJoinClient } from '../src/desktop-join-claude.js'
import { type JoinLifecycle, runDesktopJoin } from '../src/desktop-join.js'
import { type StubRequest, attached, registered, stubHrc } from './desktop-join-fixture.js'

const sessionId = '00000000-0000-4000-8000-000000000123'
const pid = 12345

test.each([
  { name: 'registered cwd', entrypoint: 'claude-desktop', matched: true, project: 'work' },
  { name: 'unregistered cwd', entrypoint: 'claude-desktop', matched: true, project: 'praesidium' },
  { name: 'CLI session', entrypoint: 'cli', matched: true, project: undefined },
  { name: 'different session', entrypoint: 'claude-desktop', matched: false, project: undefined },
  { name: 'missing row', entrypoint: undefined, matched: true, project: undefined },
])('Claude Desktop join for $name', async ({ entrypoint, matched, project }) => {
  const claudeHome = await mkdtemp('/tmp/claude-join-')
  const cwd = join(claudeHome, 'workspace')
  const requests: StubRequest[] = []
  const hrc = stubHrc((path, body) => {
    requests.push({ path, body })
    return path === '/v1/participants/register' ? registered(body.requestedSessionRef) : attached
  })
  const lifecycle: JoinLifecycle = { phase: 'starting' }
  try {
    await mkdir(cwd)
    await mkdir(join(claudeHome, 'sessions'))
    if (entrypoint !== undefined) {
      await writeFile(
        join(claudeHome, 'sessions', `${pid}.json`),
        JSON.stringify({ entrypoint, sessionId: matched ? sessionId : 'other', cwd })
      )
    }
    const client = createClaudeDesktopJoinClient({ claudeHome, sessionId, pid })
    const outcome = await runDesktopJoin(
      client,
      {
        hrcSocketPath: hrc.sock,
        registryProjects: [
          { projectId: 'work', root: project === 'work' ? cwd : join(claudeHome, 'elsewhere') },
        ],
      },
      {
        lifecycle,
        blockForever: (async () => {}) as never,
      }
    )

    const stateDir = join(claudeHome, 'hrc-desktop', sessionId)
    const log = await readFile(join(stateDir, 'join.log'), 'utf8')
    if (project === undefined) {
      expect(outcome.reason).toStartWith('not-admitted:')
      expect(log).toContain('"event":"not-admitted"')
      expect(lifecycle.phase).toBe('admitting')
      expect(requests).toHaveLength(0)
      return
    }
    const scopeRef = `agent:vega:project:${project}:task:claude-${sessionId}`
    expect(outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(log).toContain('"event":"joined"')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toMatchObject({
      classId: 'claude-desktop',
      requestedSessionRef: scopeRef,
      workspaceCwd: cwd,
      socketPath: join(stateDir, `broker-${process.pid}.sock`),
    })
    expect(requests[1]?.body.descriptor).toMatchObject({
      brokerDriver: 'claude-desktop',
      brokerOwnership: 'participant-owned-process',
    })
    const cacheFile = join(claudeHome, 'hrc-desktop-scopes', `${sessionId}.json`)
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({
      scopeRef,
      agentId: 'vega',
      projectId: project,
      sessionId,
    })
  } finally {
    lifecycle.release?.()
    await lifecycle.closeBroker?.()
    hrc.stop()
    await rm(claudeHome, { recursive: true, force: true })
  }
})
