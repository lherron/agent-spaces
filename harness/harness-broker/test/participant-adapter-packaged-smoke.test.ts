import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brokerProcessEnv } from './helpers'

/**
 * T-08350 compiled adapter -> compiled broker smoke.
 *
 * The client is Node, not Bun, so its named `agent-spaces/testing` import takes
 * the package's `import` export (`dist/testing/...js`). The broker runner also
 * imports the compiled dist entry directly and adds only the shipped no-op
 * driver. The client hands the exact prepared profile through install, ensure,
 * and attach; it never changes profile, process, driver, or correlation fields.
 */

const repoRoot = new URL('../../..', import.meta.url).pathname
const brokerDist = join(repoRoot, 'harness/harness-broker/dist/index.js')
const spawned: Array<{ dir: string; process: ReturnType<typeof Bun.spawn> }> = []

afterEach(async () => {
  const running = spawned.splice(0)
  await Promise.all(
    running.map(async (entry) => {
      if (entry.process.exitCode === null) entry.process.kill('SIGTERM')
      await entry.process.exited.catch(() => {})
      await rm(entry.dir, { recursive: true, force: true })
    })
  )
})

async function startCompiledNoopBroker(): Promise<{ socketPath: string; dir: string }> {
  const dir = join('/tmp', `t08350-packaged-${crypto.randomUUID().slice(0, 8)}`)
  const socketPath = join(dir, 'broker.sock')
  await mkdir(dir, { recursive: true })
  const runnerPath = join(dir, 'compiled-noop-broker.mjs')
  await writeFile(
    runnerPath,
    [
      `import { createNoopDriver, runBrokerCli } from ${JSON.stringify(brokerDist)};`,
      'await runBrokerCli({ additionalDrivers: [() => createNoopDriver()] });',
      '',
    ].join('\n')
  )
  const process_ = Bun.spawn({
    cmd: [
      'bun',
      runnerPath,
      'run',
      '--transport',
      'unix',
      '--socket',
      socketPath,
      '--event-ledger',
      join(dir, 'events.ndjson'),
      '--join',
      'participant-served',
    ],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: brokerProcessEnv(),
  })
  spawned.push({ dir, process: process_ })

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (process_.exitCode !== null) {
      throw new Error(
        `compiled broker exited before bind: ${(await new Response(process_.stderr).text()).trim()}`
      )
    }
    try {
      if ((await stat(socketPath)).isSocket()) return { socketPath, dir }
    } catch {
      // The unix socket is not bound yet.
    }
    await Bun.sleep(25)
  }
  throw new Error('compiled no-op broker did not bind its unix socket')
}

function clientSource(): string {
  return `
import { connect } from 'node:net'
import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import { validateParticipantAdapterPreparation } from 'spaces-runtime-contracts'

const socketPath = process.argv.at(-1)
const identity = {
  runtimeId: 'runtime_t08350_packaged',
  hostSessionId: 'host_session_t08350_packaged',
  generation: 4,
  invocationId: 'inv_t08350_packaged',
  requestId: 'request_t08350_packaged',
  operationId: 'operation_t08350_packaged',
}

const adapter = createControlledParticipantAdapter({
  workspaceCwd: process.cwd(),
  driver: 'noop-driver',
  dispatchEnv: { CONTROLLED_PACKAGED_SMOKE: '1' },
})
const admitted = await adapter.admit({
  classId: 'controlled-packaged',
  join: 'participant-served',
  evidence: { kind: 'controlled-continuity/v1', token: 'same' },
})
if (admitted.status !== 'admitted') throw new Error('adapter did not admit')
const preparationRequest = {
  classId: 'controlled-packaged',
  join: 'participant-served',
  participantKey: admitted.participantKey,
  workspaceCwd: admitted.workspaceCwd,
  preparation: admitted.preparation,
  identity,
  scopeRef: 't08350@agent-spaces:packaged',
  laneRef: 'main',
  attachEpoch: 7,
}
const prepared = await adapter.prepare(preparationRequest)
const validation = validateParticipantAdapterPreparation(preparationRequest, prepared)
if (!validation.ok) throw new Error(JSON.stringify(validation.issues))
if (prepared.status !== 'prepared') throw new Error('adapter did not prepare')
const profile = prepared.profile
const rpc = await new Promise((resolve, reject) => {
  const socket = connect({ path: socketPath })
  socket.once('error', reject)
  socket.once('connect', () => {
    socket.removeListener('error', reject)
    let next = 0
    let buffer = ''
    const pending = new Map()
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line) {
          const frame = JSON.parse(line)
          if (frame.id !== undefined && pending.has(frame.id)) {
            const done = pending.get(frame.id)
            pending.delete(frame.id)
            if (frame.error) done.reject(new Error(JSON.stringify(frame.error)))
            else done.resolve(frame.result)
          }
        }
        newline = buffer.indexOf('\\n')
      }
    })
    resolve({
      request(method, params) {
        const id = 't08350-' + ++next
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
        })
      },
      close() { socket.end() },
    })
  })
})
const installedIdentity = {
  runtimeId: identity.runtimeId,
  hostSessionId: identity.hostSessionId,
  generation: identity.generation,
  attachEpoch: preparationRequest.attachEpoch,
  invocationId: identity.invocationId,
  startRequestHash: profile.harnessInvocation.startRequestHash,
  selectedProfileHash: profile.profileHash,
  attachToken: 'attach_t08350_packaged',
}
const installed = await rpc.request('broker.installIdentity', installedIdentity)
const ensured = await rpc.request('broker.ensureInvocation', {
  startAttemptId: 'attempt_t08350_packaged',
  invocationId: identity.invocationId,
  attachEpoch: preparationRequest.attachEpoch,
  startRequest: profile.harnessInvocation.startRequest,
  dispatchEnv: prepared.dispatchEnv,
})
const attached = await rpc.request('broker.attach', {
  ...installedIdentity,
  controllerInstanceId: 'controller_t08350_packaged',
})
rpc.close()
process.stdout.write(JSON.stringify({
  adapterModule: import.meta.resolve('agent-spaces/testing'),
  ownership: profile.brokerOwnership,
  continuityEvidence: admitted.continuityEvidence,
  correlation: profile.harnessInvocation.startRequest.spec.correlation,
  installed,
  ensured,
  attached,
}) + '\\n')
`
}

async function installCompiledPackage(
  installRoot: string,
  name: string,
  sourceDir: string
): Promise<void> {
  const target = join(installRoot, 'node_modules', name)
  await mkdir(target, { recursive: true })
  const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, Record<string, string>>
  }
  for (const entry of Object.values(manifest.exports ?? {})) entry['bun'] = undefined
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await symlink(join(sourceDir, 'dist'), join(target, 'dist'), 'dir')
}

describe('T-08350 packaged participant adapter roundtrip', () => {
  test('uses the unchanged built adapter profile to install, start, and attach', async () => {
    const { socketPath, dir } = await startCompiledNoopBroker()
    const installedRoot = join(dir, 'installed')
    // Model the package installed from its prepacked artifact: no `bun` source
    // condition is present, so the named import below must select `dist`.
    await installCompiledPackage(
      installedRoot,
      'agent-spaces',
      join(repoRoot, 'compiler/agent-spaces')
    )
    await installCompiledPackage(
      installedRoot,
      'spaces-runtime-contracts',
      join(repoRoot, 'contracts/spaces-runtime-contracts')
    )
    await installCompiledPackage(
      installedRoot,
      'spaces-harness-broker-protocol',
      join(repoRoot, 'contracts/harness-broker-protocol')
    )
    const client = Bun.spawn({
      cmd: ['bun', '--eval', clientSource(), socketPath],
      cwd: installedRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await client.exited
    const stdout = (await new Response(client.stdout).text()).trim()
    const stderr = (await new Response(client.stderr).text()).trim()
    const artifactPath = process.env['T08350_ROUNDTRIP_ARTIFACT']
    if (artifactPath !== undefined) await writeFile(artifactPath, `${stdout}\n`)
    expect(client.exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout) as {
      adapterModule: string
      ownership: string
      continuityEvidence: unknown
      correlation: Record<string, string>
      installed: { installed: boolean }
      ensured: { receipt: { state: string } }
      attached: { attached: boolean }
    }
    // Bun realpaths the installed dist symlink, so this still reports the
    // producer's compiled artifact rather than its source export.
    expect(result.adapterModule).toMatch(/agent-spaces\/dist\/testing\/pre-hrc-broker-helpers\.js$/)
    expect(result.ownership).toBe('participant-owned-process')
    expect(result.continuityEvidence).toEqual({ kind: 'controlled-continuity/v1', token: 'same' })
    expect(result.correlation).toMatchObject({
      runtimeId: 'runtime_t08350_packaged',
      hostSessionId: 'host_session_t08350_packaged',
    })
    expect(result.correlation.startRequestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.correlation.selectedProfileHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.installed).toMatchObject({ installed: true })
    expect(result.ensured.receipt).toMatchObject({ state: 'started' })
    expect(result.attached).toMatchObject({ attached: true })
  }, 30_000)
})
