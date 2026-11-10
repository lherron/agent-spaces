import type { Ctx, ProbeCase } from '../ctx.ts'

// ---- helpers ---------------------------------------------------------------

/** A space whose space.toml carries `extra` (raw TOML lines appended). */
function spaceToml(id: string, extra: string, head = ''): string {
  return `${head}schema = 1\nid = "${id}"\nversion = "1.0.0"\n\n[plugin]\nname = "${id}"\n\n${extra}`
}

/** Agent composing pm-dev plus one probe space. */
function agentWith(c: Ctx, agent: string, space: string, extraProfile = '') {
  c.agent(
    agent,
    `version = 4\npriming = "probe priming"\n${extraProfile}\n[spaces]\nbase = ["space:pm-dev@dev", "space:${space}@dev"]\n`
  )
}

/** A codex compile of an agent whose probe space has a [codex.config] value. */
function codexConfigCase(reason: string, value: string, head = ''): ProbeCase {
  const sid = `p-tb-${reason.replace(/^toml_/, '').replace(/_/g, '-')}`
  return {
    reason,
    id: `${reason}--space-codex-config`,
    method: 'aspc.compileHarnessInvocation',
    condition: `space.toml [codex.config] (free-form) holds ${JSON.stringify(value)}; codex compile`,
    setup: (c) => {
      c.space(sid, spaceToml(sid, `[codex.config]\n${value}\n`, head))
      agentWith(c, `${sid}-agent`, sid)
    },
    params: (c) => c.compileFor(`${sid}-agent`, 'compile:codex-tui'),
  }
}

/** A claude compile of an agent whose own agent-profile.toml carries `toml`. */
function profileCase(
  reason: string,
  variant: string,
  profile: string,
  condition: string
): ProbeCase {
  const agent = `p-tb-prof-${reason.replace(/^toml_/, '').replace(/_/g, '-')}`
  return {
    reason,
    id: `${reason}--${variant}`,
    method: 'aspc.compileHarnessInvocation',
    condition,
    setup: (c) => {
      c.agent(agent, profile)
    },
    params: (c) => c.compileFor(agent),
  }
}

/** Agent with a context-template.toml in its root. */
function tplAgent(
  c: Ctx,
  agent: string,
  template: string,
  files: Record<string, string> = {},
  profileExtra = ''
) {
  c.agent(
    agent,
    `version = 4\npriming = "probe priming"\n${profileExtra}\n[spaces]\nbase = ["space:pm-dev@dev"]\n`,
    {
      'context-template.toml': template,
      ...files,
    }
  )
}

/** inspect:claude:preview retargeted to `agent`. */
function inspectFor(c: Ctx, agent: string, from = 'inspect:claude:preview') {
  const p = c.base(from)
  const old = p.context.agentId
  p.context.agentId = agent
  p.context.agentRoot = `${c.stage.agentsRoot}/${agent}`
  const swap = (s: string) => s.split(`agent:${old}:`).join(`agent:${agent}:`)
  const sr = p.preparationCorrelation?.sessionRef
  if (sr?.scopeRef) sr.scopeRef = swap(sr.scopeRef)
  if (p.dispatchEnv)
    for (const k of Object.keys(p.dispatchEnv)) p.dispatchEnv[k] = swap(p.dispatchEnv[k])
  return p
}

const SOUL_SECTION = '[[prompt]]\nname = "soul"\ntype = "file"\npath = "agent-root:///SOUL.md"\n'
const TPL = (body: string, head = '') => `schema_version = 2\n${head}\n${SOUL_SECTION}\n${body}`

const BASE_PROFILE = 'version = 4\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'

const cases: ProbeCase[] = [
  // ---- reads/toml.rs Unsupported --------------------------------------------
  codexConfigCase('toml_datetime', 'rollout_after = 2026-01-01T00:00:00Z'),
  codexConfigCase('toml_bigint', 'big_limit = 9007199254740993'),
  codexConfigCase('toml_nonfinite_float', 'temperature = inf'),
  codexConfigCase('toml_proto_key', '__proto__ = "x"'),
  codexConfigCase('toml_bom', 'model_verbosity = "low"', '\u{feff}'),
  {
    reason: 'toml_quote_run',
    id: 'toml_quote_run--space-description',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'space.toml description is a multi-line basic string ending in a quote (""""), valid TOML 1.0',
    setup: (c) => {
      const sid = 'p-tb-quote-run'
      c.write(
        `${c.stage.agentsRoot}/spaces/${sid}/space.toml`,
        `schema = 1\nid = "${sid}"\nversion = "1.0.0"\ndescription = """Says "hi""""\n\n[plugin]\nname = "${sid}"\n`
      )
      agentWith(c, `${sid}-agent`, sid)
    },
    params: (c) => c.compileFor('p-tb-quote-run-agent'),
  },
  profileCase(
    'toml_quote_run',
    'profile-priming',
    'version = 4\npriming = """\nWhen done, reply "done""""\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n',
    'agent-profile.toml priming is a multi-line basic string ending in a quote (""""), valid TOML 1.0'
  ),
  profileCase(
    'toml_datetime',
    'profile-unknown-key',
    `version = 4\nupdated = 2026-01-01\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n`,
    'agent-profile.toml carries a date value (top-level key updated = 2026-01-01)'
  ),
  profileCase(
    'toml_bom',
    'profile',
    `\u{feff}${BASE_PROFILE}`,
    'agent-profile.toml starts with a UTF-8 BOM (otherwise valid)'
  ),
  profileCase(
    'toml_bigint',
    'profile',
    `version = 4\n\n[provisioning]\nmodel = "opus"\n\n[jobs]\ndefault_node = 9007199254740993\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n`,
    'agent-profile.toml jobs.default_node is an integer beyond 2^53'
  ),
  profileCase(
    'toml_nonfinite_float',
    'profile',
    `version = 4\npriming = nan\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n`,
    'agent-profile.toml priming = nan'
  ),
  profileCase(
    'toml_proto_key',
    'profile',
    `version = 4\n\n[provisioning]\n__proto__ = "x"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n`,
    'agent-profile.toml [provisioning] has a __proto__ key'
  ),
  profileCase(
    'toml_quote_run',
    'profile-comment',
    'version = 4\n# a comment that happens to contain """" four quotes\npriming = "probe"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n',
    'agent-profile.toml has a comment containing four double quotes; no multi-line string involved'
  ),
  // ---- compile/iarna.rs (TOML.stringify of codex config.toml) ----------------
  {
    reason: 'toml_mixed_array',
    id: 'toml_mixed_array--mcp-args',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'a composed space mcp/mcp.json server has args mixing strings and a number; codex compile',
    setup: (c) => {
      const sid = 'p-tb-mixed-array'
      c.space(sid, spaceToml(sid, ''), {
        'mcp/mcp.json': JSON.stringify(
          { mcpServers: { probe: { command: 'node', args: ['server.js', '--port', 8080] } } },
          null,
          2
        ),
      })
      agentWith(c, `${sid}-agent`, sid)
    },
    params: (c) => c.compileFor('p-tb-mixed-array-agent', 'compile:codex-tui'),
  },
  {
    reason: 'toml_stringify_type',
    id: 'toml_stringify_type--mcp-args-nested-null',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'a composed space mcp/mcp.json server has args [[{"k": null}]] (a null inside an inline table); codex compile',
    setup: (c) => {
      const sid = 'p-tb-stringify-type'
      c.space(sid, spaceToml(sid, ''), {
        'mcp/mcp.json': JSON.stringify(
          { mcpServers: { probe: { command: 'node', args: [[{ k: null }]] } } },
          null,
          2
        ),
      })
      agentWith(c, `${sid}-agent`, sid)
    },
    params: (c) => c.compileFor('p-tb-stringify-type-agent', 'compile:codex-tui'),
  },
  // ---- compile/inspect.rs --------------------------------------------------
  {
    reason: 'inspect_harness',
    id: 'inspect_harness--agent-harness',
    method: 'aspc.inspectRuntimePlacement',
    condition: 'inspect with effective harness agent-harness (base inspect:agent-harness:preview)',
    params: (c) => c.base('inspect:agent-harness:preview'),
  },
  {
    reason: 'inspect_harness',
    id: 'inspect_harness--muse',
    method: 'aspc.inspectRuntimePlacement',
    condition: 'inspect with effective harness muse (base inspect:muse)',
    params: (c) => c.base('inspect:muse'),
  },
  {
    reason: 'inspect_harness',
    id: 'inspect_harness--undeclared',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'inspect of an agent whose profile declares no harness, with no provisionDirectives.harness',
    setup: (c) => c.agent('p-ih-undeclared', BASE_PROFILE),
    params: (c) => {
      const p = inspectFor(c, 'p-ih-undeclared')
      p.context.provisionDirectives = undefined
      return p
    },
  },
  {
    reason: 'inspect_harness',
    id: 'inspect_harness--claude-hrcpty-now-native',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'inspect with harness claude-hrcpty (the 27 prod hits); expected native since 335e4011',
    params: (c) => c.base('inspect:claude-hrcpty:preview'),
  },
  {
    reason: 'inspect_harness_unknown',
    id: 'inspect_harness_unknown--directive-pi',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'inspect with provisionDirectives.harness = "pi" (not a harness id); expected: declaration refuses natively first',
    params: (c) => {
      const p = c.base('inspect:claude:preview')
      p.context.provisionDirectives.harness = 'pi'
      return p
    },
  },
  {
    reason: 'inspect_profile_missing',
    id: 'inspect_profile_missing',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'inspect of an agent root that has SOUL.md but no agent-profile.toml (harness claude by directive)',
    setup: (c) =>
      c.write(
        `${c.stage.agentsRoot}/p-ipm-noprofile/SOUL.md`,
        '# p-ipm-noprofile\n\nProbe agent.\n'
      ),
    params: (c) => inspectFor(c, 'p-ipm-noprofile'),
  },
  {
    reason: 'inspect_duplicate_part',
    id: 'inspect_duplicate_part',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'inspect of an agent whose context template has two [[prompt]] sections with the same name',
    setup: (c) =>
      tplAgent(
        c,
        'p-idp-dup',
        TPL(
          '[[prompt]]\nname = "note"\ntype = "inline"\ncontent = "first"\n\n[[prompt]]\nname = "note"\ntype = "inline"\ncontent = "second"\n'
        )
      ),
    params: (c) => inspectFor(c, 'p-idp-dup'),
  },
  {
    reason: 'inspect_duplicate_part',
    id: 'inspect_duplicate_part--compile',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'compile of the same agent (duplicate section names): what Bun compile does with the template',
    params: (c) => c.compileFor('p-idp-dup'),
  },
  {
    reason: 'profile_unreadable',
    id: 'profile_unreadable--inspect-latin1',
    method: 'aspc.inspectRuntimePlacement',
    condition:
      'agent-profile.toml contains a non-UTF-8 byte (Latin-1 0xE9) inside a comment; inspect',
    setup: (c) => {
      c.agent('p-pu-latin1', BASE_PROFILE)
      const fs = require('node:fs')
      fs.writeFileSync(
        `${c.stage.agentsRoot}/p-pu-latin1/agent-profile.toml`,
        Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${BASE_PROFILE}`)])
      )
    },
    params: (c) => inspectFor(c, 'p-pu-latin1'),
  },
  {
    reason: 'profile_unreadable',
    id: 'profile_unreadable--compile-latin1',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'agent-profile.toml contains a non-UTF-8 byte (Latin-1 0xE9) inside a comment; compile',
    // T-13048: its own agent, so it runs on a fresh stage (it relied on the inspect case's).
    setup: (c) => {
      c.agent('p-pu-latin1', BASE_PROFILE)
      const fs = require('node:fs')
      fs.writeFileSync(
        `${c.stage.agentsRoot}/p-pu-latin1/agent-profile.toml`,
        Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${BASE_PROFILE}`)])
      )
    },
    params: (c) => c.compileFor('p-pu-latin1'),
  },
  // ---- compile/prompt.rs ---------------------------------------------------
  {
    reason: 'agents_root_config',
    id: 'agents_root_config--asphome-config-syntax',
    method: 'aspc.compileHarnessInvocation',
    condition: 'compile with explicit aspHome whose config.toml is not valid TOML',
    setup: (c) => {
      const fs = require('node:fs')
      fs.rmSync(`${c.dir}/asp-home`, { recursive: true, force: true })
      fs.cpSync(c.stage.aspHome, `${c.dir}/asp-home`, { recursive: true })
      c.write(`${c.dir}/asp-home/config.toml`, 'agents-root = [\n')
    },
    params: (c) => ({ ...c.base('compile:claude-code:dev'), aspHome: `${c.dir}/asp-home` }),
  },
  {
    reason: 'configured_template_missing',
    id: 'configured_template_missing',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'profile [instructions] template names a file that does not exist anywhere on the search path',
    setup: (c) =>
      c.agent(
        'p-ctm-missing',
        'version = 4\n\n[instructions]\ntemplate = "p-ctm-no-such-template.toml"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
      ),
    params: (c) => c.compileFor('p-ctm-missing'),
  },
  {
    reason: 'context_template_invalid',
    id: 'context_template_invalid--schema-version',
    method: 'aspc.compileHarnessInvocation',
    condition: 'context-template.toml declares schema_version = 1',
    setup: (c) => tplAgent(c, 'p-cti-schema', `schema_version = 1\n\n${SOUL_SECTION}`),
    params: (c) => c.compileFor('p-cti-schema'),
  },
  {
    reason: 'context_template_invalid',
    id: 'context_template_invalid--section-type',
    method: 'aspc.compileHarnessInvocation',
    condition: 'context-template.toml has a section with an unknown type ("markdown")',
    setup: (c) =>
      tplAgent(c, 'p-cti-type', TPL('[[prompt]]\nname = "x"\ntype = "markdown"\ncontent = "x"\n')),
    params: (c) => c.compileFor('p-cti-type'),
  },
  {
    reason: 'context_template_max_chars',
    id: 'context_template_max_chars',
    method: 'aspc.compileHarnessInvocation',
    condition: 'context template max_chars = 20 and its resolved sections exceed it',
    setup: (c) =>
      tplAgent(
        c,
        'p-ctmc-over',
        TPL(
          '[[prompt]]\nname = "long"\ntype = "inline"\ncontent = "a long section that exceeds twenty characters"\n',
          'max_chars = 20'
        )
      ),
    params: (c) => c.compileFor('p-ctmc-over'),
  },
  {
    reason: 'prompt_section_failed',
    id: 'prompt_section_failed--inspect-exec-exit1',
    method: 'aspc.inspectRuntimePlacement',
    condition: 'inspect of an agent whose template has an exec section that exits 1',
    setup: (c) =>
      tplAgent(
        c,
        'p-psf-exec',
        TPL('[[prompt]]\nname = "status"\ntype = "exec"\ncommand = "echo partial; exit 1"\n')
      ),
    params: (c) => inspectFor(c, 'p-psf-exec'),
  },
  {
    reason: 'required_context_file_missing',
    id: 'required_context_file_missing',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'template file section required = true names agent-root:///MISSING.md, which does not exist',
    setup: (c) =>
      tplAgent(
        c,
        'p-rcfm-missing',
        TPL(
          '[[prompt]]\nname = "doc"\ntype = "file"\npath = "agent-root:///MISSING.md"\nrequired = true\n'
        )
      ),
    params: (c) => c.compileFor('p-rcfm-missing'),
  },
  {
    reason: 'required_context_file_missing',
    id: 'required_context_file_missing--empty',
    method: 'aspc.compileHarnessInvocation',
    condition: 'template file section required = true names an existing but empty file',
    setup: (c) =>
      tplAgent(
        c,
        'p-rcfm-empty',
        TPL(
          '[[prompt]]\nname = "doc"\ntype = "file"\npath = "agent-root:///EMPTY.md"\nrequired = true\n'
        ),
        { 'EMPTY.md': '' }
      ),
    params: (c) => c.compileFor('p-rcfm-empty'),
  },
  {
    reason: 'required_context_file_unreadable',
    id: 'required_context_file_unreadable--directory',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'template file section required = true names agent-root:///docs, which is a directory',
    setup: (c) =>
      tplAgent(
        c,
        'p-rcfu-dir',
        TPL(
          '[[prompt]]\nname = "doc"\ntype = "file"\npath = "agent-root:///docs"\nrequired = true\n'
        ),
        { 'docs/README.md': 'x\n' }
      ),
    params: (c) => c.compileFor('p-rcfu-dir'),
  },
  {
    reason: 'required_context_file_unresolvable',
    id: 'required_context_file_unresolvable--escape',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'template file section required = true names agent-root:///../SHARED.md (escapes the agent root)',
    setup: (c) =>
      tplAgent(
        c,
        'p-rcfr-escape',
        TPL(
          '[[prompt]]\nname = "doc"\ntype = "file"\npath = "agent-root:///../SHARED.md"\nrequired = true\n'
        )
      ),
    params: (c) => c.compileFor('p-rcfr-escape'),
  },
  ...(
    [
      ['no-scheme', 'localhost:8080'],
      ['unknown-scheme', 'redis://localhost:6379'],
      ['ipv6', 'tcp://[::1]:6379'],
      ['port-range', 'tcp://localhost:70000'],
      ['host-underscore', 'http://my_service:8080/health'],
    ] as const
  ).map(
    ([v, ep]): ProbeCase => ({
      reason: 'service_probe_endpoint',
      id: `service_probe_endpoint--${v}`,
      method: 'aspc.compileHarnessInvocation',
      condition: `template service-probe section endpoint = ${JSON.stringify(ep)}`,
      setup: (c) =>
        tplAgent(
          c,
          `p-spe-${v}`,
          TPL(
            `[[prompt]]\nname = "services"\ntype = "service-probe"\ntimeout = 200\n\n[[prompt.services]]\nname = "svc"\nendpoint = ${JSON.stringify(ep)}\n`
          )
        ),
      params: (c) => c.compileFor(`p-spe-${v}`),
    })
  ),
  {
    reason: 'slot_prototype_source',
    id: 'slot_prototype_source',
    method: 'aspc.compileHarnessInvocation',
    condition: 'template slot section source = "instructions.constructor"',
    setup: (c) =>
      tplAgent(
        c,
        'p-sps-proto',
        TPL('[[prompt]]\nname = "slot"\ntype = "slot"\nsource = "instructions.constructor"\n'),
        {},
        '\n[instructions]\nbase = ["agent-root:///SOUL.md"]\n'
      ),
    params: (c) => c.compileFor('p-sps-proto'),
  },
  {
    reason: 'targets_unreadable',
    id: 'targets_unreadable--inspect-latin1',
    method: 'aspc.inspectRuntimePlacement',
    condition: 'project asp-targets.toml contains a non-UTF-8 byte (Latin-1 0xE9) in a comment',
    setup: (c) => {
      const fs = require('node:fs')
      fs.mkdirSync(`${c.dir}/project`, { recursive: true })
      fs.writeFileSync(
        `${c.dir}/project/asp-targets.toml`,
        Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nschema = 2\n')])
      )
    },
    params: (c) => {
      const p = c.base('inspect:claude:preview')
      p.context.project.projectRoot = `${c.dir}/project`
      p.context.cwd = `${c.dir}/project`
      return p
    },
    note: 'compile with the same project forwards source_read_unavailable at compile/mod.rs:1094 first (strict read for codex options)',
  },
  {
    reason: 'template_prototype_variable',
    id: 'template_prototype_variable--inline',
    method: 'aspc.compileHarnessInvocation',
    condition: 'template inline section content contains {{constructor}}',
    setup: (c) =>
      tplAgent(
        c,
        'p-tpv-ctor',
        TPL('[[prompt]]\nname = "note"\ntype = "inline"\ncontent = "value: {{constructor}}"\n')
      ),
    params: (c) => c.compileFor('p-tpv-ctor'),
  },
  {
    reason: 'template_prototype_variable',
    id: 'template_prototype_variable--priming',
    method: 'aspc.compileHarnessInvocation',
    condition: 'agent priming contains {{toString}} (no template)',
    setup: (c) =>
      c.agent(
        'p-tpv-priming',
        'version = 4\npriming = "hello {{toString}}"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
      ),
    params: (c) => c.compileFor('p-tpv-priming'),
  },
  {
    reason: 'template_unreadable',
    id: 'template_unreadable--latin1',
    method: 'aspc.compileHarnessInvocation',
    condition: 'context-template.toml contains a non-UTF-8 byte (Latin-1 0xE9) in a comment',
    setup: (c) => {
      tplAgent(c, 'p-tu-latin1', '')
      const fs = require('node:fs')
      fs.writeFileSync(
        `${c.stage.agentsRoot}/p-tu-latin1/context-template.toml`,
        Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${TPL('')}`)])
      )
    },
    params: (c) => c.compileFor('p-tu-latin1'),
  },
  {
    reason: 'truncate_splits_surrogate',
    id: 'truncate_splits_surrogate',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'template section max_chars = 13 truncates "x" + emoji run so the cut lands inside a surrogate pair',
    setup: (c) =>
      tplAgent(
        c,
        'p-tss-emoji',
        TPL(
          `[[prompt]]\nname = "emoji"\ntype = "inline"\nmax_chars = 13\ncontent = "x${'\u{1F600}'.repeat(20)}"\n`
        )
      ),
    params: (c) => c.compileFor('p-tss-emoji'),
  },
  {
    reason: 'toml_bigint',
    id: 'toml_bigint--space-codex-config-claude',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'same space as toml_bigint--space-codex-config (bigint in [codex.config]) but a claude compile',
    params: (c) => c.compileFor('p-tb-bigint-agent'),
  },
]
export default cases
