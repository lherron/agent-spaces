import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'

const C = 'aspc.compileHarnessInvocation'
const I = 'aspc.inspectRuntimePlacement'
const R = 'aspc.resolveRuntimeDeclaration'
const O = 'aspc.observeContinuationArtifact'
const K = 'aspc.observeRuntimeCapability'

const HELLO = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'aspc.hello',
  params: { clientInfo: { name: 'hrc-server' }, protocolVersions: ['aspc/0.1'] },
})

const PROFILE = 'version = 4\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'

/** A compile for `agent` (default pathmark-dev) with an edit applied to the params. */
function compile(c: Ctx, edit: (p: any) => void, agent?: string, from?: string) {
  const p = agent ? c.compileFor(agent, from) : c.base(from ?? 'compile:claude-code:dev')
  edit(p)
  return p
}

/** Retarget a compile's project (placement.projectRoot / cwd / bundle.projectRoot). */
function project(p: any, root: string, which: 'both' | 'placement' | 'bundle' = 'both') {
  const pl = p.compileRequest.placement
  if (which !== 'bundle') {
    pl.projectRoot = root
    pl.cwd = root
  }
  if (which !== 'placement') pl.bundle.projectRoot = root
}

/** A resolve request for agent `agentId` with its context edited. */
function resolveReq(c: Ctx, edit: (ctx: any) => void, from = 'resolve:intent:project-root') {
  const p = c.base(from)
  edit(p.context)
  return p
}

/** An inspect request for agent `agentId` with its context edited. */
function inspectReq(c: Ctx, edit: (ctx: any, p: any) => void, from = 'inspect:claude:preview') {
  const p = c.base(from)
  edit(p.context, p)
  return p
}

/** Retarget an inspect/resolve context to `agent` (agentId + agentRoot + scope refs). */
function inspectFor(c: Ctx, agent: string, edit: (ctx: any, p: any) => void = () => {}) {
  return inspectReq(c, (ctx, p) => {
    ctx.agentId = agent
    ctx.agentRoot = join(c.stage.agentsRoot, agent)
    const swap = (s: string) => s.split('agent:pathmark-dev:').join(`agent:${agent}:`)
    const sr = p.preparationCorrelation?.sessionRef
    if (sr) sr.scopeRef = swap(sr.scopeRef)
    if (p.dispatchEnv?.AGENT_SCOPE_REF)
      p.dispatchEnv.AGENT_SCOPE_REF = swap(p.dispatchEnv.AGENT_SCOPE_REF)
    edit(ctx, p)
  })
}

/** A project dir under the case scratch dir with an asp-targets.toml (or none). */
function proj(c: Ctx, name: string, targets?: string): string {
  const root = join(c.dir, name)
  mkdirSync(root, { recursive: true })
  if (targets !== undefined) {
    const f = join(root, 'asp-targets.toml')
    try {
      chmodSync(f, 0o644)
    } catch {}
    c.write(f, targets)
  }
  return root
}

/** Bind a unix socket at `path` (open(2) on it fails EOPNOTSUPP on macOS). */
function socketFile(path: string) {
  if (existsSync(path)) rmSync(path, { force: true })
  const r = Bun.spawnSync([
    'python3',
    '-I',
    '-c',
    'import os,socket,sys; os.chdir(os.path.dirname(sys.argv[1])); s=socket.socket(socket.AF_UNIX); s.bind(os.path.basename(sys.argv[1]))',
    path,
  ])
  if (r.exitCode !== 0) throw new Error(`socket bind failed: ${r.stderr}`)
}

/** A minimal agent at an arbitrary root (outside the shared agentsRoot). */
function agentAt(c: Ctx, root: string, profile: string): string {
  try {
    chmodSync(join(root, 'agent-profile.toml'), 0o644)
  } catch {}
  c.write(join(root, 'agent-profile.toml'), profile)
  c.write(join(root, 'SOUL.md'), '# probe\n\nProbe agent.\n')
  c.write(
    join(root, 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: probe skill.\n---\n\nLoaded.\n'
  )
  return root
}

/**
 * A short path `<c.dir>/s1/<leaf>` to a directory whose real path is longer
 * than PATH_MAX: stat/access through the two symlinks succeed, realpath(3)
 * fails ENAMETOOLONG. `files` are written into the deep directory.
 */
function deepDir(c: Ctx, leaf: string, files: Record<string, string> = {}): string {
  const script = `
import os, sys, json
base, leaf, files = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
os.chdir(base)
seg = 'd' * 200
for name in ('s1',):
    if os.path.lexists(name): os.unlink(name)
os.makedirs('real', exist_ok=True); os.chdir('real')
for i in range(3):
    os.makedirs(seg + str(i), exist_ok=True); os.chdir(seg + str(i))
lvl3 = os.getcwd()
if os.path.lexists(leaf): os.unlink(leaf)
rel = os.path.join(seg + '3', seg + '4', seg + '5')
for i in range(3, 6):
    os.makedirs(seg + str(i), exist_ok=True); os.chdir(seg + str(i))
for name, text in files.items():
    d = os.path.dirname(name)
    if d: os.makedirs(d, exist_ok=True)
    with open(name, 'w') as f: f.write(text)
os.chdir(lvl3)
os.symlink(rel, leaf)
os.chdir(base)
os.symlink(lvl3, 's1')
`
  mkdirSync(c.dir, { recursive: true })
  const r = Bun.spawnSync(['python3', '-I', '-c', script, c.dir, leaf, JSON.stringify(files)])
  if (r.exitCode !== 0) throw new Error(`deepDir failed: ${r.stderr}`)
  return join(c.dir, 's1', leaf)
}

const AGENT_FILES = {
  'SOUL.md': '# probe\n\nProbe agent.\n',
  'skills/probe-skill/SKILL.md':
    '---\nname: probe-skill\ndescription: probe skill.\n---\n\nLoaded.\n',
}

const cases: ProbeCase[] = [
  // ---------------------------------------------------------------- invalid_params
  {
    reason: 'invalid_params',
    id: 'invalid_params--compile-unknown-key',
    method: C,
    condition: 'compile params carry a top-level key outside the aspc params schema',
    params: (c) => compile(c, (p) => (p.bogus = true)),
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--compile-schema-version',
    method: C,
    condition: 'compileRequest.schemaVersion is not agent-runtime-compile-request/v2',
    params: (c) =>
      compile(c, (p) => (p.compileRequest.schemaVersion = 'agent-runtime-compile-request/v1')),
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--compile-requested-effort',
    method: C,
    condition: 'compileRequest.requested.reasoningEffort is outside low|medium|high|xhigh',
    params: (c) => compile(c, (p) => (p.compileRequest.requested.reasoningEffort = 'max')),
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--inspect',
    method: I,
    condition: 'inspect params carry a stray top-level key',
    params: (c) => c.base('inspect:invalid-params'),
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--resolve',
    method: R,
    condition: 'resolve context.runMode is not query|heartbeat|task|maintenance',
    params: (c) => resolveReq(c, (ctx) => (ctx.runMode = 'bogus')),
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--observe',
    method: O,
    condition: 'observe continuation.provider is not a string',
    params: (c) => {
      const p = c.base('observe:claude:present:recorded')
      p.continuation.provider = 7
      return p
    },
  },
  {
    reason: 'invalid_params',
    id: 'invalid_params--capability',
    method: K,
    condition: 'capability harness is not a string',
    params: (c) => c.base('capability:invalid-params'),
  },

  // ---------------------------------------------------------------- empty_asp_home
  {
    reason: 'empty_asp_home',
    id: 'empty_asp_home--compile',
    method: C,
    condition: 'compile params aspHome is the empty string',
    params: (c) => compile(c, (p) => (p.aspHome = '')),
  },

  // ---------------------------------------------------------------- compile_context
  {
    reason: 'compile_context',
    method: C,
    condition: 'compile params carry compileContext (nowIso/idSalt)',
    params: (c) =>
      compile(
        c,
        (p) => (p.compileContext = { nowIso: '2026-01-01T00:00:00.000Z', idSalt: 'probe' })
      ),
  },

  // ---------------------------------------------------------------- placement_shape
  {
    reason: 'placement_shape',
    id: 'placement_shape--correlation-requestId',
    method: C,
    condition: 'placement.correlation carries requestId (the production detail)',
    params: (c) => compile(c, (p) => (p.compileRequest.placement.correlation.requestId = 'req-x')),
  },
  {
    reason: 'placement_shape',
    id: 'placement_shape--relative-agentRoot',
    method: C,
    condition: 'placement.agentRoot is not absolute',
    params: (c) =>
      compile(c, (p) => (p.compileRequest.placement.agentRoot = 'agents/pathmark-dev')),
  },
  {
    reason: 'placement_shape',
    id: 'placement_shape--no-bundle',
    method: C,
    condition: 'placement.bundle is missing',
    params: (c) => compile(c, (p) => delete p.compileRequest.placement.bundle),
  },

  // ---------------------------------------------------------------- materialization_shape
  {
    reason: 'materialization_shape',
    id: 'materialization_shape--attachments',
    method: C,
    condition: 'materialization.attachments is a non-empty array',
    params: (c) =>
      compile(
        c,
        (p) =>
          (p.compileRequest.materialization.attachments = [
            { kind: 'text', name: 'note.txt', content: 'hello' },
          ])
      ),
  },
  {
    reason: 'materialization_shape',
    id: 'materialization_shape--unknown-key',
    method: C,
    condition:
      'materialization carries a key outside initialPrompt|omitPriming|attachments|taskContext',
    params: (c) => compile(c, (p) => (p.compileRequest.materialization.extra = 'x')),
  },

  // ---------------------------------------------------------------- hrc_policy_shape
  {
    reason: 'hrc_policy_shape',
    id: 'hrc_policy_shape--unknown-key',
    method: C,
    condition: 'hrcPolicy carries a key outside the known policy keys',
    params: (c) => compile(c, (p) => (p.compileRequest.hrcPolicy.extra = 'x')),
  },
  {
    reason: 'hrc_policy_shape',
    id: 'hrc_policy_shape--timeout-string',
    method: C,
    condition: 'hrcPolicy.resourceLimits.startupTimeoutMs is not a number',
    params: (c) =>
      compile(c, (p) => (p.compileRequest.hrcPolicy.resourceLimits = { startupTimeoutMs: '5000' })),
  },

  // ---------------------------------------------------------------- continuation_shape
  {
    reason: 'continuation_shape',
    id: 'continuation_shape--no-hrc',
    method: C,
    condition: 'compileRequest.continuation has no hrc record',
    params: (c) =>
      compile(
        c,
        (p) => (p.compileRequest.continuation = { source: 'hrc' }),
        undefined,
        'compile:claude-code-resume:dev'
      ),
  },
  {
    reason: 'continuation_shape',
    id: 'continuation_shape--provider-number',
    method: C,
    condition: 'compileRequest.continuation.hrc.provider is not a string',
    params: (c) =>
      compile(
        c,
        (p) => (p.compileRequest.continuation.hrc.provider = 1),
        undefined,
        'compile:claude-code-resume:dev'
      ),
  },

  // ---------------------------------------------------------------- correlation_shape
  {
    reason: 'correlation_shape',
    method: C,
    condition: 'compileRequest.correlation.requestId is not a string',
    params: (c) => compile(c, (p) => (p.compileRequest.correlation.requestId = 42)),
  },

  // ---------------------------------------------------------------- agent_profile_invalid
  {
    reason: 'agent_profile_invalid',
    method: C,
    condition: 'agent-profile.toml parses but fails profile validation (unknown key)',
    setup: (c) => c.agent('p-api-agent', `${PROFILE}bogus = 1\n`),
    params: (c) => c.compileFor('p-api-agent'),
  },

  // ---------------------------------------------------------------- profile_toml_syntax
  {
    reason: 'profile_toml_syntax',
    id: 'profile_toml_syntax--compile',
    method: C,
    condition: 'agent-profile.toml is not valid TOML',
    setup: (c) => c.agent('p-pts-agent', 'version = [\n'),
    params: (c) => c.compileFor('p-pts-agent'),
  },
  {
    reason: 'profile_toml_syntax',
    id: 'profile_toml_syntax--resolve',
    method: R,
    condition: 'agent-profile.toml is not valid TOML',
    setup: (c) => c.agent('p-pts-agent', 'version = [\n'),
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'p-pts-agent'
        ctx.agentRoot = join(c.stage.agentsRoot, 'p-pts-agent')
      }),
  },
  {
    reason: 'profile_toml_syntax',
    id: 'profile_toml_syntax--inspect',
    method: I,
    condition: 'agent-profile.toml is not valid TOML',
    setup: (c) => c.agent('p-pts-agent', 'version = [\n'),
    params: (c) => inspectFor(c, 'p-pts-agent'),
  },

  // ---------------------------------------------------------------- source_read_unavailable
  {
    reason: 'source_read_unavailable',
    id: 'source_read_unavailable--profile',
    method: C,
    condition: 'agent-profile.toml exists but cannot be read (mode 000)',
    setup: (c) => {
      const root = agentAt(c, join(c.dir, 'p-sru-agent'), PROFILE)
      chmodSync(join(root, 'agent-profile.toml'), 0o000)
    },
    params: (c) => {
      const p = c.compileFor('p-sru-agent')
      p.compileRequest.placement.agentRoot = join(c.dir, 'p-sru-agent')
      return p
    },
  },
  {
    reason: 'source_read_unavailable',
    id: 'source_read_unavailable--bundle-targets',
    method: C,
    condition: "bundle.projectRoot's asp-targets.toml exists but cannot be read (mode 000)",
    params: (c) => {
      const root = proj(c, 'p-sru-proj', 'schema = 2\n')
      chmodSync(join(root, 'asp-targets.toml'), 0o000)
      return compile(c, (p) => project(p, root))
    },
  },
  {
    reason: 'source_read_unavailable',
    id: 'source_read_unavailable--placement-targets',
    method: C,
    condition:
      "placement.projectRoot's asp-targets.toml cannot be read (mode 000) while bundle.projectRoot's is readable",
    params: (c) => {
      const root = proj(c, 'p-sru-proj2', 'schema = 2\n')
      chmodSync(join(root, 'asp-targets.toml'), 0o000)
      return compile(c, (p) => project(p, root, 'placement'))
    },
  },

  // ---------------------------------------------------------------- project_targets_invalid
  {
    reason: 'project_targets_invalid',
    id: 'project_targets_invalid--bundle',
    method: C,
    condition:
      "bundle.projectRoot's asp-targets.toml passes the schema but fails a semantic check (priming and priming_append)",
    params: (c) => {
      const root = proj(
        c,
        'p-pti-proj',
        'schema = 2\n\n[targets.pathmark-dev]\npriming = "a"\npriming_append = "b"\n'
      )
      return compile(c, (p) => project(p, root))
    },
  },
  {
    reason: 'project_targets_invalid',
    id: 'project_targets_invalid--placement',
    method: C,
    condition:
      "only placement.projectRoot's asp-targets.toml fails a semantic check (priming and priming_append)",
    params: (c) => {
      const root = proj(
        c,
        'p-pti-proj2',
        'schema = 2\n\n[targets.pathmark-dev]\npriming = "a"\npriming_append = "b"\n'
      )
      return compile(c, (p) => project(p, root, 'placement'))
    },
  },

  // ---------------------------------------------------------------- configured_context_mismatch
  {
    reason: 'configured_context_mismatch',
    id: 'configured_context_mismatch--task',
    method: C,
    condition: 'materialization.taskContext.taskId differs from the sessionRef scope task',
    params: (c) =>
      compile(c, (p) => (p.compileRequest.materialization.taskContext.taskId = 'T-99999')),
  },
  {
    reason: 'configured_context_mismatch',
    id: 'configured_context_mismatch--agent-root',
    method: C,
    condition: "placement.agentRoot's basename differs from agent.id",
    params: (c) =>
      compile(
        c,
        (p) => (p.compileRequest.placement.agentRoot = join(c.stage.agentsRoot, 'pathmark'))
      ),
  },

  // ---------------------------------------------------------------- recipe_not_native
  {
    reason: 'recipe_not_native',
    id: 'recipe_not_native--agent-harness',
    method: C,
    condition: 'selected harness is agent-harness',
    params: (c) => c.base('compile:agent-harness-headless'),
  },
  {
    reason: 'recipe_not_native',
    id: 'recipe_not_native--muse',
    method: C,
    condition: 'selected harness is muse',
    params: (c) => c.base('compile:muse-serve'),
  },

  // ---------------------------------------------------------------- unsupported_model_provider / model
  {
    reason: 'unsupported_model_provider',
    method: C,
    condition: 'requested.modelProvider is not the harness default provider (claude + openai)',
    params: (c) => compile(c, (p) => (p.compileRequest.requested.modelProvider = 'openai')),
  },
  {
    reason: 'unsupported_model',
    method: C,
    condition: "requested.model is outside the harness catalog's models (claude + gpt-5.5)",
    params: (c) => compile(c, (p) => (p.compileRequest.requested.model = 'gpt-5.5')),
  },
  {
    reason: 'unsupported_model',
    id: 'unsupported_model--unknown',
    method: C,
    condition: "requested.model is not in any catalog (claude + 'claude-opus-4-1')",
    params: (c) => compile(c, (p) => (p.compileRequest.requested.model = 'claude-opus-4-1')),
  },

  // ---------------------------------------------------------------- front door
  {
    reason: '(unjudged_frame)',
    id: 'unjudged_frame--garbage',
    method: 'unparsed',
    condition: 'a frame that is not JSON at all',
    params: () => null,
    rawFrames: () => [HELLO, '{not json'],
  },
  {
    reason: '(unjudged_frame)',
    id: 'unjudged_frame--lone-surrogate-hello',
    method: 'unparsed',
    condition: 'a valid JSON-RPC aspc.hello whose params carry a lone UTF-16 surrogate escape',
    params: () => null,
    rawFrames: () => [
      HELLO,
      '{"jsonrpc":"2.0","id":2,"method":"aspc.hello","params":{"clientInfo":{"name":"x\\ud800"},"protocolVersions":["aspc/0.1"]}}',
    ],
  },
  {
    reason: '(unjudged_frame)',
    id: 'unjudged_frame--huge-number-hello',
    method: 'unparsed',
    condition: 'a valid JSON-RPC aspc.hello whose params carry a number beyond f64 (1e400)',
    params: () => null,
    rawFrames: () => [
      HELLO,
      '{"jsonrpc":"2.0","id":2,"method":"aspc.hello","params":{"clientInfo":{"name":"x"},"protocolVersions":["aspc/0.1"],"n":1e400}}',
    ],
  },
  {
    reason: '(unjudged_frame)',
    id: 'unjudged_frame--lone-surrogate-compile',
    method: 'unparsed',
    condition: 'a native-shaped claude compile whose initialPrompt carries a lone surrogate escape',
    params: () => null,
    rawFrames: (c) => {
      const p = c.base('compile:claude-code:dev')
      p.compileRequest.materialization.initialPrompt = 'SURROGATE'
      const f = JSON.stringify({ jsonrpc: '2.0', id: 2, method: C, params: p }).replace(
        'SURROGATE',
        'probe \\ud83d prompt'
      )
      return [HELLO, f]
    },
  },
  {
    reason: '(non_native_method)',
    id: 'non_native_method--unknown',
    method: 'aspc.noSuchMethod',
    condition: 'a method neither raspd nor Bun implements',
    params: () => ({}),
  },
  {
    reason: '(non_native_method)',
    id: 'non_native_method--bare-aspc',
    method: 'aspc.',
    condition: 'the method `aspc.` (production: client avs/1)',
    params: () => ({}),
  },

  // ---------------------------------------------------------------- agent_id_unported
  {
    reason: 'agent_id_unported',
    id: 'agent_id_unported--resolve-empty',
    method: R,
    condition: 'resolve context.agentId is the empty string',
    params: (c) => resolveReq(c, (ctx) => (ctx.agentId = '')),
  },
  {
    reason: 'agent_id_unported',
    id: 'agent_id_unported--resolve-proto',
    method: R,
    condition:
      'resolve context.agentId names an Object.prototype member (constructor), no agentRoot',
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'constructor'
        delete ctx.agentRoot
      }),
  },
  {
    reason: 'agent_id_unported',
    id: 'agent_id_unported--inspect-empty',
    method: I,
    condition: 'inspect context.agentId is the empty string',
    params: (c) => inspectReq(c, (ctx) => (ctx.agentId = '')),
  },

  // ---------------------------------------------------------------- config_toml_syntax
  {
    reason: 'config_toml_syntax',
    id: 'config_toml_syntax--resolve',
    method: R,
    condition: "agentSources.aspHome's config.toml is not valid TOML",
    params: (c) => {
      const home = join(c.dir, 'asp-home')
      c.write(join(home, 'config.toml'), 'agents-root = [\n')
      return resolveReq(c, (ctx) => (ctx.agentSources = { aspHome: home }))
    },
  },
  {
    reason: 'config_toml_syntax',
    id: 'config_toml_syntax--inspect',
    method: I,
    condition: "agentSources.aspHome's config.toml is not valid TOML",
    params: (c) => {
      const home = join(c.dir, 'asp-home')
      c.write(join(home, 'config.toml'), 'agents-root = [\n')
      return inspectReq(c, (ctx) => (ctx.agentSources = { aspHome: home }))
    },
  },

  // ---------------------------------------------------------------- empty_path
  {
    reason: 'empty_path',
    id: 'empty_path--resolve-asphome',
    method: R,
    condition: 'resolve context.agentSources.aspHome is the empty string',
    params: (c) => resolveReq(c, (ctx) => (ctx.agentSources = { aspHome: '' })),
  },
  {
    reason: 'empty_path',
    id: 'empty_path--resolve-projectroot',
    method: R,
    condition: "resolve context.project is mode root with projectRoot ''",
    params: (c) => resolveReq(c, (ctx) => (ctx.project.projectRoot = '')),
  },
  {
    reason: 'empty_path',
    id: 'empty_path--inspect-asphome',
    method: I,
    condition: 'inspect context.agentSources.aspHome is the empty string',
    params: (c) => inspectReq(c, (ctx) => (ctx.agentSources = { aspHome: '' })),
  },

  // ---------------------------------------------------------------- fs_errno_unported
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--stat-enametoolong',
    method: R,
    condition:
      'resolve context.agentRoot has a path component over NAME_MAX (stat fails ENAMETOOLONG)',
    params: (c) => resolveReq(c, (ctx) => (ctx.agentRoot = join(c.dir, 'x'.repeat(300)))),
  },
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--stat-eloop',
    method: R,
    condition: 'resolve context.agentRoot is a symlink loop (stat fails ELOOP)',
    params: (c) => {
      const a = join(c.dir, 'loop-a')
      const b = join(c.dir, 'loop-b')
      rmSync(a, { force: true })
      rmSync(b, { force: true })
      symlinkSync(b, a)
      symlinkSync(a, b)
      return resolveReq(c, (ctx) => (ctx.agentRoot = a))
    },
  },
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--search-targets-socket',
    method: R,
    condition:
      "no agentRoot supplied; the project root's asp-targets.toml is a unix socket (open fails EOPNOTSUPP)",
    params: (c) => {
      const root = proj(c, 'p-feu-proj')
      socketFile(join(root, 'asp-targets.toml'))
      return resolveReq(c, (ctx) => {
        delete ctx.agentRoot
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--read-source-socket',
    method: R,
    condition:
      "agentRoot supplied; the agent's agent-profile.toml is a unix socket (open fails EOPNOTSUPP)",
    setup: (c) => {
      const root = join(c.dir, 'p-feu-agent')
      mkdirSync(root, { recursive: true })
      socketFile(join(root, 'agent-profile.toml'))
    },
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'p-feu-agent'
        ctx.agentRoot = join(c.dir, 'p-feu-agent')
      }),
  },
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--priming-socket',
    method: R,
    condition: "the profile's priming_file is a unix socket (open fails EOPNOTSUPP)",
    setup: (c) => {
      const root = agentAt(
        c,
        join(c.dir, 'p-feu-prim-agent'),
        'version = 4\npriming_file = "PRIMING.md"\n'
      )
      socketFile(join(root, 'PRIMING.md'))
    },
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'p-feu-prim-agent'
        ctx.agentRoot = join(c.dir, 'p-feu-prim-agent')
      }),
  },
  {
    reason: 'fs_errno_unported',
    id: 'fs_errno_unported--inspect-enametoolong',
    method: I,
    condition:
      'inspect context.agentRoot has a path component over NAME_MAX (stat fails ENAMETOOLONG)',
    params: (c) => inspectReq(c, (ctx) => (ctx.agentRoot = join(c.dir, 'x'.repeat(300)))),
  },

  // ---------------------------------------------------------------- profile_avatar_url
  {
    reason: 'profile_avatar_url',
    id: 'profile_avatar_url--resolve',
    method: R,
    condition: 'identity.avatar is an https URL raspd cannot judge (upper-case scheme)',
    setup: (c) =>
      c.agent('p-pau-agent', `${PROFILE}\n[identity]\navatar = "HTTPS://example.com/a.png"\n`),
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'p-pau-agent'
        ctx.agentRoot = join(c.stage.agentsRoot, 'p-pau-agent')
      }),
  },
  {
    reason: 'profile_avatar_url',
    id: 'profile_avatar_url--resolve-idn',
    method: R,
    condition: 'identity.avatar is an https URL with a non-ASCII host',
    setup: (c) =>
      c.agent(
        'p-pau-idn-agent',
        `${PROFILE}\n[identity]\navatar = "https://bücher.example/a.png"\n`
      ),
    params: (c) =>
      resolveReq(c, (ctx) => {
        ctx.agentId = 'p-pau-idn-agent'
        ctx.agentRoot = join(c.stage.agentsRoot, 'p-pau-idn-agent')
      }),
  },
  {
    reason: 'profile_avatar_url',
    id: 'profile_avatar_url--compile',
    method: C,
    condition: 'identity.avatar is an https URL raspd cannot judge (upper-case scheme)',
    setup: (c) =>
      c.agent('p-pau-agent', `${PROFILE}\n[identity]\navatar = "HTTPS://example.com/a.png"\n`),
    params: (c) => c.compileFor('p-pau-agent'),
  },
  {
    reason: 'profile_avatar_url',
    id: 'profile_avatar_url--inspect',
    method: I,
    condition: 'identity.avatar is an https URL raspd cannot judge (upper-case scheme)',
    setup: (c) =>
      c.agent('p-pau-agent', `${PROFILE}\n[identity]\navatar = "HTTPS://example.com/a.png"\n`),
    params: (c) => inspectFor(c, 'p-pau-agent'),
  },

  // ---------------------------------------------------------------- targets_schema_invalid / syntax
  {
    reason: 'targets_schema_invalid',
    id: 'targets_schema_invalid--resolve',
    method: R,
    condition: 'the project asp-targets.toml fails the JSON schema (unknown top-level key)',
    params: (c) => {
      const root = proj(c, 'p-tsi-proj', 'schema = 2\nbogus = 1\n')
      return resolveReq(c, (ctx) => {
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'targets_schema_invalid',
    id: 'targets_schema_invalid--resolve-search',
    method: R,
    condition: 'no agentRoot; the project asp-targets.toml fails the JSON schema (schema = 3)',
    params: (c) => {
      const root = proj(c, 'p-tsi-proj2', 'schema = 3\n')
      return resolveReq(c, (ctx) => {
        delete ctx.agentRoot
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'targets_schema_invalid',
    id: 'targets_schema_invalid--compile',
    method: C,
    condition:
      "bundle.projectRoot's asp-targets.toml fails the JSON schema (unknown top-level key)",
    params: (c) => {
      const root = proj(c, 'p-tsi-proj3', 'schema = 2\nbogus = 1\n')
      return compile(c, (p) => project(p, root))
    },
  },
  {
    reason: 'targets_schema_invalid',
    id: 'targets_schema_invalid--inspect',
    method: I,
    condition: 'the project asp-targets.toml fails the JSON schema (unknown top-level key)',
    params: (c) => {
      const root = proj(c, 'p-tsi-proj4', 'schema = 2\nbogus = 1\n')
      return inspectReq(c, (ctx) => {
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'targets_toml_syntax',
    id: 'targets_toml_syntax--resolve',
    method: R,
    condition: 'the project asp-targets.toml is not valid TOML',
    params: (c) => {
      const root = proj(c, 'p-tts-proj', 'schema = [\n')
      return resolveReq(c, (ctx) => {
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'targets_toml_syntax',
    id: 'targets_toml_syntax--compile',
    method: C,
    condition: "bundle.projectRoot's asp-targets.toml is not valid TOML",
    params: (c) => {
      const root = proj(c, 'p-tts-proj2', 'schema = [\n')
      return compile(c, (p) => project(p, root))
    },
  },
  {
    reason: 'targets_toml_syntax',
    id: 'targets_toml_syntax--inspect',
    method: I,
    condition: 'the project asp-targets.toml is not valid TOML',
    params: (c) => {
      const root = proj(c, 'p-tts-proj3', 'schema = [\n')
      return inspectReq(c, (ctx) => {
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },

  // ---------------------------------------------------------------- continuation_cwd_not_string
  {
    reason: 'continuation_cwd_not_string',
    method: O,
    condition: 'claude continuation with frozenStartRequest.placement.cwd a number',
    params: (c) => {
      const p = c.base('observe:claude:present:recorded')
      p.historicalExecution.frozenStartRequest = {
        keyBinding: 'runtime-continuation',
        placement: { cwd: 42, agentRoot: join(c.stage.agentsRoot, 'pathmark') },
        startRequest: {},
      }
      return p
    },
  },
  // ---------------------------------------------------------------- realpath_failed
  {
    reason: 'realpath_failed',
    id: 'realpath_failed--resolve',
    method: R,
    condition:
      'context.agentRoot is reachable by stat/access but its real path exceeds PATH_MAX (realpath ENAMETOOLONG)',
    params: (c) => {
      const root = deepDir(c, 'p-rpf-agent', { 'agent-profile.toml': PROFILE, ...AGENT_FILES })
      return resolveReq(c, (ctx) => {
        ctx.agentId = 'p-rpf-agent'
        ctx.agentRoot = root
      })
    },
  },
  {
    reason: 'realpath_failed',
    id: 'realpath_failed--inspect',
    method: I,
    condition:
      'context.agentRoot is reachable by stat/access but its real path exceeds PATH_MAX (realpath ENAMETOOLONG)',
    params: (c) => {
      const root = deepDir(c, 'p-rpf-agent', { 'agent-profile.toml': PROFILE, ...AGENT_FILES })
      return inspectFor(c, 'p-rpf-agent', (ctx) => (ctx.agentRoot = root))
    },
  },
  {
    reason: 'realpath_failed',
    id: 'realpath_failed--compile',
    method: C,
    condition:
      "placement.agentRoot's real path exceeds PATH_MAX; the system prompt resolves agent-root:///SOUL.md",
    params: (c) => {
      const root = deepDir(c, 'p-rpf-agent', { 'agent-profile.toml': PROFILE, ...AGENT_FILES })
      const p = c.compileFor('p-rpf-agent')
      p.compileRequest.placement.agentRoot = root
      return p
    },
  },

  // ---------------------------------------------------------------- agent_id_unported (more)
  {
    reason: 'agent_id_unported',
    id: 'agent_id_unported--resolve-proto-targets',
    method: R,
    condition:
      "agentId 'constructor' with agentRoot supplied and a project asp-targets.toml (targets[agentId] reads Object.prototype)",
    params: (c) => {
      const root = proj(c, 'p-aiu-proj', 'schema = 2\n\n[targets.someone]\npriming = "x"\n')
      const agent = agentAt(c, join(c.dir, 'constructor'), PROFILE)
      return resolveReq(c, (ctx) => {
        ctx.agentId = 'constructor'
        ctx.agentRoot = agent
        ctx.project.projectRoot = root
        ctx.cwd = root
      })
    },
  },
  {
    reason: 'agent_id_unported',
    id: 'agent_id_unported--resolve-proto-root',
    method: R,
    condition: "agentId 'constructor' with agentRoot supplied, project without asp-targets.toml",
    params: (c) => {
      const agent = agentAt(c, join(c.dir, 'constructor'), PROFILE)
      return resolveReq(c, (ctx) => {
        ctx.agentId = 'constructor'
        ctx.agentRoot = agent
      })
    },
  },

  // ---------------------------------------------------------------- materialization_shape (more)
  {
    reason: 'materialization_shape',
    id: 'materialization_shape--image-attachment',
    method: C,
    condition:
      'materialization.attachments carries one image attachment (kind image, absolute path)',
    params: (c) => {
      const img = join(c.dir, 'probe.png')
      c.write(img, 'not-really-a-png')
      return compile(
        c,
        (p) =>
          (p.compileRequest.materialization.attachments = [
            { kind: 'image', path: img, mimeType: 'image/png' },
          ])
      )
    },
  },
  {
    reason: 'materialization_shape',
    id: 'materialization_shape--image-attachment-codex',
    method: C,
    condition: 'codex-tui compile whose materialization.attachments carries one image attachment',
    params: (c) => {
      const img = join(c.dir, 'probe.png')
      c.write(img, 'not-really-a-png')
      return compile(
        c,
        (p) =>
          (p.compileRequest.materialization.attachments = [
            { kind: 'image', path: img, mimeType: 'image/png' },
          ]),
        undefined,
        'compile:codex-app-server'
      )
    },
  },
]
export default cases
