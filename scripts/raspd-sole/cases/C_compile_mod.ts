import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'

/** Make a path removable (undo earlier chmods), then remove it. */
function wipe(path: string) {
  if (!existsSync(path)) return
  spawnSyncChmod(path)
  rmSync(path, { recursive: true, force: true })
}
function spawnSyncChmod(path: string) {
  Bun.spawnSync(['chmod', '-R', 'u+rwx', path])
}

/** A fresh per-case ASP_HOME under c.dir with ensureAspHome's directories. */
function freshAspHome(c: Ctx): string {
  const home = join(c.dir, 'asp-home')
  wipe(home)
  for (const d of ['repo', 'sources', 'snapshots', 'cache', 'projects', 'tmp'])
    mkdirSync(join(home, d), { recursive: true })
  return home
}

/** A fresh project dir under c.dir with an asp-targets.toml. */
function project(c: Ctx, name: string, targets: string): string {
  const root = join(c.dir, name)
  wipe(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'asp-targets.toml'), targets)
  return root
}

/** Point a compile request at another project root (placement + bundle + cwd). */
function atProject(p: any, root: string) {
  const pl = p.compileRequest.placement
  pl.projectRoot = root
  pl.cwd = root
  if (pl.bundle) pl.bundle.projectRoot = root
  return p
}

const PROFILE = 'version = 4\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
const CODEX_PROFILE = 'version = 4\n\n[spaces]\nbase = ["space:pm-dev@dev","space:pm-codex@dev"]\n'
const CODEX = 'compile:codex-app-server'

/** A registry (pinned) lock entry for a space whose snapshot is absent. */
const GHOST_INTEGRITY = `sha256:${'ab'.repeat(32)}`
function ghostLock() {
  return {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: '2026-11-10T00:00:00.000Z',
    registry: { type: 'git', url: 'https://example.invalid/spaces-repo.git' },
    spaces: {
      'p-ghost@abc1234': {
        id: 'p-ghost',
        commit: 'abc1234abc1234abc1234abc1234abc1234abc12',
        path: 'spaces/p-ghost',
        integrity: GHOST_INTEGRITY,
        plugin: { name: 'p-ghost', version: '1.0.0' },
        deps: { spaces: [] },
        resolvedFrom: { selector: 'stable' },
      },
    },
    targets: {
      'p-ghost-other': {
        compose: ['space:p-ghost@stable'],
        roots: ['p-ghost@abc1234'],
        loadOrder: ['p-ghost@abc1234'],
        envHash: `sha256:${'cd'.repeat(32)}`,
      },
    },
  }
}

/** The lock-file lock directory raspd and Bun take for <aspHome>/global-lock.json. */
function lockFileLockDir(aspHome: string): string {
  const key = `lock-file-${createHash('sha256').update(join(aspHome, 'global-lock.json')).digest('hex').slice(0, 32)}`
  const file = join(aspHome, 'tmp', 'locks', `${key}.lock`)
  mkdirSync(join(aspHome, 'tmp', 'locks'), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, '')
  return `${realpathSync(file)}.lock`
}

/** inspect:claude:preview retargeted at `agent`. */
function inspectFor(c: Ctx, agent: string) {
  const p = c.base('inspect:claude:preview')
  p.context.agentId = agent
  p.context.agentRoot = join(c.stage.agentsRoot, agent)
  const sr = p.preparationCorrelation.sessionRef
  sr.scopeRef = sr.scopeRef.replace('agent:pathmark-dev:', `agent:${agent}:`)
  p.dispatchEnv.AGENT_SCOPE_REF = sr.scopeRef
  return p
}
const INSPECT = 'aspc.inspectRuntimePlacement'

const cases: ProbeCase[] = [
  // ---- baseline: a per-case ASP_HOME compiles natively ----------------------
  {
    reason: 'native',
    id: 'C-baseline-asphome',
    method: 'aspc.compileHarnessInvocation',
    condition: 'claude compile of a fresh p- agent against a fresh per-case aspHome',
    setup: (c) => {
      c.agent('p-cbase', PROFILE)
    },
    params: (c) => ({ ...c.compileFor('p-cbase'), aspHome: freshAspHome(c) }),
  },

  // ---- placement / identity -------------------------------------------------
  {
    reason: 'agent_participant_only',
    method: 'aspc.compileHarnessInvocation',
    condition: 'agent profile [placement] launch = "participant-only"',
    setup: (c) => {
      c.agent(
        'p-apo',
        'version = 4\n\n[placement]\nlaunch = "participant-only"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
      )
    },
    params: (c) => c.compileFor('p-apo'),
  },
  {
    reason: 'agent_self_brokered',
    method: 'aspc.compileHarnessInvocation',
    condition: 'agent profile [placement] launch = "self-brokered"',
    setup: (c) => {
      c.agent(
        'p-asb',
        'version = 4\n\n[placement]\nlaunch = "self-brokered"\nlaunch_command = ["foundry", "seat-launch"]\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
      )
    },
    params: (c) => c.compileFor('p-asb'),
  },
  {
    reason: 'scope_ref_shorthand',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'placement.correlation.sessionRef.scopeRef is a shorthand handle (agent@project:task), not a canonical ScopeRef',
    setup: (c) => {
      c.agent('p-srs', PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-srs')
      p.compileRequest.placement.correlation.sessionRef.scopeRef = 'p-srs@project:T-11825'
      return p
    },
  },
  {
    reason: 'lane_ref_invalid',
    method: 'aspc.compileHarnessInvocation',
    condition: 'placement.correlation.sessionRef.laneRef names a lane id that is not a valid token',
    setup: (c) => {
      c.agent('p-lri', PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-lri')
      p.compileRequest.placement.correlation.sessionRef.laneRef = 'lane:Bad Lane!'
      return p
    },
  },
  {
    reason: 'placement_identity_fallback',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'no project id derivable: scopeRef has no project segment and placement.projectRoot is absent',
    setup: (c) => {
      c.agent('p-pif', PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-pif')
      const pl = p.compileRequest.placement
      pl.projectRoot = undefined
      pl.correlation.sessionRef.scopeRef = 'agent:p-pif'
      p.compileRequest.correlation.scopeRef = 'agent:p-pif'
      p.compileRequest.materialization.taskContext = undefined
      return p
    },
  },

  // ---- agent profile options / agent-local files ----------------------------
  {
    reason: 'priming_file_unreadable',
    method: 'aspc.compileHarnessInvocation',
    condition: 'profile priming_file names a file that does not exist under the agent root',
    setup: (c) => {
      c.agent(
        'p-pfu',
        'version = 4\npriming_file = "missing-priming.md"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
      )
    },
    params: (c) => c.compileFor('p-pfu'),
  },
  {
    reason: 'priming_conflict',
    method: 'aspc.compileHarnessInvocation',
    condition: 'the project target sets both priming and priming_append',
    setup: (c) => {
      c.agent('p-pc', PROFILE)
    },
    params: (c) =>
      atProject(
        c.compileFor('p-pc'),
        project(
          c,
          'p-pc-project',
          'schema = 2\n\n[targets.p-pc]\ncompose = ["space:pm-dev@dev"]\npriming = "a"\npriming_append = "b"\n'
        )
      ),
  },
  {
    reason: 'soul_unreadable',
    method: 'aspc.compileHarnessInvocation',
    condition: 'SOUL.md exists but cannot be read (here: SOUL.md is a directory)',
    setup: (c) => {
      const root = c.agent('p-su', PROFILE)
      rmSync(join(root, 'SOUL.md'), { recursive: true, force: true })
      mkdirSync(join(root, 'SOUL.md'))
    },
    params: (c) => c.compileFor('p-su'),
  },
  {
    reason: 'soul_unreadable',
    id: 'soul_unreadable--mode000',
    method: 'aspc.compileHarnessInvocation',
    condition: 'SOUL.md exists with mode 000',
    setup: (c) => {
      const root = join(c.stage.agentsRoot, 'p-su0')
      if (existsSync(join(root, 'SOUL.md'))) chmodSync(join(root, 'SOUL.md'), 0o644)
      c.agent('p-su0', PROFILE)
      chmodSync(join(root, 'SOUL.md'), 0o000)
    },
    params: (c) => c.compileFor('p-su0'),
  },
  {
    reason: 'agent_tools_invalid',
    id: 'agent_tools_invalid--reserved',
    method: 'aspc.compileHarnessInvocation',
    condition: 'tools/bin holds an executable with a reserved name (git)',
    setup: (c) => {
      const root = c.agent('p-ati-r', PROFILE, { 'tools/bin/git': '#!/bin/sh\necho hi\n' })
      chmodSync(join(root, 'tools/bin/git'), 0o755)
    },
    params: (c) => c.compileFor('p-ati-r'),
  },
  {
    reason: 'agent_tools_invalid',
    id: 'agent_tools_invalid--badname',
    method: 'aspc.compileHarnessInvocation',
    condition: 'tools/bin holds an executable whose name breaks the tool-name pattern (Upper_Case)',
    setup: (c) => {
      const root = c.agent('p-ati-n', PROFILE, { 'tools/bin/Upper_Case': '#!/bin/sh\necho hi\n' })
      chmodSync(join(root, 'tools/bin/Upper_Case'), 0o755)
    },
    params: (c) => c.compileFor('p-ati-n'),
  },
  {
    reason: 'agent_tools_invalid',
    id: 'agent_tools_invalid--notexec',
    method: 'aspc.compileHarnessInvocation',
    condition: 'tools/bin holds a regular file that is not executable',
    setup: (c) => {
      const root = c.agent('p-ati-x', PROFILE, { 'tools/bin/ptool': '#!/bin/sh\necho hi\n' })
      chmodSync(join(root, 'tools/bin/ptool'), 0o644)
    },
    params: (c) => c.compileFor('p-ati-x'),
  },
  {
    reason: 'agent_tools_invalid',
    id: 'agent_tools_invalid--escape',
    method: 'aspc.compileHarnessInvocation',
    condition: 'tools/bin holds a symlink resolving outside the agent tools dir',
    setup: (c) => {
      const root = c.agent('p-ati-e', PROFILE)
      const outside = join(c.dir, 'outside-tool')
      writeFileSync(outside, '#!/bin/sh\necho hi\n')
      chmodSync(outside, 0o755)
      mkdirSync(join(root, 'tools/bin'), { recursive: true })
      rmSync(join(root, 'tools/bin/ptool'), { force: true })
      symlinkSync(outside, join(root, 'tools/bin/ptool'))
    },
    params: (c) => c.compileFor('p-ati-e'),
  },
  {
    reason: 'agent_var_dirs',
    method: 'aspc.compileHarnessInvocation',
    condition: 'the agent root has a regular file named var, so var/state cannot be created',
    setup: (c) => {
      const root = c.agent('p-avd', PROFILE)
      rmSync(join(root, 'var'), { recursive: true, force: true })
      writeFileSync(join(root, 'var'), 'not a dir\n')
    },
    params: (c) => c.compileFor('p-avd'),
  },
  {
    reason: 'codex_option_shape',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex compile whose profile [provisioning.codex] model_reasoning_effort is a number',
    setup: (c) => {
      c.agent('p-cos', `${CODEX_PROFILE}\n[provisioning.codex]\nmodel_reasoning_effort = 3\n`)
    },
    params: (c) => c.compileFor('p-cos', CODEX),
  },
  {
    reason: 'codex_option_shape',
    id: 'codex_option_shape--target',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex compile whose project target [provisioning.codex] approval_policy is a boolean',
    setup: (c) => {
      c.agent('p-cost', CODEX_PROFILE)
    },
    params: (c) =>
      atProject(
        c.compileFor('p-cost', CODEX),
        project(
          c,
          'p-cost-project',
          'schema = 2\n\n[targets.p-cost]\ncompose = ["space:pm-dev@dev","space:pm-codex@dev"]\n\n[targets.p-cost.provisioning.codex]\napproval_policy = true\n'
        )
      ),
  },
  {
    reason: 'codex_model_unsupported',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex compile requesting a model outside the Codex adapter model list',
    setup: (c) => {
      c.agent('p-cmu', CODEX_PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-cmu', CODEX)
      p.compileRequest.requested.model = 'gpt-0-probe'
      return p
    },
  },
  {
    reason: 'permission_policy_shape',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex compile with hrcPolicy.permissionPolicy a record without a string mode',
    setup: (c) => {
      c.agent('p-pps', CODEX_PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-pps', CODEX)
      p.compileRequest.hrcPolicy.permissionPolicy = { audit: true }
      return p
    },
  },

  {
    reason: 'permission_policy_shape',
    id: 'permission_policy_shape--claude',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'claude compile with hrcPolicy.permissionPolicy a record without a string mode (raspd does not judge it on the claude path)',
    setup: (c) => {
      c.agent('p-ppsc', PROFILE)
    },
    params: (c) => {
      const p = c.compileFor('p-ppsc')
      p.compileRequest.hrcPolicy.permissionPolicy = { audit: true }
      return p
    },
  },

  // ---- the same agent-root conditions through inspectRuntimePlacement ------
  {
    reason: 'priming_file_unreadable',
    id: 'priming_file_unreadable--inspect',
    method: INSPECT,
    condition: 'inspect of an agent whose priming_file does not exist',
    params: (c) => inspectFor(c, 'p-pfu'),
  },
  {
    reason: 'agent_tools_invalid',
    id: 'agent_tools_invalid--inspect',
    method: INSPECT,
    condition: 'inspect of an agent whose tools/bin holds a reserved name (git)',
    params: (c) => inspectFor(c, 'p-ati-r'),
  },
  {
    reason: 'soul_unreadable',
    id: 'soul_unreadable--inspect',
    method: INSPECT,
    condition: 'inspect of an agent whose SOUL.md is a directory',
    // T-13048: its own agent, so the case runs on a fresh stage (it relied on soul_unreadable's).
    setup: (c) => {
      rmSync(join(c.stage.agentsRoot, 'p-su', 'SOUL.md'), { recursive: true, force: true })
      const root = c.agent('p-su', PROFILE)
      rmSync(join(root, 'SOUL.md'), { recursive: true, force: true })
      mkdirSync(join(root, 'SOUL.md'))
    },
    params: (c) => inspectFor(c, 'p-su'),
  },
  {
    reason: 'agent_var_dirs',
    id: 'agent_var_dirs--inspect',
    method: INSPECT,
    condition: 'inspect of an agent whose var is a regular file',
    params: (c) => inspectFor(c, 'p-avd'),
  },
  {
    reason: 'lane_ref_invalid',
    id: 'lane_ref_invalid--inspect',
    method: INSPECT,
    condition: 'inspect with preparationCorrelation.sessionRef.laneRef an invalid lane id',
    params: (c) => {
      const p = inspectFor(c, 'p-lri')
      p.preparationCorrelation.sessionRef.laneRef = 'lane:Bad Lane!'
      return p
    },
  },
  {
    reason: 'scope_ref_shorthand',
    id: 'scope_ref_shorthand--inspect',
    method: INSPECT,
    condition: 'inspect with preparationCorrelation.sessionRef.scopeRef a shorthand handle',
    params: (c) => {
      const p = inspectFor(c, 'p-srs')
      p.preparationCorrelation.sessionRef.scopeRef = 'p-srs@project:T-11951'
      return p
    },
  },

  // ---- ASP_HOME: default-targets.toml ---------------------------------------
  {
    reason: 'default_targets_invalid',
    method: 'aspc.compileHarnessInvocation',
    condition:
      '$aspHome/default-targets.toml parses but fails the targets semantic checks (priming + priming_append), with a project asp-targets.toml present',
    setup: (c) => {
      c.agent('p-dti', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(
        join(home, 'default-targets.toml'),
        'schema = 2\n\n[targets.p-dti-x]\npriming = "a"\npriming_append = "b"\n'
      )
      const p = atProject(
        c.compileFor('p-dti'),
        project(
          c,
          'p-dti-project',
          'schema = 2\n\n[targets.p-dti]\ncompose = ["space:pm-dev@dev"]\n'
        )
      )
      return { ...p, aspHome: home }
    },
  },
  {
    reason: 'default_targets_unreadable',
    method: 'aspc.compileHarnessInvocation',
    condition:
      '$aspHome/default-targets.toml exists with mode 000, with a project asp-targets.toml present',
    setup: (c) => {
      c.agent('p-dtu', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(join(home, 'default-targets.toml'), 'schema = 2\n')
      chmodSync(join(home, 'default-targets.toml'), 0o000)
      const p = atProject(
        c.compileFor('p-dtu'),
        project(
          c,
          'p-dtu-project',
          'schema = 2\n\n[targets.p-dtu]\ncompose = ["space:pm-dev@dev"]\n'
        )
      )
      return { ...p, aspHome: home }
    },
  },

  // ---- ASP_HOME: global-lock.json and snapshots -----------------------------
  {
    reason: 'global_lock_invalid',
    id: 'global_lock_invalid--json',
    method: 'aspc.compileHarnessInvocation',
    condition: '$aspHome/global-lock.json is not JSON',
    setup: (c) => {
      c.agent('p-gli', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(join(home, 'global-lock.json'), '{ not json\n')
      return { ...c.compileFor('p-gli'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_invalid',
    id: 'global_lock_invalid--shape',
    method: 'aspc.compileHarnessInvocation',
    condition: '$aspHome/global-lock.json is JSON whose spaces is an array',
    setup: (c) => {
      c.agent('p-glis', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(
        join(home, 'global-lock.json'),
        '{"lockfileVersion":1,"resolverVersion":1,"generatedAt":"x","registry":{"type":"git","url":"x"},"spaces":[],"targets":{}}\n'
      )
      return { ...c.compileFor('p-glis'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_invalid',
    id: 'global_lock_invalid--schema-only',
    method: 'aspc.compileHarnessInvocation',
    condition:
      '$aspHome/global-lock.json has object spaces/targets but fails Bun lock schema elsewhere (generatedAt not date-time, registry missing)',
    setup: (c) => {
      c.agent('p-glso', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(
        join(home, 'global-lock.json'),
        '{"lockfileVersion":1,"resolverVersion":1,"generatedAt":"not-a-date","spaces":{},"targets":{}}\n'
      )
      return { ...c.compileFor('p-glso'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_unreadable',
    method: 'aspc.compileHarnessInvocation',
    condition: '$aspHome/global-lock.json exists with mode 000',
    setup: (c) => {
      c.agent('p-glu', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(
        join(home, 'global-lock.json'),
        `${JSON.stringify({
          lockfileVersion: 1,
          resolverVersion: 1,
          generatedAt: 'x',
          registry: { type: 'git', url: 'x' },
          spaces: {},
          targets: {},
        })}\n`
      )
      chmodSync(join(home, 'global-lock.json'), 0o000)
      return { ...c.compileFor('p-glu'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_unreadable',
    id: 'global_lock_unreadable--dir',
    method: 'aspc.compileHarnessInvocation',
    condition: '$aspHome/global-lock.json is a directory',
    setup: (c) => {
      c.agent('p-glud', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      mkdirSync(join(home, 'global-lock.json'))
      return { ...c.compileFor('p-glud'), aspHome: home }
    },
  },
  {
    reason: 'snapshot_missing',
    method: 'aspc.compileHarnessInvocation',
    condition:
      '$aspHome/global-lock.json holds a registry (pinned) entry of another target whose snapshot dir is absent',
    setup: (c) => {
      c.agent('p-snm', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(join(home, 'global-lock.json'), `${JSON.stringify(ghostLock(), null, 2)}\n`)
      return { ...c.compileFor('p-snm'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_lock',
    id: 'global_lock_lock--io',
    method: 'aspc.compileHarnessInvocation',
    condition: '$aspHome/tmp/locks is a regular file, so the lock-file lock cannot be created',
    setup: (c) => {
      c.agent('p-gll', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      writeFileSync(join(home, 'tmp', 'locks'), 'not a dir\n')
      return { ...c.compileFor('p-gll'), aspHome: home }
    },
  },
  {
    reason: 'global_lock_lock',
    id: 'global_lock_lock--held',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'the global-lock.json lock-file lock is held (fresh mtime, kept fresh) for longer than the 600x100ms retry budget',
    setup: (c) => {
      c.agent('p-glh', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      const dir = lockFileLockDir(home)
      mkdirSync(dir, { recursive: true })
      // keep the lock fresh for ~200 s from a detached holder
      const holder = spawn(
        '/bin/sh',
        [
          '-c',
          `i=0; while [ ! -e "${c.done}" ] && [ $i -lt 200 ]; do touch "${dir}"; sleep 1; i=$((i+1)); done; rmdir "${dir}"`,
        ],
        { detached: true, stdio: 'ignore' }
      )
      holder.unref()
      writeFileSync(join(c.dir, 'holder.pid'), String(holder.pid))
      return { ...c.compileFor('p-glh'), aspHome: home }
    },
  },
  {
    reason: 'atomic_write',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'the per-case aspHome directory itself is read-only (its subdirs writable), so the global-lock.json temp file cannot be created',
    setup: (c) => {
      c.agent('p-aw', PROFILE)
    },
    params: (c) => {
      const home = freshAspHome(c)
      mkdirSync(join(home, 'tmp', 'locks'), { recursive: true })
      chmodSync(home, 0o555)
      return { ...c.compileFor('p-aw'), aspHome: home }
    },
  },
]
export default cases
