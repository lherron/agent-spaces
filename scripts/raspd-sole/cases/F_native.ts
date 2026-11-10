/**
 * Cases T-13048 adds for rows made native in slice 2 that T-13008 left
 * without a case for one of their parts: a SOUL.md and a compile-side
 * asp-targets.toml with non-UTF-8 bytes, and the harness version probe dying
 * by a signal or failing to spawn (the rig's claude stand-in, swapped for the
 * case and restored after it).
 */
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Ctx, ProbeCase } from '../ctx.ts'

const PROFILE = 'version = 4\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
const LATIN1 = (text: string) =>
  Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${text}`)])

function inspectFor(c: Ctx, agent: string) {
  const p = c.base('inspect:claude:preview')
  const old = p.context.agentId
  p.context.agentId = agent
  p.context.agentRoot = join(c.stage.agentsRoot, agent)
  const swap = (s: string) => s.split(`agent:${old}:`).join(`agent:${agent}:`)
  const sr = p.preparationCorrelation?.sessionRef
  if (sr?.scopeRef) sr.scopeRef = swap(sr.scopeRef)
  if (p.dispatchEnv)
    for (const k of Object.keys(p.dispatchEnv))
      if (typeof p.dispatchEnv[k] === 'string') p.dispatchEnv[k] = swap(p.dispatchEnv[k])
  return p
}

function soulLatin1(c: Ctx) {
  const root = c.agent('p-su-latin1', PROFILE)
  writeFileSync(join(root, 'SOUL.md'), LATIN1('# p-su-latin1\n\nProbe agent.\n'))
}

/** The rig's claude stand-in (rig.ts stubs), swapped for one probe case. */
const stub = (c: Ctx) => join(c.stage.base, '..', 'bin', 'claude')
function probeCase(id: string, reason: string, condition: string, swap: (path: string) => void) {
  return {
    reason,
    id,
    method: 'aspc.observeRuntimeCapability',
    condition,
    setup: (c: Ctx) => {
      mkdirSync(c.dir, { recursive: true })
      copyFileSync(stub(c), join(c.dir, 'claude.orig'))
      rmSync(stub(c), { force: true })
      swap(stub(c))
    },
    teardown: (c: Ctx) => {
      rmSync(stub(c), { force: true })
      copyFileSync(join(c.dir, 'claude.orig'), stub(c))
      chmodSync(stub(c), 0o755)
    },
    params: (c: Ctx) => c.base('capability:claude'),
  } satisfies ProbeCase
}

const cases: ProbeCase[] = [
  {
    reason: 'soul_unreadable',
    id: 'soul_unreadable--latin1',
    method: 'aspc.compileHarnessInvocation',
    condition: 'SOUL.md contains a non-UTF-8 byte (Latin-1 0xE9); compile',
    setup: soulLatin1,
    params: (c) => c.compileFor('p-su-latin1'),
  },
  {
    reason: 'soul_unreadable',
    id: 'soul_unreadable--latin1-inspect',
    method: 'aspc.inspectRuntimePlacement',
    condition: 'SOUL.md contains a non-UTF-8 byte (Latin-1 0xE9); inspect',
    setup: soulLatin1,
    params: (c) => inspectFor(c, 'p-su-latin1'),
  },
  {
    reason: 'targets_unreadable',
    id: 'targets_unreadable--compile-latin1',
    method: 'aspc.compileHarnessInvocation',
    condition: 'the project asp-targets.toml contains a non-UTF-8 byte (Latin-1 0xE9); compile',
    setup: (c) => {
      writeFileSync(
        join(c.stage.projectRoot, 'asp-targets.toml'),
        LATIN1('schema = 2\n\n[targets.pathmark-dev]\ncompose = ["space:pm-dev@dev"]\n')
      )
    },
    params: (c) => c.compileFor('pathmark-dev'),
  },
  probeCase(
    'capability_probe_signaled--sigkill',
    'capability_probe_signaled',
    'claude --version dies by SIGKILL',
    (path) => writeFileSync(path, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 })
  ),
  probeCase(
    'capability_probe_signaled--sigterm-stderr',
    'capability_probe_signaled',
    'claude --version writes stderr, then dies by SIGTERM',
    (path) => writeFileSync(path, '#!/bin/sh\necho dying >&2\nkill -TERM $$\n', { mode: 0o755 })
  ),
  probeCase(
    'capability_probe_spawn_failed--eacces',
    'capability_probe_spawn_failed',
    'the claude override is not executable (EACCES)',
    (path) => writeFileSync(path, 'echo 2.1.0\n', { mode: 0o644 })
  ),
  probeCase(
    'capability_probe_spawn_failed--enoexec',
    'capability_probe_spawn_failed',
    'the claude override is executable but no known format (ENOEXEC)',
    (path) => writeFileSync(path, Buffer.from([0x67, 0x00, 0x01, 0x02]), { mode: 0o755 })
  ),
  probeCase(
    'capability_probe_spawn_failed--enoent',
    'capability_probe_spawn_failed',
    'the claude override names no file (ENOENT)',
    () => {}
  ),
]

export default cases
