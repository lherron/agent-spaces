import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'

const SKILL = '---\nname: s\ndescription: s.\n---\n\nLoaded.\n'

/** A dev space with a skill, plus extra files. */
function space(c: Ctx, id: string, extraToml = '', files: Record<string, string> = {}) {
  return c.space(
    id,
    `schema = 1\nid = "${id}"\nversion = "1.0.0"\n\n[plugin]\nname = "${id}"\n${extraToml}`,
    { [`skills/${id}-skill/SKILL.md`]: SKILL, ...files }
  )
}

/** An agent composing the given dev spaces. */
function agent(c: Ctx, name: string, spaces: string[], files: Record<string, string> = {}) {
  return c.agent(
    name,
    `version = 4\n\n[spaces]\nbase = [${spaces.map((s) => `"space:${s}@dev"`).join(',')}]\n`,
    files
  )
}

/** A compile for `name` against a fresh-or-kept per-case ASP_HOME under `home`. */
function compileIn(c: Ctx, name: string, home: string, from = 'compile:claude-code:dev') {
  const p = c.compileFor(name, from)
  p.aspHome = home
  return p
}

/** proper-lockfile: `<realpath(file)>.lock` directory, kept fresh until the reply lands. */
function holdLock(lockFile: string, c: Ctx) {
  mkdirSync(join(lockFile, '..'), { recursive: true })
  if (!existsSync(lockFile)) writeFileSync(lockFile, '')
  const dir = `${realpathSync(lockFile)}.lock`
  mkdirSync(dir, { recursive: true })
  // Touch every 5 s until the runner writes c.done (after the reply), cap 300 s.
  const script = `i=0; while [ ! -e "${c.done}" ] && [ $i -lt 60 ]; do touch "${dir}"; sleep 5; i=$((i+1)); done; rmdir "${dir}" 2>/dev/null; true`
  Bun.spawn(['/bin/sh', '-c', script], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
}

function sanitize(v: string) {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
}

/** The codex.home of the one published bundle version under `home` for `agentName`. */
function publishedCodexHome(home: string, agentName: string): string {
  const versions = join(
    home,
    'codex-homes',
    `project_${sanitize(agentName)}`,
    'bundles',
    '.versions'
  )
  const fps = readdirSync(versions).filter((n) => /^[0-9a-f]{64}$/.test(n))
  if (fps.length !== 1)
    throw new Error(`expected one bundle version under ${versions}, got ${fps.length}`)
  return join(versions, fps[0] as string, agentName, 'codex', 'codex.home')
}

function runtimeHome(home: string, agentName: string) {
  return join(home, 'codex-homes', `project_${sanitize(agentName)}`)
}

const cases: ProbeCase[] = [
  // -- space TOML files read by staging --------------------------------------
  {
    reason: 'toml_syntax',
    id: 'toml_syntax',
    method: 'aspc.compileHarnessInvocation',
    condition: 'hooks/hooks.toml of a composed dev space is not valid TOML',
    setup: (c) => {
      space(c, 'p-e-tsyn', '', {
        'hooks/hooks.toml': '[[hook]\nevent = "stop"\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      agent(c, 'p-e-tsyn-agent', ['p-e-tsyn'])
    },
    params: (c) => c.compileFor('p-e-tsyn-agent'),
  },
  {
    reason: 'toml_syntax',
    id: 'toml_syntax--permissions',
    method: 'aspc.compileHarnessInvocation',
    condition: 'permissions.toml of a composed dev space is not valid TOML',
    setup: (c) => {
      space(c, 'p-e-tsynp', '', { 'permissions.toml': '[read\npaths = ["x"]\n' })
      agent(c, 'p-e-tsynp-agent', ['p-e-tsynp'])
    },
    params: (c) => c.compileFor('p-e-tsynp-agent'),
  },
  {
    reason: 'toml_unreadable',
    id: 'toml_unreadable',
    method: 'aspc.compileHarnessInvocation',
    condition: 'hooks/hooks.toml of a composed dev space exists but cannot be read (mode 000)',
    setup: (c) => {
      const root = space(c, 'p-e-tunr', '', {
        'hooks/hooks.toml': '[[hook]]\nevent = "stop"\nscript = "a.sh"\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      chmodSync(join(root, 'hooks', 'hooks.toml'), 0o000)
      agent(c, 'p-e-tunr-agent', ['p-e-tunr'])
    },
    params: (c) => c.compileFor('p-e-tunr-agent'),
  },
  {
    reason: 'toml_unreadable',
    id: 'toml_unreadable--non-utf8',
    method: 'aspc.compileHarnessInvocation',
    condition: 'hooks/hooks.toml is readable but holds a non-UTF-8 byte (in a comment)',
    setup: (c) => {
      const root = space(c, 'p-e-tutf', '', { 'hooks/a.sh': '#!/bin/sh\n' })
      writeFileSync(
        join(root, 'hooks', 'hooks.toml'),
        Buffer.concat([
          Buffer.from('# caf'),
          Buffer.from([0xe9]),
          Buffer.from('\n[[hook]]\nevent = "stop"\nscript = "a.sh"\n'),
        ])
      )
      agent(c, 'p-e-tutf-agent', ['p-e-tutf'])
    },
    params: (c) => c.compileFor('p-e-tutf-agent'),
  },
  {
    reason: 'hooks_toml_shape',
    id: 'hooks_toml_shape',
    method: 'aspc.compileHarnessInvocation',
    condition: 'a [[hook]] in hooks.toml has a non-string event (event = 42)',
    setup: (c) => {
      space(c, 'p-e-hts', '', {
        'hooks/hooks.toml': '[[hook]]\nevent = 42\nscript = "a.sh"\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      agent(c, 'p-e-hts-agent', ['p-e-hts'])
    },
    params: (c) => c.compileFor('p-e-hts-agent'),
  },
  {
    reason: 'hooks_toml_shape',
    id: 'hooks_toml_shape--tools',
    method: 'aspc.compileHarnessInvocation',
    condition: 'a pre_tool_use [[hook]] has a non-string tools element (tools = [1])',
    setup: (c) => {
      space(c, 'p-e-htt', '', {
        'hooks/hooks.toml': '[[hook]]\nevent = "pre_tool_use"\nscript = "a.sh"\ntools = [1]\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      agent(c, 'p-e-htt-agent', ['p-e-htt'])
    },
    params: (c) => c.compileFor('p-e-htt-agent'),
  },
  {
    reason: 'permissions_toml_shape',
    id: 'permissions_toml_shape',
    method: 'aspc.compileHarnessInvocation',
    condition: 'permissions.toml [read] paths holds a non-string (paths = [1])',
    setup: (c) => {
      space(c, 'p-e-pts', '', { 'permissions.toml': '[read]\npaths = [1]\n' })
      agent(c, 'p-e-pts-agent', ['p-e-pts'])
    },
    params: (c) => c.compileFor('p-e-pts-agent'),
  },
  {
    reason: 'permissions_toml_shape',
    id: 'permissions_toml_shape--network',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'permissions.toml [network] hosts holds a non-string (hosts = [1]); claude never trims hosts',
    setup: (c) => {
      space(c, 'p-e-ptn', '', { 'permissions.toml': '[network]\nhosts = [1]\n' })
      agent(c, 'p-e-ptn-agent', ['p-e-ptn'])
    },
    params: (c) => c.compileFor('p-e-ptn-agent'),
  },
  {
    reason: 'space_harness_skip',
    id: 'space_harness_skip',
    method: 'aspc.compileHarnessInvocation',
    condition: 'a composed dev space declares [harness] supports = ["claude"] (no agent-harness)',
    setup: (c) => {
      space(c, 'p-e-shs', '\n[harness]\nsupports = ["claude"]\n')
      agent(c, 'p-e-shs-agent', ['pm-dev', 'p-e-shs'])
    },
    params: (c) => c.compileFor('p-e-shs-agent'),
  },
  {
    reason: 'space_harness_skip',
    id: 'space_harness_skip--codex',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex-app-server compile; a composed dev space declares [harness] supports = ["codex"]',
    setup: (c) => {
      space(c, 'p-e-shc', '\n[harness]\nsupports = ["codex"]\n')
      agent(c, 'p-e-shc-agent', ['pm-dev', 'p-e-shc'])
    },
    params: (c) => c.compileFor('p-e-shc-agent', 'compile:codex-app-server'),
  },
  // -- staging copies ---------------------------------------------------------
  {
    reason: 'symlink_cycle',
    id: 'symlink_cycle',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'agent-local commands/ holds a symlink to itself (commands/loop -> .), copied with followSymlinks',
    setup: (c) => {
      const root = agent(c, 'p-e-syc-agent', ['pm-dev'], { 'commands/hello.md': '# hello\n' })
      rmSync(join(root, 'commands', 'loop'), { force: true })
      symlinkSync('.', join(root, 'commands', 'loop'))
    },
    params: (c) => c.compileFor('p-e-syc-agent'),
  },
  {
    reason: 'materialize_io',
    id: 'materialize_io',
    method: 'aspc.compileHarnessInvocation',
    condition: 'agent-local commands/ holds a dangling symlink (followed when copying)',
    setup: (c) => {
      const root = agent(c, 'p-e-mio-agent', ['pm-dev'], { 'commands/hello.md': '# hello\n' })
      rmSync(join(root, 'commands', 'dead.md'), { force: true })
      symlinkSync('/nonexistent/p-e-mio', join(root, 'commands', 'dead.md'))
    },
    params: (c) => c.compileFor('p-e-mio-agent'),
  },
  {
    reason: 'materialize_io',
    id: 'materialize_io--unreadable-dir',
    method: 'aspc.compileHarnessInvocation',
    condition: 'a composed dev space has a skills subdirectory that cannot be listed (mode 000)',
    setup: (c) => {
      const root = space(c, 'p-e-miu', '', { 'skills/locked/SKILL.md': SKILL })
      chmodSync(join(root, 'skills', 'locked'), 0o000)
      agent(c, 'p-e-miu-agent', ['p-e-miu'])
    },
    params: (c) => c.compileFor('p-e-miu-agent'),
  },
  {
    reason: 'mcp_config_shape',
    id: 'mcp_config_shape',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'claude: a composed dev space has mcp/mcp.json that is valid JSON without mcpServers',
    setup: (c) => {
      space(c, 'p-e-mcs', '', { 'mcp/mcp.json': '{"servers": {}}\n' })
      agent(c, 'p-e-mcs-agent', ['p-e-mcs'])
    },
    params: (c) => c.compileFor('p-e-mcs-agent'),
  },
  {
    reason: 'mcp_config_shape',
    id: 'mcp_config_shape--codex',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex-app-server: a composed dev space has mcp/mcp.json that is valid JSON without mcpServers',
    setup: (c) => {
      space(c, 'p-e-mcx', '', { 'mcp/mcp.json': '{"servers": {}}\n' })
      agent(c, 'p-e-mcx-agent', ['p-e-mcx'])
    },
    params: (c) => c.compileFor('p-e-mcx-agent', 'compile:codex-app-server'),
  },
  {
    reason: 'skill_name_conflict',
    id: 'skill_name_conflict',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'claude: a composed dev space and the agent-local plugin both ship skills/probe-skill',
    setup: (c) => {
      space(c, 'p-e-snc', '', { 'skills/probe-skill/SKILL.md': SKILL })
      agent(c, 'p-e-snc-agent', ['p-e-snc'])
    },
    params: (c) => c.compileFor('p-e-snc-agent'),
  },
  {
    reason: 'command_name_conflict',
    id: 'command_name_conflict',
    method: 'aspc.compileHarnessInvocation',
    condition: 'claude: two composed dev spaces both ship commands/hello.md',
    setup: (c) => {
      space(c, 'p-e-cnca', '', { 'commands/hello.md': '# a\n' })
      space(c, 'p-e-cncb', '', { 'commands/hello.md': '# b\n' })
      agent(c, 'p-e-cnc-agent', ['p-e-cnca', 'p-e-cncb'])
    },
    params: (c) => c.compileFor('p-e-cnc-agent'),
  },
  {
    reason: 'codex_space_hook_unsafe',
    id: 'codex_space_hook_unsafe',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex-app-server: a codex pre_tool_use [[hook]] script path has a space ("bad name.sh")',
    setup: (c) => {
      space(c, 'p-e-csu', '', {
        'hooks/hooks.toml':
          '[[hook]]\nevent = "pre_tool_use"\nscript = "bad name.sh"\nharness = "codex"\n',
        'hooks/bad name.sh': '#!/bin/sh\nexit 0\n',
      })
      agent(c, 'p-e-csu-agent', ['p-e-csu'])
    },
    params: (c) => c.compileFor('p-e-csu-agent', 'compile:codex-app-server'),
  },
  {
    reason: 'codex_space_hook_unsafe',
    id: 'codex_space_hook_unsafe--parent',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex-app-server: a codex pre_tool_use [[hook]] script path climbs out (../x.sh)',
    setup: (c) => {
      space(c, 'p-e-csp', '', {
        'hooks/hooks.toml':
          '[[hook]]\nevent = "pre_tool_use"\nscript = "../x.sh"\nharness = "codex"\n',
        'hooks/a.sh': '#!/bin/sh\nexit 0\n',
      })
      agent(c, 'p-e-csp-agent', ['p-e-csp'])
    },
    params: (c) => c.compileFor('p-e-csp-agent', 'compile:codex-app-server'),
  },

  // -- lock contention (per-case ASP_HOME) ---------------------------------------
  {
    reason: 'bundle_scope_lock',
    id: 'bundle_scope_lock',
    method: 'aspc.compileHarnessInvocation',
    condition:
      "claude compile while another holder keeps the target's bundle-scope materialization lock fresh (per-case aspHome)",
    setup: (c) => {
      const home = join(c.dir, 'asp-home')
      rmSync(home, { recursive: true, force: true })
      space(c, 'p-e-bsl')
      agent(c, 'p-e-bsl-agent', ['p-e-bsl'])
      const scopeRoot = join(home, 'codex-homes', 'project_p-e-bsl-agent')
      const key = `bundle-scope-${createHash('sha256').update(join(scopeRoot, 'bundles')).digest('hex').slice(0, 32)}`
      holdLock(join(home, 'tmp', 'locks', `${key}.lock`), c)
    },
    params: (c) => compileIn(c, 'p-e-bsl-agent', join(c.dir, 'asp-home')),
  },
  {
    reason: 'codex_home_lock',
    id: 'codex_home_lock',
    method: 'aspc.compileHarnessInvocation',
    condition:
      "codex-app-server compile while another holder keeps the runtime home's .asp-runtime.lock fresh (per-case aspHome)",
    setup: (c) => {
      const home = join(c.dir, 'asp-home')
      rmSync(home, { recursive: true, force: true })
      space(c, 'p-e-chl')
      agent(c, 'p-e-chl-agent', ['p-e-chl'])
      holdLock(join(runtimeHome(home, 'p-e-chl-agent'), '.asp-runtime.lock'), c)
    },
    params: (c) =>
      compileIn(c, 'p-e-chl-agent', join(c.dir, 'asp-home'), 'compile:codex-app-server'),
  },
  // -- a published codex bundle whose template was damaged after publish ----------
  // Each pair: a native prep compile publishes into a per-case aspHome, then the
  // case damages one file of the published template and compiles again.
  ...(
    [
      [
        'codex_bundle_invalid',
        'p-e-cbi-agent',
        'compile:codex-app-server',
        'published codex.home/config.toml deleted after publish (manifest still valid: it requires only codex.home)',
        (h: string, _rt: string) => {
          rmSync(join(h, 'config.toml'))
        },
      ],
      [
        'codex_config_toml_invalid',
        'p-e-cti-agent',
        'compile:codex-app-server',
        'published codex.home/config.toml replaced with invalid TOML after publish',
        (h: string, _rt: string) => {
          writeFileSync(join(h, 'config.toml'), 'model = [unterminated\n')
        },
      ],
      [
        'codex_hooks_json_invalid',
        'p-e-chj-agent',
        'compile:codex-app-server',
        'non-interactive: published codex.home/hooks.json replaced with invalid JSON, runtime home metadata removed',
        (h: string, rt: string) => {
          writeFileSync(join(h, 'hooks.json'), '{not json\n')
          rmSync(join(rt, '.asp-runtime.json'), { force: true })
        },
      ],
      [
        'codex_space_hooks_json',
        'p-e-csh-agent',
        'compile:codex-tui',
        'interactive (codex-tui): published codex.home/space-hooks.json is invalid JSON, runtime home metadata removed',
        (h: string, rt: string) => {
          writeFileSync(join(h, 'space-hooks.json'), '{not json\n')
          rmSync(join(rt, '.asp-runtime.json'), { force: true })
        },
      ],
    ] as const
  ).flatMap(([reason, name, from, condition, damage]) => {
    const homeOf = (c: Ctx) => join(c.dir, '..', `${reason}--prep`, 'asp-home')
    return [
      {
        reason: 'native',
        id: `${reason}--prep`,
        method: 'aspc.compileHarnessInvocation',
        condition: `prep for ${reason}: native ${from} compile publishes the bundle into a fresh per-case aspHome`,
        setup: (c: Ctx) => {
          rmSync(join(c.dir, 'asp-home'), { recursive: true, force: true })
          space(c, 'p-e-tmp')
          agent(c, name, ['p-e-tmp'])
        },
        params: (c: Ctx) => compileIn(c, name, join(c.dir, 'asp-home'), from),
      },
      {
        reason,
        id: reason,
        method: 'aspc.compileHarnessInvocation',
        condition,
        setup: (c: Ctx) => {
          const home = homeOf(c)
          damage(publishedCodexHome(home, name), runtimeHome(home, name))
        },
        params: (c: Ctx) => compileIn(c, name, homeOf(c), from),
      },
    ] satisfies ProbeCase[]
  }),

  // -- codex variants of the claude-side staging judgements -------------------------
  {
    reason: 'permissions_toml_shape',
    id: 'permissions_toml_shape--codex',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex-app-server: permissions.toml [read] paths holds a non-string (paths = [1])',
    setup: (c) => {
      space(c, 'p-e-ptc', '', { 'permissions.toml': '[read]\npaths = [1]\n' })
      agent(c, 'p-e-ptc-agent', ['p-e-ptc'])
    },
    params: (c) => c.compileFor('p-e-ptc-agent', 'compile:codex-app-server'),
  },
  {
    reason: 'toml_syntax',
    id: 'toml_syntax--codex-permissions',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex-app-server: permissions.toml of a composed dev space is not valid TOML',
    setup: (c) => {
      space(c, 'p-e-tsc', '', { 'permissions.toml': '[read\npaths = ["x"]\n' })
      agent(c, 'p-e-tsc-agent', ['p-e-tsc'])
    },
    params: (c) => c.compileFor('p-e-tsc-agent', 'compile:codex-app-server'),
  },
  {
    reason: 'toml_syntax',
    id: 'toml_syntax--codex-hooks',
    method: 'aspc.compileHarnessInvocation',
    condition: 'codex-app-server: hooks/hooks.toml of a composed dev space is not valid TOML',
    setup: (c) => {
      space(c, 'p-e-tsh', '', {
        'hooks/hooks.toml': '[[hook]\nevent = "stop"\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      agent(c, 'p-e-tsh-agent', ['p-e-tsh'])
    },
    params: (c) => c.compileFor('p-e-tsh-agent', 'compile:codex-app-server'),
  },
  {
    reason: 'hooks_toml_shape',
    id: 'hooks_toml_shape--codex',
    method: 'aspc.compileHarnessInvocation',
    condition:
      'codex-app-server: a codex pre_tool_use [[hook]] has a non-string tools element (tools = [1])',
    setup: (c) => {
      space(c, 'p-e-htc', '', {
        'hooks/hooks.toml':
          '[[hook]]\nevent = "pre_tool_use"\nscript = "a.sh"\nharness = "codex"\ntools = [1]\n',
        'hooks/a.sh': '#!/bin/sh\n',
      })
      agent(c, 'p-e-htc-agent', ['p-e-htc'])
    },
    params: (c) => c.compileFor('p-e-htc-agent', 'compile:codex-app-server'),
  },
]
export default cases
